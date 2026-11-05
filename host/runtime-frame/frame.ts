// Runs in the runtime frame (host/runtime-frame/index.html, built to
// <site>/host/runtime/): starts the runtime worker from a blob, so the worker
// inherits this page's CSP (a worker started from a URL would take its CSP from
// HTTP headers, which static hosts often can't set). The channel names come
// from the URL fragment, set by host/src/runtime-host.ts.
export {}; // a module for type checking; esbuild emits a self-contained classic script

const params = new URLSearchParams(location.hash.slice(1));
const channel = params.get("channel");
if (channel) {
  const script = new URL("worker.js", location.href).href;
  const blob = new Blob([`importScripts(${JSON.stringify(script)});`], { type: "text/javascript" });
  const worker = new Worker(URL.createObjectURL(blob), { name: "vm-runtime" });
  // The VM folder sits at the site root, next to host/ (tools/build.mjs lays the site out).
  const assets = new URL("../../vm/", location.href).href;
  worker.postMessage({ channel, gate: params.get("gate") ?? undefined, assets });
  // From the host page only: a MessagePort for a preview of one guest port.
  addEventListener("message", (e: MessageEvent<{ preview?: number }>) => {
    if (e.source !== parent || e.origin !== location.origin || typeof e.data?.preview !== "number" || !e.ports[0]) return;
    worker.postMessage({ preview: e.data.preview }, [e.ports[0]]);
  });
}
