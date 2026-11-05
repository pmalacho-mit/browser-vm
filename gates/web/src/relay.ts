// The web gate's page side (built to <site>/host/gate-relay.js; a page that
// hosts a VM includes it before host/runtime-host.js). Embeds the gate app (its
// own origin, hidden iframe) and relays between it and the runtime worker:
//
//   runtime worker (client.ts) ──BroadcastChannel (name unique to this tab)──► this page
//   this page ──MessagePort──► gate iframe (gate.<host>) ──fetch()──► the internet
//
// This page never sees a secret value: requests go out with placeholders and
// responses come back scrubbed.
import type { FromGate, ToGate, ToRelay } from "./protocol.ts";

(() => {
  // An app built with gate: "none" has no gate, and so no network: no channel,
  // and the runtime gets no gate (host/src/runtime-host.ts).
  if (globalThis.SITE_CONFIG?.gate === false) return;
  // Where the gate app is: the root of the gate's origin (dist/<app>/gate/).
  // Deployed: GATE_URL at build time (site.js). Locally: http://gate.localhost:<port>/,
  // which tools/serve.mjs answers from the same port.
  const configured = globalThis.SITE_CONFIG?.gateUrl ?? window.GATE_URL;
  const gateUrl = configured
    ? new URL(configured)
    : location.hostname === "localhost"
      ? new URL(`${location.protocol}//gate.localhost${location.port ? ":" + location.port : ""}/`)
      : null;
  const name = `vm-gate-${crypto.randomUUID()}`;
  window.__vmGateChannel = name;
  const ch = new BroadcastChannel(name);
  const toWorker = (m: FromGate) => ch.postMessage(m);
  if (!gateUrl) {
    console.warn("[gate] no GATE_URL configured: the VM has no network");
    ch.onmessage = (e: MessageEvent<ToRelay>) => e.data?.msg?.id && toWorker({ id: e.data.msg.id, error: { code: "no-gate", message: "this deployment has no network gate configured" } });
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.src = gateUrl.href;
  iframe.title = "VM network gate";
  iframe.style.cssText = "position:fixed;right:16px;bottom:36px;width:380px;height:170px;border:0;z-index:100000;display:none;color-scheme:normal;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35)";
  let port: MessagePort | null = null, ready = false, secrets: FromGate["secrets"] = [];
  const queue: ToGate[] = [];

  const toGate = (m: ToGate) => {
    if (!ready || !port) return queue.push(m);
    port.postMessage(m, "body" in m && m.body ? [m.body.buffer] : []);
  };

  iframe.addEventListener("load", () => {
    const mc = new MessageChannel();
    port = mc.port1;
    port.onmessage = (e: MessageEvent<FromGate>) => {
      const m = e.data;
      if (m.ready) { ready = true; queue.splice(0).forEach(toGate); toWorker({ hello: "gate" }); return; }
      if (m.secrets) { secrets = m.secrets; toWorker({ secrets }); return; }
      toWorker(m); // head / chunk / end / error for a request
    };
    iframe.contentWindow?.postMessage({ gateInit: true }, gateUrl.origin, [mc.port2]);
  });
  addEventListener("message", (e) => {
    if (e.origin === gateUrl.origin && e.source === iframe.contentWindow && e.data?.gateUI === "hide") iframe.style.display = "none";
  });

  ch.onmessage = (e: MessageEvent<ToRelay>) => {
    const m = e.data;
    if (m.ping) { if (ready) { toWorker({ hello: "gate" }); toWorker({ secrets }); } return; }
    if (m.ui === "show") { iframe.style.display = "block"; toGate({ ui: "show", text: m.text }); return; }
    if (m.msg) toGate(m.msg);
  };

  (document.body ? Promise.resolve() : new Promise((r) => addEventListener("DOMContentLoaded", r))).then(() => document.body.append(iframe));
})();
