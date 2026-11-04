// The VM's fetch(), as seen from the extension host: every request goes to the
// network gate (web/gate/), which runs on its own origin, holds the secrets and
// applies the network policy. This worker has no network of its own: the
// build locks the extension host's CSP to connect-src 'self'.
//
//   this worker ──BroadcastChannel──► host page (web/gate-relay.js) ──MessagePort──► gate iframe

const GUEST_HINT = "Open the gate settings with the VS Code command 'Linux VM: Manage Secrets & Network Access'.";

export class GateClient {
  /** @param {{ channelName: string, onSecrets?: (list: {name: string, env: string}[]) => void,
   *             onNotice?: (n: { kind: string, host: string, names?: string[] }) => void }} o */
  constructor({ channelName, onSecrets, onNotice }) {
    this.ch = new BroadcastChannel(channelName);
    this.reqs = new Map();
    this.nextId = 1;
    this.onSecrets = onSecrets;
    this.onNotice = onNotice;
    this.ready = new Promise((res) => (this._ready = res));
    this.ch.onmessage = (e) => this._onMessage(e.data);
    this.ch.postMessage({ ping: true });
  }

  /** Ask the host page to show the gate's card (the user clicks through to its settings). */
  showUI(text) { this.ch.postMessage({ ui: "show", text }); }

  _onMessage(m) {
    if (m.hello) return this._ready();
    if (m.secrets) return this.onSecrets?.(m.secrets);
    if (m.notice) return this.onNotice?.(m.notice);
    const r = this.reqs.get(m.id);
    if (!r) return;
    if (m.error) {
      this.reqs.delete(m.id);
      const err = Object.assign(new Error(`gate: ${m.error.code}: ${m.error.message}`), { code: m.error.code });
      if (m.error.code !== "network") {
        err.guestMessage = `Refused by the VM's network gate: ${m.error.message}\n` +
          (["denied", "locked", "quota"].includes(m.error.code) ? GUEST_HINT + "\n" : "") +
          (m.error.code === "bridge-not-approved" ? "Approve the site in the Browser VM Network Bridge extension (toolbar icon).\n" : "");
      }
      r.controller ? r.controller.error(err) : r.reject(err);
    } else if (m.head) {
      const body = new ReadableStream({ start: (c) => (r.controller = c) });
      const resp = new Response(body, { status: m.head.status, statusText: m.head.statusText, headers: m.head.headers });
      Object.defineProperty(resp, "url", { value: m.head.url });
      Object.defineProperty(resp, "redirected", { value: m.head.redirected });
      r.resolve(resp);
    } else if (m.chunk) {
      r.controller?.enqueue(m.chunk);
    } else if (m.end) {
      this.reqs.delete(m.id);
      r.controller?.close();
    }
  }

  async fetch(url, init = {}) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("the network gate did not load"), {
      guestMessage: "The VM's network gate did not load, so the VM has no network.\n" })), 15000));
    await Promise.race([this.ready, timeout]);
    const id = `${Date.now().toString(36)}-${this.nextId++}`;
    let body;
    if (init.body) body = new Uint8Array(init.body).slice();
    const p = new Promise((resolve, reject) => this.reqs.set(id, { resolve, reject }));
    const headers = Array.isArray(init.headers) ? init.headers : [...new Headers(init.headers)];
    this.ch.postMessage({ msg: { id, url, method: init.method || "GET", headers, body } });
    return p;
  }
}
