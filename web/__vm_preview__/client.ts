// Injected into every HTML page a preview serves (by sw.ts), before the page's
// own scripts:
//   - keeps the service worker connected to the VM (it asks for a new
//     connection after the browser stopped and restarted it);
//   - replaces WebSocket for this origin with one that runs the WebSocket
//     protocol over a TCP connection into the VM, since a service worker can't
//     intercept WebSockets. That is what dev servers' hot reload uses.
import { connect, portEndpoint, type Client } from "../../runtime/src/rpc.ts";
import type { PreviewGateway } from "../../runtime/src/preview.ts";
import { givePortToWorker, requestPort } from "./port.ts";

// ---- the service worker's connection ---------------------------------------------

navigator.serviceWorker?.addEventListener("message", async (e) => {
  if (e.data?.vmPreview !== "need-port" || !navigator.serviceWorker.controller) return;
  try { await givePortToWorker(navigator.serviceWorker.controller, await requestPort()); } catch {}
});
// Messages keep the worker from being stopped while the page is open.
setInterval(() => navigator.serviceWorker?.controller?.postMessage({ vmPreview: "ping" }), 20_000);

// ---- WebSocket over the VM --------------------------------------------------------

let gatewayP: Promise<Client<PreviewGateway>> | undefined;
const sockets = new Map<string, TunnelSocket>();
function gateway() {
  return gatewayP ??= requestPort().then((port) => {
    const gw = connect<PreviewGateway>(portEndpoint(port));
    gw.on("socket-data", ({ id, data }: { id: string; data: Uint8Array }) => sockets.get(id)?._receive(data));
    gw.on("socket-close", ({ id }: { id: string }) => sockets.get(id)?._closed(1006, "", false));
    return gw;
  });
}

const enc = new TextEncoder(), dec = new TextDecoder();
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

/** A WebSocket client (RFC 6455) whose transport is a raw TCP connection into the VM. */
class TunnelSocket extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readyState = 0;
  protocol = "";
  extensions = "";
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  private id?: string;
  private gw?: Client<PreviewGateway>;
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private handshaken = false;
  private fragments: Uint8Array[] = [];
  private fragmentOp = 0;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(url: URL, protocols?: string | string[]) {
    super();
    this.url = url.href;
    const wanted = typeof protocols === "string" ? [protocols] : protocols ?? [];
    this._start(url, wanted).catch(() => this._closed(1006, "", false, true));
  }

  private async _start(url: URL, protocols: string[]) {
    this.gw = await gateway();
    this.id = await this.gw.api.socketOpen();
    sockets.set(this.id, this);
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const head = [`GET ${url.pathname}${url.search} HTTP/1.1`, "Host: localhost", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols.join(", ")}`] : [])];
    this.gw.api.socketWrite(this.id, enc.encode(head.join("\r\n") + "\r\n\r\n"));
  }

  private _fire(type: string, init?: MessageEventInit | CloseEventInit) {
    const ev = type === "message" ? new MessageEvent("message", init as MessageEventInit) : type === "close" ? new CloseEvent("close", init as CloseEventInit) : new Event(type);
    this.dispatchEvent(ev);
    const handler = (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`];
    try { handler?.call(this, ev); } catch (err) { setTimeout(() => { throw err; }); }
  }

  /** Bytes from the server. */
  _receive(data: Uint8Array) {
    this.buf = concat(this.buf, data);
    if (!this.handshaken) {
      const end = dec.decode(this.buf).indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = dec.decode(this.buf.subarray(0, end));
      this.buf = this.buf.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) return this._closed(1006, "", false, true);
      this.protocol = head.match(/^sec-websocket-protocol:\s*(.+)$/im)?.[1].trim() ?? "";
      this.handshaken = true;
      this.readyState = 1;
      this._fire("open");
    }
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = (b[2] << 8) | b[3]; off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(new DataView(b.buffer, b.byteOffset + 2, 8).getBigUint64(0)); off = 10; }
      const maskAt = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = b.slice(off, off + len);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskAt + (i & 3)];
      this.buf = b.subarray(off + len);
      this._frame(fin, op, payload);
    }
  }

  private _frame(fin: boolean, op: number, payload: Uint8Array) {
    if (op === 0x9) return this._send(0xa, payload); // ping → pong
    if (op === 0xa) return;
    if (op === 0x8) {
      const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
      if (this.readyState === 1) this._send(0x8, payload.subarray(0, 2));
      return this._closed(code, dec.decode(payload.subarray(2)), true);
    }
    if (op !== 0) { this.fragmentOp = op; this.fragments = []; }
    this.fragments.push(payload);
    if (!fin) return;
    const whole = this.fragments.reduce((a, p) => concat(a, p), new Uint8Array(0)) as Uint8Array<ArrayBuffer>;
    this.fragments = [];
    const data = this.fragmentOp === 0x1 ? dec.decode(whole) : this.binaryType === "arraybuffer" ? whole.buffer : new Blob([whole]);
    this._fire("message", { data, origin: location.origin });
  }

  private _send(op: number, payload: Uint8Array) {
    if (!this.gw || !this.id) return;
    const len = payload.length;
    const head = len < 126 ? [0x80 | op, 0x80 | len] : len < 65536 ? [0x80 | op, 0x80 | 126, len >> 8, len & 255] : [0x80 | op, 0x80 | 127, 0, 0, 0, 0, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const frame = new Uint8Array(head.length + 4 + len);
    frame.set(head);
    frame.set(mask, head.length);
    for (let i = 0; i < len; i++) frame[head.length + 4 + i] = payload[i] ^ mask[i & 3];
    this.gw.api.socketWrite(this.id, frame);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
    if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    if (this.readyState !== 1) return;
    // Blobs are read asynchronously; the chain keeps messages in order.
    this.sendChain = this.sendChain.then(async () => {
      if (typeof data === "string") return this._send(0x1, enc.encode(data));
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      this._send(0x2, bytes);
    });
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const r = enc.encode(reason);
    const payload = new Uint8Array(2 + r.length);
    payload[0] = code >> 8; payload[1] = code & 255; payload.set(r, 2);
    this._send(0x8, payload);
    setTimeout(() => this._closed(code, reason, true), 1000);
  }

  _closed(code: number, reason: string, wasClean: boolean, error = false) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.id) { sockets.delete(this.id); this.gw?.api.socketClose(this.id); }
    if (error) this._fire("error");
    this._fire("close", { code, reason, wasClean });
  }
}

const NativeWebSocket = window.WebSocket;
window.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, args: [string | URL, (string | string[])?]) {
    const url = new URL(args[0], location.href);
    // This origin's WebSockets go to the server in the VM; others stay native (and the CSP refuses them).
    if (url.host === location.host) return new TunnelSocket(url, args[1]) as unknown as WebSocket;
    return Reflect.construct(target, args);
  },
});
