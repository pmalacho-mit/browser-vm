// Host-page side of the network gate. Embeds the gate (its own origin, hidden
// iframe) and relays between it and the VM's extension-host worker:
//
//   extension host worker ──BroadcastChannel (name unique to this tab)──► this page
//   this page ──MessagePort──► gate iframe (gate.<host>) ──fetch()──► the internet
//
// This page never sees a secret value: requests go out with placeholders and
// responses come back scrubbed.
(() => {
  const pageBase = new URL(".", location.href);
  // Locally: http://gate.localhost:<port> serves these same files. Elsewhere,
  // window.GATE_URL names the gate (e.g. "https://gate.example.com/"): set by
  // site.js when the site was built with GATE_URL/IDE_URL (scripts/build-site.mjs).
  const gateBase = window.GATE_URL
    ? new URL(window.GATE_URL)
    : location.hostname === "localhost"
      ? new URL(`${location.protocol}//gate.localhost${location.port ? ":" + location.port : ""}${pageBase.pathname}`)
      : null;
  const name = `vm-gate-${crypto.randomUUID()}`;
  window.__vmGateChannel = name;
  const ch = new BroadcastChannel(name);
  if (!gateBase) {
    console.warn("[gate] no GATE_URL configured: the VM has no network");
    ch.onmessage = (e) => e.data?.msg?.id && ch.postMessage({ id: e.data.msg.id, error: { code: "no-gate", message: "this deployment has no network gate configured" } });
    return;
  }

  const gateUrl = new URL("gate/index.html", gateBase);
  const iframe = document.createElement("iframe");
  iframe.src = gateUrl.href;
  iframe.title = "VM network gate";
  iframe.style.cssText = "position:fixed;right:16px;bottom:36px;width:380px;height:170px;border:0;z-index:100000;display:none;color-scheme:normal;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35)";
  let port = null, ready = false, secrets = [];
  const queue = [];

  const toGate = (m) => {
    if (!ready) return queue.push(m);
    port.postMessage(m, m.body ? [m.body.buffer] : []);
  };

  iframe.addEventListener("load", () => {
    const mc = new MessageChannel();
    port = mc.port1;
    port.onmessage = (e) => {
      const m = e.data;
      if (m.ready) { ready = true; queue.splice(0).forEach(toGate); ch.postMessage({ hello: "gate" }); return; }
      if (m.secrets) { secrets = m.secrets; ch.postMessage({ secrets }); return; }
      ch.postMessage(m); // head / chunk / end / error for a request
    };
    iframe.contentWindow.postMessage({ gateInit: true }, gateUrl.origin, [mc.port2]);
  });
  addEventListener("message", (e) => {
    if (e.origin === gateUrl.origin && e.source === iframe.contentWindow && e.data?.gateUI === "hide") iframe.style.display = "none";
  });

  ch.onmessage = (e) => {
    const m = e.data;
    if (m.ping) { if (ready) { ch.postMessage({ hello: "gate" }); ch.postMessage({ secrets }); } return; }
    if (m.ui === "show") { iframe.style.display = "block"; toGate({ ui: "show", text: m.text }); return; }
    if (m.msg) toGate(m.msg);
  };

  (document.body ? Promise.resolve() : new Promise((r) => addEventListener("DOMContentLoaded", r))).then(() => document.body.append(iframe));
})();
