// The web gate as the runtime sees it: a Gate (runtime/src/gate.ts) whose every
// request goes to the gate app (app/gate.ts), which runs on its own origin,
// holds the secrets and applies the network policy. The runtime worker that
// uses it has no network of its own: the runtime frame's CSP is connect-src 'self'.
//
//   runtime worker (this) ──BroadcastChannel──► page (relay.ts) ──MessagePort──► gate iframe
import type { Gate, GateHooks, GuestError, GuestRequestInit } from "@browser-vm/runtime";
import type { FromGate, ToRelay } from "./protocol.ts";

const GUEST_HINT = "Open the gate settings with the VS Code command 'Linux VM: Manage Secrets & Network Access'.";

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  /** Set once the response head arrived; the body streams through it. */
  controller?: ReadableStreamDefaultController<Uint8Array>;
}

export class WebGateClient implements Gate {
  ch: BroadcastChannel;
  reqs = new Map<string, Pending>();
  nextId = 1;
  hooks?: GateHooks;
  ready: Promise<void>;
  _ready!: () => void;

  /** `channelName`: the page relay's BroadcastChannel (relay.ts sets window.__vmGateChannel). */
  constructor(channelName: string) {
    this.ch = new BroadcastChannel(channelName);
    this.ready = new Promise((res) => (this._ready = res));
    this.ch.onmessage = (e: MessageEvent<FromGate>) => this._onMessage(e.data);
    this.post({ ping: true }); // once the gate is up, the relay answers with hello
  }

  connect(hooks: GateHooks) {
    this.hooks = hooks;
    this.post({ ping: true }); // again, for the secret list (it may have come before the hooks)
  }

  post(m: ToRelay) { this.ch.postMessage(m); }

  /** Asks the page to show the gate's card (the user clicks through to its settings). */
  show(text: string) { this.post({ ui: "show", text }); }

  _onMessage(m: FromGate) {
    if (m.hello) return this._ready();
    if (m.secrets) return this.hooks?.secrets(m.secrets);
    if (m.notice) return this.hooks?.notice(m.notice);
    const r = m.id ? this.reqs.get(m.id) : undefined;
    if (!r || !m.id) return;
    if (m.error) {
      this.reqs.delete(m.id);
      const err: GuestError = Object.assign(new Error(`gate: ${m.error.code}: ${m.error.message}`), { code: m.error.code });
      if (m.error.code !== "network") {
        err.guestMessage = `Refused by the VM's network gate: ${m.error.message}\n` +
          (["denied", "locked", "quota"].includes(m.error.code) ? GUEST_HINT + "\n" : "") +
          (m.error.code === "bridge-not-approved" ? "Approve the site in the Browser VM Network Bridge extension (toolbar icon).\n" : "");
      }
      r.controller ? r.controller.error(err) : r.reject(err);
    } else if (m.head) {
      const body = new ReadableStream<Uint8Array>({ start: (c) => { r.controller = c; } });
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

  fetch = async (url: string, init: GuestRequestInit): Promise<Response> => {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("the network gate did not load"), {
      guestMessage: "The VM's network gate did not load, so the VM has no network.\n" })), 15000));
    await Promise.race([this.ready, timeout]);
    const id = `${Date.now().toString(36)}-${this.nextId++}`;
    const body = init.body ? new Uint8Array(init.body).slice() : undefined;
    const p = new Promise<Response>((resolve, reject) => this.reqs.set(id, { resolve, reject }));
    this.post({ msg: { id, url, method: init.method || "GET", headers: init.headers, body } });
    return p;
  };
}
