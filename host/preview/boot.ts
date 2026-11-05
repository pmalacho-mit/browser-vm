// The preview origin's first page (index.html): registers the service worker,
// connects it to the VM, then loads the requested path, which the service
// worker now serves from the guest's server.
import { givePortToWorker, requestPort } from "./port.ts";

const status = document.getElementById("status")!;
const say = (html: string) => { status.innerHTML = html; };

(async () => {
  const path = new URLSearchParams(location.search).get("path") || "/";
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("bad path");
  if (!("serviceWorker" in navigator)) throw new Error("this browser has no service workers here (a private window, or a non-secure origin?)");
  const reg = await navigator.serviceWorker.register("/__vm_preview_sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) throw new Error("the service worker didn't start");
  say("Connecting to the VM…");
  const c = await requestPort();
  say(`Connecting to port <code>${c.guestPort}</code> in the VM…`);
  await givePortToWorker(sw, c);
  location.replace(path);
})().catch((e: Error) => say(`This preview couldn't start: ${e.message.replace(/</g, "&lt;")}`));
