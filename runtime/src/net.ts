// Guest networking without a server: HTTP and HTTPS from inside the VM are
// replayed with the browser's own fetch().
//
//   guest: curl https://registry.npmjs.org/left-pad
//     │  DNS: v86's fake DNS answers every name with one fake IP
//     │  TCP: v86's fake TCP stack ends the connection here, in JavaScript
//     ▼
//   port 443 → tls.wasm (Go crypto/tls compiled to WASM) completes the
//              handshake with a cert for the SNI hostname, signed by a CA
//              made in this tab and trusted only by the guest
//   port 80  → plain bytes
//     ▼
//   HttpSession: parse the HTTP/1.1 request → fetch(url) → stream the
//                response back as HTTP/1.1 (chunked, keep-alive)
//
// The limits are the browser's, not ours: the target must allow cross-origin
// requests (CORS), cookies are never sent, and only HTTP(S) is possible.
import type { V86, V86Filesystem } from "v86";
import { makeGo } from "../../vendor/go/wasm_exec.mjs";

// ---------------------------------------------------------------------------
// tls.wasm loader

/** What tls.wasm exports (see tls/main.go). */
export interface TlsTerminator {
  /** This tab's CA certificate, to be trusted by the guest. */
  caPEM: string;
  accept(callbacks: TlsCallbacks): TlsSession;
}

/** Called by tls.wasm for one TLS session. */
export interface TlsCallbacks {
  /** Ciphertext to send to the guest. */
  cipher(b: Uint8Array): void;
  /** Handshake finished; the hostname the guest asked for (SNI). */
  hello(serverName: string): void;
  /** Decrypted bytes from the guest. */
  plain(b: Uint8Array): void;
  /** Guest side finished ("" = clean EOF). */
  end(err: string): void;
  /** Our close_notify is out; close the TCP connection. */
  closed(): void;
}

export interface TlsSession {
  /** Ciphertext from the guest. */
  push(b: Uint8Array): void;
  /** Plaintext to encrypt and send to the guest. */
  write(b: Uint8Array): void;
  close(): void;
  abort(): void;
}

/** A request as HttpSession hands it to `fetch`: headers as pairs, body as bytes. */
export interface GuestRequestInit {
  method: string;
  headers: [string, string][];
  /** Backed by a plain ArrayBuffer, as fetch() requires. */
  body?: Uint8Array<ArrayBuffer>;
  credentials?: RequestCredentials;
  redirect?: RequestRedirect;
}

export type FetchLike = (url: string, init: GuestRequestInit) => Promise<Response>;

/** An error that carries text to show inside the VM (as the 502 response body). */
export type GuestError = Error & { guestMessage?: string; code?: string };

/** Loads the TLS terminator. */
export async function loadTLS(wasmUrl: string, fetchImpl: (url: string) => Promise<Response> = fetch): Promise<TlsTerminator> {
  // Run Go's runtime against a private global object (see vendor/go/wasm_exec.mjs).
  const local: Record<string | symbol, any> = {};
  const g = new Proxy(globalThis, {
    get: (t, k) => (k in local ? local[k] : Reflect.get(t, k)),
    set: (_t, k, v) => ((local[k] = v), true),
    has: (t, k) => k in local || k in t,
  });
  const Go = makeGo(g);
  const go = new Go();
  const bytes = await (await fetchImpl(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  const ready = new Promise((res) => (local.__vmTLSReady = res));
  go.run(instance);
  await ready;
  return local.__vmTLS;
}

// ---------------------------------------------------------------------------
// HTTP/1.1 over one guest connection

const enc = new TextEncoder(), dec = new TextDecoder();
const concat = (a: Uint8Array, b: Uint8Array) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
const indexOfCRLFCRLF = (b: Uint8Array, from = 0) => {
  for (let i = from; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
};
const indexOfCRLF = (b: Uint8Array, from = 0) => {
  for (let i = from; i + 1 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10) return i;
  return -1;
};

const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

const REASONS: Record<number, string> = { 421: "Misdirected Request", 200: "OK", 201: "Created", 204: "No Content", 206: "Partial Content", 301: "Moved Permanently", 302: "Found",
  304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway" };

interface HttpSessionOptions {
  scheme: "http" | "https";
  /** Over TLS: the SNI hostname, the only destination this connection may reach. */
  serverName?: string;
  write: (b: Uint8Array) => void;
  close: () => void;
  fetch: FetchLike;
  log: (s: string) => void;
}

interface HttpRequest {
  method: string;
  target: string;
  version: string;
  headers: [string, string][];
  get: (name: string) => string | undefined;
  body: Uint8Array<ArrayBuffer> | null;
  close: boolean;
}

export class HttpSession {
  o: HttpSessionOptions;
  buf = new Uint8Array(0);
  busy = false;     // one request at a time (pipelined requests wait in buf)
  peerDone = false; // guest sent FIN
  sentContinue = false;

  constructor(o: HttpSessionOptions) {
    this.o = o;
  }

  feed(bytes: Uint8Array) {
    this.buf = concat(this.buf, bytes);
    this._next();
  }

  shutdown() {
    this.peerDone = true;
    if (!this.busy) this.o.close();
  }

  _next() {
    if (this.busy) return;
    const req = this._parse();
    if (!req) { if (this.peerDone) this.o.close(); return; }
    this.busy = true;
    this._dispatch(req).catch((e) => this.o.log(`[net] internal error: ${e.stack || e}`)).finally(() => {
      this.busy = false;
      if (req.close) this.o.close(); else this._next();
    });
  }

  /** Returns a complete request from the buffer (and consumes it), or null if more bytes are needed. */
  _parse(): HttpRequest | null {
    const end = indexOfCRLFCRLF(this.buf);
    if (end < 0) return null;
    const lines = dec.decode(this.buf.subarray(0, end)).split("\r\n");
    const [method, target, version = "HTTP/1.0"] = lines[0].split(" ");
    const headers: [string, string][] = [];
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    }
    const get = (k: string) => headers.find(([n]) => n === k)?.[1];
    let pos = end + 4, body: Uint8Array<ArrayBuffer> | null = null;

    if (/chunked/i.test(get("transfer-encoding") || "")) {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (;;) {
        const nl = indexOfCRLF(this.buf, pos);
        if (nl < 0) return this._maybeContinue(get);
        const size = parseInt(dec.decode(this.buf.subarray(pos, nl)), 16);
        if (size === 0) {
          const trailerEnd = indexOfCRLFCRLF(this.buf, nl - 2);
          if (trailerEnd < 0) return null;
          pos = trailerEnd + 4;
          break;
        }
        if (this.buf.length < nl + 2 + size + 2) return this._maybeContinue(get);
        parts.push(this.buf.slice(nl + 2, nl + 2 + size));
        pos = nl + 2 + size + 2;
      }
      body = parts.reduce(concat, new Uint8Array(0));
    } else {
      const len = parseInt(get("content-length") || "0", 10);
      if (this.buf.length < pos + len) return this._maybeContinue(get);
      if (len) body = this.buf.slice(pos, pos + len);
      pos += len;
    }
    this.buf = this.buf.slice(pos);
    const connHdr = (get("connection") || "").toLowerCase();
    const close = version === "HTTP/1.0" ? connHdr !== "keep-alive" : connHdr === "close";
    return { method, target, version, headers, get, body, close };
  }

  _maybeContinue(get: HttpRequest["get"]): null {
    if (!this.sentContinue && /100-continue/i.test(get("expect") || "")) {
      this.sentContinue = true;
      this.o.write(enc.encode("HTTP/1.1 100 Continue\r\n\r\n"));
    }
    return null;
  }

  async _dispatch(req: HttpRequest) {
    this.sentContinue = false;
    const t0 = Date.now();
    let url: URL;
    try {
      url = /^https?:\/\//i.test(req.target)
        ? new URL(req.target)
        : new URL(`${this.o.scheme}://${req.get("host") || this.o.serverName}${req.target}`);
    } catch {
      return this._respondText(req, 400, `Bad request target: ${req.target}\n`);
    }
    // Over TLS, the hostname the guest verified a certificate for (SNI) is the
    // only destination this connection may reach. Host header and absolute URLs
    // must agree with it, or one connection could be steered somewhere else.
    if (this.o.serverName && url.hostname.toLowerCase() !== this.o.serverName.toLowerCase()) {
      return this._respondText(req, 421, `Misdirected request: this connection is for ${this.o.serverName}, not ${url.hostname}\n`);
    }
    // An https page can't fetch http:// (mixed content), so upgrade. (No `location` in Node tests.)
    const pageProtocol = (globalThis as { location?: { protocol?: string } }).location?.protocol;
    if (url.protocol === "http:" && pageProtocol === "https:") url.protocol = "https:";

    if (req.method === "CONNECT") return this._respondText(req, 405, "This network has no proxy; connect directly.\n");

    // All request headers go on; the gate decides what is forwarded (web/gate/core.ts).
    const headers = req.headers.filter(([k]) => k !== "host");
    const target = url.href;

    let resp: Response;
    try {
      resp = await this.o.fetch(target, {
        method: req.method,
        headers,
        body: req.body && !["GET", "HEAD"].includes(req.method) ? req.body : undefined,
        credentials: "omit", // never send the user's browser cookies for that site
        redirect: "follow",
      });
    } catch (e) {
      const err = e as GuestError;
      if (err.guestMessage) {
        this.o.log(`[net] ${req.method} ${url.href} → ${err.message}`);
        return this._respondText(req, 502, err.guestMessage);
      }
      this.o.log(`[net] ${req.method} ${url.href} → blocked (${err.message}) — the site probably doesn't allow browser (CORS) access`);
      return this._respondText(req, 502,
        `The browser refused this request: ${url.href}\n\n` +
        `This VM's network is the browser's fetch(), so it can only reach sites that allow\n` +
        `cross-origin requests (CORS). This one doesn't (or is unreachable).\n` +
        `(${err.message})\n`);
    }
    this.o.log(`[net] ${req.method} ${url.href} → ${resp.status}${resp.redirected ? ` (via redirect to ${resp.url})` : ""} ${Date.now() - t0} ms`);

    const noBody = req.method === "HEAD" || resp.status === 204 || resp.status === 304;
    const lines = [`HTTP/1.1 ${resp.status} ${resp.statusText || REASONS[resp.status] || ""}`];
    for (const [k, v] of resp.headers) if (!DROP_RESPONSE.has(k)) lines.push(`${k}: ${v}`);
    if (!noBody) lines.push("transfer-encoding: chunked");
    lines.push(`connection: ${req.close ? "close" : "keep-alive"}`);
    this.o.write(enc.encode(lines.join("\r\n") + "\r\n\r\n"));
    if (noBody) { try { await resp.body?.cancel(); } catch {} return; }

    const reader = resp.body?.getReader();
    try {
      for (;;) {
        const { value, done } = reader ? await reader.read() : { value: undefined, done: true };
        if (done) break;
        if (value?.length) {
          this.o.write(enc.encode(value.length.toString(16) + "\r\n"));
          this.o.write(value);
          this.o.write(enc.encode("\r\n"));
        }
      }
      this.o.write(enc.encode("0\r\n\r\n"));
    } catch (e) {
      this.o.log(`[net] ${url.href}: response aborted (${(e as Error).message})`);
      req.close = true; // body is truncated; the only honest signal left is closing
    }
  }

  _respondText(req: HttpRequest, status: number, text: string) {
    const body = enc.encode(text);
    this.o.write(enc.encode(
      `HTTP/1.1 ${status} ${REASONS[status] || ""}\r\ncontent-type: text/plain; charset=utf-8\r\n` +
      `content-length: ${body.length}\r\nconnection: ${req.close ? "close" : "keep-alive"}\r\n\r\n`));
    this.o.write(body);
  }
}

// ---------------------------------------------------------------------------
// Wiring into v86

/**
 * Takes over guest TCP connections to ports 80 and 443.
 * Requires the emulator to be created with net_device: { type: "virtio", relay_url: "fetch" }:
 * that gives us v86's fake DHCP/DNS/ARP/TCP stack; this replaces its HTTP handling.
 */
export function attachFetchNetwork(emulator: V86, { tls, log, fetchImpl = (url, init) => fetch(url, init) }: {
  tls: TlsTerminator | null;
  log: (s: string) => void;
  fetchImpl?: FetchLike;
}) {
  let nextId = 0;
  emulator.bus.register("tcp-connection", (conn) => {
    const id = ++nextId;
    if (conn.sport === 80) {
      // v86's own fetch adapter already accepted this one (it registered first); we
      // replace its data handler with ours (keep-alive, chunked bodies, logging).
      const http = new HttpSession({
        scheme: "http", fetch: fetchImpl, log,
        write: (b) => conn.write(b),
        close: () => conn.close(),
      });
      conn.on("data", (d) => http.feed(d.slice())); // slice: d points into the NIC buffer
      conn.on("shutdown", () => http.shutdown());
    } else if (conn.sport === 443 && tls) {
      conn.accept();
      let http: HttpSession | undefined, dead = false;
      const session = tls.accept({
        cipher: (b) => { if (!dead) conn.write(b); },
        hello: (serverName) => {
          http = new HttpSession({
            scheme: "https", serverName, fetch: fetchImpl, log,
            write: (b) => session.write(b),
            close: () => session.close(), // sends TLS close_notify, then "closed" below
          });
        },
        plain: (b) => http?.feed(b),
        closed: () => conn.close(),
        end: (err) => {
          if (err) log(`[net] tls #${id}: ${err}`);
          if (http && !err) http.shutdown(); else conn.close();
        },
      });
      conn.on("data", (d) => session.push(d.slice()));
      conn.on("shutdown", () => session.abort()); // guest FIN → EOF for the TLS reader
      conn.on("close", () => { dead = true; session.abort(); }); // guest RST
    }
    // Other ports: not accepted → the guest gets a TCP reset ("connection refused").
  });
}

/** Writes a file into the guest's root filesystem (before or after boot). */
export async function writeGuestFile(fs9p: V86Filesystem, path: string, bytes: Uint8Array) {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const parent = fs9p.SearchPath(dir);
  if (parent.id === -1) throw new Error(`no such directory in guest: ${dir}`);
  let id = fs9p.SearchPath(path).id;
  if (id === -1) id = fs9p.CreateFile(name, parent.id);
  await fs9p.ChangeSize(id, bytes.length);
  await fs9p.Write(id, 0, bytes.length, bytes);
}
