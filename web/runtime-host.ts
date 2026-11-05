// Host-page side of the VM runtime: embeds web/runtime/ in a hidden iframe and
// names the BroadcastChannel frontends use to reach it (window.__vmRuntimeChannel).
// The VS Code extension gets the name through the setting linuxVm.runtimeChannel
// (web/boot.ts); the lightweight frontend (web/lite/) reads it directly.
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
