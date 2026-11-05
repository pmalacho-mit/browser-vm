// Entry point of the runtime worker (built to dist/runtime/worker.js). Started
// by web/runtime/frame.ts inside a hidden iframe whose CSP allows no network
// beyond this site, so the VM's traffic can only leave through the gate.
// Frontends reach it over a BroadcastChannel named by the page.
import { Runtime } from "./runtime.ts";
import { channelEndpoint, serve } from "./rpc.ts";

let runtime: Runtime | undefined;
addEventListener("message", (e: MessageEvent<{ channel?: string; preview?: number }>) => {
  const name = e.data?.channel;
  if (name && !runtime) {
    runtime = new Runtime();
    runtime.emit = serve(channelEndpoint(new BroadcastChannel(name)), runtime);
  }
  // A preview origin's connection to one guest port (web/runtime-host.ts).
  if (runtime && typeof e.data?.preview === "number" && e.ports[0]) {
    runtime._preview(e.data.preview, e.ports[0]).catch((err) => console.warn(`[preview] ${err.message}`));
  }
});
