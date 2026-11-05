// The runtime host: the script a page includes to run a VM (built to
// <site>/host/runtime-host.js, after site.js and host/gate-relay.js). It embeds
// the runtime frame (host/runtime-frame/) in a hidden iframe and names the
// BroadcastChannel surfaces use to reach it (window.__vmRuntimeChannel). The
// VS Code surface gets the name through the setting linuxVm.runtimeChannel;
// lite reads it directly.
//
// It also connects previews (host/preview/) to the runtime. A preview of guest
// port P is served on an origin of its own: P-<tab>.preview.<host>, or one from
// a fixed list this page hands out (below). A page there asks this window
// (window.top) for a connection, and gets a MessagePort to a gateway for port P
// alone (runtime/src/preview.ts).
export {}; // a module for type checking; esbuild emits a self-contained classic script

const name = `vm-runtime-${crypto.randomUUID()}`;
window.__vmRuntimeChannel = name;
const iframe = document.createElement("iframe");
// Relative to this script (<site>/host/), so pages at any path can load it.
const here = (document.currentScript as HTMLScriptElement | null)?.src ?? document.baseURI;
// The web gate's channel, if the page has a gate relay (gates/web/src/relay.ts runs first).
const fragment = new URLSearchParams({ channel: name, ...(window.__vmGateChannel && { gate: window.__vmGateChannel }) });
iframe.src = new URL(`runtime/index.html#${fragment}`, here).href;
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
 * Preview origins, in one of two shapes. Every preview origin serves the app's
 * preview folder (dist/<app>/preview/) at its root.
 *
 * - One origin per guest port and tab, from a template with "{id}" for
 *   "<port>-<tab>": PREVIEW_URL at build time, or locally *.preview.localhost on
 *   this port. The origin itself names the guest port.
 * - A fixed list of origins (PREVIEW_ORIGINS, e.g. extra forwarded ports behind a
 *   forwarder that answers one exact host name per port). This page assigns
 *   guest ports to them as previews open: at most that many at once, the oldest
 *   given up first. Surfaces open host/preview-open.html, which asks this page
 *   for the origin and goes there. The list is shared by every tab of the app.
 */
const slots: string[] | undefined = globalThis.SITE_CONFIG?.previews === false ? undefined
  : globalThis.SITE_CONFIG?.previewOrigins?.map((o) => new URL(o).origin);
const template = (() => {
  if (globalThis.SITE_CONFIG?.previews === false || slots?.length) return undefined;
  const configured = globalThis.SITE_CONFIG?.previewUrl;
  if (configured) return configured.replace(/\/*$/, "/");
  if (location.hostname === "localhost") return `${location.protocol}//{id}.preview.localhost${location.port ? ":" + location.port : ""}/`;
  return undefined;
})();

/** Where to open a preview, with "{port}" for the guest port (undefined: this site has no preview origin). */
window.__vmPreviewUrl = slots?.length
  ? `${new URL("preview-open.html", here).href}?port={port}`
  : template ? `${template.replace("{id}", `{port}-${tab}`)}__vm_preview__/?path=%2F` : undefined;

/** Answers a preview page that asks for a connection to `guestPort`. */
function givePreviewPort(e: MessageEvent<{ nonce?: string }>, guestPort: number) {
  if (!(guestPort >= 1 && guestPort <= 65535) || !iframe.contentWindow) return;
  const { port1, port2 } = new MessageChannel();
  iframe.contentWindow.postMessage({ preview: guestPort }, location.origin, [port1]);
  (e.source as WindowProxy).postMessage({ vmPreview: "port", nonce: e.data.nonce, guestPort }, e.origin, [port2]);
}

if (template) {
  // "http://{id}.preview.localhost:8080/" → /^http:\/\/(\d+)-<tab>\.preview\.localhost:8080$/
  const [before, after] = new URL(template.replace("{id}", "ID-PLACEHOLDER")).origin.split("id-placeholder");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const originRe = new RegExp(`^${escape(before)}(\\d{1,5})-${tab}${escape(after)}$`);
  addEventListener("message", (e: MessageEvent<{ vmPreview?: string; nonce?: string }>) => {
    if (e.data?.vmPreview !== "port-request" || !e.source) return;
    const m = e.origin.match(originRe);
    givePreviewPort(e, m ? Number(m[1]) : 0);
  });
}

if (slots?.length) {
  /** Which guest port each preview origin shows, and when it was last opened. */
  const assigned = slots.map(() => ({ guestPort: 0, opened: 0 }));
  addEventListener("message", (e: MessageEvent<{ vmPreview?: string; nonce?: string; port?: number }>) => {
    if (!e.source) return;
    // From the opener page (this app's origin): give the guest port an origin.
    if (e.data?.vmPreview === "slot-request" && e.origin === location.origin) {
      const guestPort = Number(e.data.port);
      if (!(guestPort >= 1 && guestPort <= 65535)) return;
      let i = assigned.findIndex((a) => a.guestPort === guestPort);
      if (i < 0) i = assigned.findIndex((a) => a.guestPort === 0);
      if (i < 0) i = assigned.reduce((oldest, a, j) => (a.opened < assigned[oldest].opened ? j : oldest), 0);
      assigned[i] = { guestPort, opened: Date.now() };
      (e.source as WindowProxy).postMessage({ vmPreview: "slot", nonce: e.data.nonce, url: `${slots[i]}/__vm_preview__/?path=%2F` }, e.origin);
      return;
    }
    // From a preview origin: connect it to the guest port it was given.
    if (e.data?.vmPreview === "port-request") {
      const i = slots.indexOf(e.origin);
      if (i >= 0) givePreviewPort(e, assigned[i].guestPort);
    }
  });
}
