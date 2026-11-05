// The way into a server running in the guest, for previews (web/__vm_preview__/).
// Each gateway serves one guest port: HTTP requests (one TCP connection each,
// "Connection: close") and raw TCP sockets (for WebSockets, which the preview
// page speaks itself). Connections start at v86's fake router (192.168.86.1),
// so servers must listen on 0.0.0.0, not only on 127.0.0.1.
//
// It is served to the preview origin over a MessagePort of its own, never the
// runtime's full API: a previewed app can reach its own server and nothing else.
import type { V86TcpConnection } from "v86";
import type { LinuxVM } from "./vm.ts";

export interface PreviewRequest {
  method: string;
  /** Path and query, e.g. "/src/main.js?t=1". */
  path: string;
  headers: [string, string][];
  body?: Uint8Array;
}

export interface PreviewResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
}

/** Request headers the gateway sets itself, or that would make the response harder to handle. */
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "content-length", "accept-encoding", "if-none-match", "if-modified-since", "cookie", "origin", "referer"]);
/** Response headers that describe the connection, not the content. */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "set-cookie"]);

const enc = new TextEncoder(), dec = new TextDecoder();
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const indexOf = (hay: Uint8Array, needle: number[], from = 0) => {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
const CRLF = [13, 10], CRLFCRLF = [13, 10, 13, 10];

/** Decodes a chunked body (what's there of it). */
function dechunk(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < b.length;) {
    const eol = indexOf(b, CRLF, i);
    if (eol < 0) break;
    const size = parseInt(dec.decode(b.subarray(i, eol)).split(";")[0].trim(), 16);
    if (!(size > 0)) break;
    parts.push(b.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return concat(parts);
}

/** Parses one HTTP/1.x response that ended with the connection. */
export function parseResponse(raw: Uint8Array): PreviewResponse {
  let start = 0;
  for (;;) {
    const end = indexOf(raw, CRLFCRLF, start);
    if (end < 0) throw new Error("the server closed the connection without a complete response");
    const [statusLine, ...lines] = dec.decode(raw.subarray(start, end)).split("\r\n");
    const m = statusLine.match(/^HTTP\/1\.[01] (\d{3}) ?(.*)$/);
    if (!m) throw new Error(`not an HTTP response: ${JSON.stringify(statusLine.slice(0, 60))}`);
    const status = Number(m[1]);
    const headers = lines.map((l): [string, string] => { const i = l.indexOf(":"); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; });
    const bodyStart = end + 4;
    if (status >= 100 && status < 200 && status !== 101) { start = bodyStart; continue; } // 100 Continue and friends
    const get = (k: string) => headers.find(([h]) => h === k)?.[1];
    let body = raw.subarray(bodyStart);
    if (/chunked/i.test(get("transfer-encoding") ?? "")) body = dechunk(body);
    else if (get("content-length") !== undefined) body = body.subarray(0, Number(get("content-length")));
    return { status, statusText: m[2], headers: headers.filter(([h]) => !DROP_RESPONSE.has(h)), body: body.slice() };
  }
}

export class PreviewGateway {
  /** Set by serve(): "socket-data" { id, data } and "socket-close" { id }. */
  emit: (topic: string, data: unknown) => void = () => {};
  private vm: LinuxVM;
  private port: number;
  private sockets = new Map<string, V86TcpConnection>();
  private nextSocket = 1;

  constructor(vm: LinuxVM, port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port: ${port}`);
    this.vm = vm;
    this.port = port;
  }

  /** Opens a TCP connection to the guest's port; fails if nothing listens there. */
  private _open(): Promise<V86TcpConnection> {
    const net = this.vm.emulator?.network_adapter;
    if (!net) return Promise.reject(Object.assign(new Error("the VM has no network adapter (is linuxVm.network off?)"), { code: "NoNetwork" }));
    return new Promise((resolve, reject) => {
      const c = net.connect(this.port);
      const fail = (why: string) => { clearTimeout(timer); reject(Object.assign(new Error(why), { code: "Refused" })); };
      const timer = setTimeout(() => { fail(`nothing answered on port ${this.port}`); c.close(); }, 15_000);
      c.on("connect", () => { clearTimeout(timer); resolve(c); });
      c.on("close", () => fail(`nothing is listening on port ${this.port} in the VM`));
    });
  }

  /** One HTTP request to the guest's server. */
  async http(req: PreviewRequest): Promise<PreviewResponse> {
    const c = await this._open();
    const chunks: Uint8Array[] = [];
    const ended = new Promise<void>((res) => {
      c.on("data", (d) => chunks.push(d.slice())); // slice: d points into the NIC's buffer
      c.on("shutdown", () => res());
      c.on("close", () => res());
    });
    const body = req.body?.length ? req.body : undefined;
    // "localhost": dev servers (Vite, webpack) refuse unknown Host headers.
    const head = [`${req.method} ${req.path} HTTP/1.1`, `Host: localhost:${this.port}`, "Connection: close", "Accept-Encoding: identity",
      ...req.headers.filter(([k]) => !DROP_REQUEST.has(k.toLowerCase())).map(([k, v]) => `${k}: ${v}`),
      ...(body ? [`Content-Length: ${body.length}`] : [])].join("\r\n") + "\r\n\r\n";
    c.write(enc.encode(head));
    if (body) c.write(body);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([ended.then(() => false), new Promise<boolean>((res) => (timer = setTimeout(() => res(true), 120_000)))]);
    clearTimeout(timer);
    c.close();
    if (timedOut && !chunks.length) throw Object.assign(new Error(`port ${this.port} didn't answer within 2 minutes`), { code: "Timeout" });
    return parseResponse(concat(chunks));
  }

  // ---- raw sockets (the preview page runs the WebSocket protocol over these) ----

  async socketOpen(): Promise<string> {
    const c = await this._open();
    const id = `s${this.nextSocket++}`;
    this.sockets.set(id, c);
    const closed = () => {
      if (!this.sockets.delete(id)) return;
      this.emit("socket-close", { id });
      c.close();
    };
    c.on("data", (d) => this.emit("socket-data", { id, data: d.slice() }));
    c.on("shutdown", closed);
    c.on("close", closed);
    return id;
  }

  socketWrite(id: string, data: Uint8Array) {
    this.sockets.get(id)?.write(data);
  }

  socketClose(id: string) {
    const c = this.sockets.get(id);
    if (!c) return;
    this.sockets.delete(id);
    c.close();
  }
}
