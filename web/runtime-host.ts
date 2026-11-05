// Host-page side of the VM runtime: embeds web/runtime/ in a hidden iframe and
// names the BroadcastChannel frontends use to reach it (window.__vmRuntimeChannel).
// The VS Code extension gets the name through the setting linuxVm.runtimeChannel
// (web/boot.ts); the lightweight frontend (web/lite/) reads it directly.
//
// It also connects previews (web/__vm_preview__/) to the runtime. A preview of
// guest port P is served on its own origin, P-<tab>.preview.<host>; a page there
// asks this window (window.top) for a connection, and gets a MessagePort to a
// gateway for port P alone (runtime/src/preview.ts).
export {}; // a module for type checking; esbuild emits a self-contained classic script

const name = `vm-runtime-${crypto.randomUUID()}`;
window.__vmRuntimeChannel = name;
const iframe = document.createElement("iframe");
// Relative to this script (the site root), so pages in subfolders (lite/) can load it too.
const here = (document.currentScript as HTMLScriptElement | null)?.src ?? document.baseURI;
iframe.src = new URL(`runtime/index.html#channel=${encodeURIComponent(name)}`, here).href;
iframe.title = "VM runtime";
iframe.style.display = "none";
const attach = () => document.body.append(iframe);
document.body ? attach() : addEventListener("DOMContentLoaded", attach);

// ---- previews ------------------------------------------------------------------

/** This tab's id in preview origins: kept across reloads of the tab, so its preview origins (and service workers) are reused. */
const tab = (() => {
  try {
    let t = sessionStorage.getItem("vm-preview-tab");
    if (!t || !/^[0-9a-f]{8}$/.test(t)) sessionStorage.setItem("vm-preview-tab", (t = crypto.randomUUID().slice(0, 8)));
    return t;
  } catch {
    return crypto.randomUUID().slice(0, 8);
  }
})();

/**
 * Preview origins, as a template with "{id}" for "<port>-<tab>": PREVIEW_URL at
 * build time (site.js), or locally *.preview.localhost on this port. Every
 * preview origin must serve this site's files at its root.
 */
const template = (() => {
  const configured = globalThis.SITE_CONFIG?.previewUrl;
  if (configured) return configured.replace(/\/*$/, "/");
  if (location.hostname === "localhost") return `${location.protocol}//{id}.preview.localhost${location.port ? ":" + location.port : ""}/`;
  return undefined;
})();

/** Where to open a preview, with "{port}" for the guest port (undefined: this site has no preview origin). */
window.__vmPreviewUrl = template ? `${template.replace("{id}", `{port}-${tab}`)}__vm_preview__/?path=%2F` : undefined;

if (template) {
  // "http://{id}.preview.localhost:8080/" → /^http:\/\/(\d+)-<tab>\.preview\.localhost:8080$/
  const [before, after] = new URL(template.replace("{id}", "ID-PLACEHOLDER")).origin.split("id-placeholder");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const originRe = new RegExp(`^${escape(before)}(\\d{1,5})-${tab}${escape(after)}$`);
  addEventListener("message", (e: MessageEvent<{ vmPreview?: string; nonce?: string }>) => {
    if (e.data?.vmPreview !== "port-request" || !e.source) return;
    const m = e.origin.match(originRe);
    const port = m ? Number(m[1]) : 0;
    if (!(port >= 1 && port <= 65535) || !iframe.contentWindow) return;
    const { port1, port2 } = new MessageChannel();
    iframe.contentWindow.postMessage({ preview: port }, location.origin, [port1]);
    (e.source as WindowProxy).postMessage({ vmPreview: "port", nonce: e.data.nonce }, e.origin, [port2]);
  });
}
