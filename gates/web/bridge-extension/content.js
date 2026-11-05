// Injected by Chrome only into the network gate's origin (manifest "matches").
// Relays window.postMessage <-> the background service worker.
// Messages from other frames or windows are ignored.
(() => {
  const TAG = "__vmNetBridge";
  let port = null;
  const ensurePort = () => {
    if (port) return port;
    port = chrome.runtime.connect({ name: "vm-net" });
    port.onMessage.addListener((msg) => window.postMessage({ [TAG]: "from-ext", msg }, location.origin));
    port.onDisconnect.addListener(() => { port = null; });
    return port;
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data[TAG] !== "to-ext") return;
    if (e.data.ping) return window.postMessage({ [TAG]: "hello", version: chrome.runtime.getManifest().version }, location.origin);
    ensurePort().postMessage(e.data.msg);
  });
  window.postMessage({ [TAG]: "hello", version: chrome.runtime.getManifest().version }, location.origin);
})();
