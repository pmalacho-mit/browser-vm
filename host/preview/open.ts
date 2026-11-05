// The preview opener (built to <site>/host/preview-open.js, loaded by
// preview-open.html): used when the app has a fixed list of preview origins
// (PREVIEW_ORIGINS) instead of one origin per port. A surface opens
// host/preview-open.html?port=5173; this page, on the app's own origin, asks the
// app's page (window.top) which preview origin that guest port has been given,
// then goes there.
export {}; // a module for type checking; esbuild emits a self-contained classic script

const status = document.getElementById("status")!;
const port = Number(new URLSearchParams(location.search).get("port"));
const nonce = crypto.randomUUID();

if (!(port >= 1 && port <= 65535)) status.textContent = "No port to preview.";
else if (window.top === window) status.textContent = "A preview only works inside the page that started the VM.";
else {
  addEventListener("message", (e: MessageEvent<{ vmPreview?: string; nonce?: string; url?: string }>) => {
    if (e.source !== window.top || e.origin !== location.origin || e.data?.vmPreview !== "slot" || e.data.nonce !== nonce) return;
    if (e.data.url) location.replace(e.data.url);
    else status.textContent = "This app has no preview origins.";
  });
  window.top!.postMessage({ vmPreview: "slot-request", port, nonce }, location.origin);
}
