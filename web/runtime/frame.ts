// Runs in web/runtime/index.html: starts the runtime worker from a blob, so the
// worker inherits this page's CSP (a worker started from a URL would take its
// CSP from HTTP headers, which static hosts often can't set). The channel name
// comes from the URL fragment, set by web/runtime-host.ts.
export {}; // a module for type checking; esbuild emits a self-contained classic script

const channel = new URLSearchParams(location.hash.slice(1)).get("channel");
if (channel) {
  const script = new URL("worker.js", location.href).href;
  const blob = new Blob([`importScripts(${JSON.stringify(script)});`], { type: "text/javascript" });
  const worker = new Worker(URL.createObjectURL(blob), { name: "vm-runtime" });
  worker.postMessage({ channel });
}
