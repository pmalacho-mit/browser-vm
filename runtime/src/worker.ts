// Entry point of the runtime worker (built to dist/runtime/worker.js). Started
// by web/runtime/frame.ts inside a hidden iframe whose CSP allows no network
// beyond this site, so the VM's traffic can only leave through the gate.
// Frontends reach it over a BroadcastChannel named by the page.
import { Runtime } from "./runtime.ts";
import { channelEndpoint, serve } from "./rpc.ts";

addEventListener("message", (e: MessageEvent<{ channel?: string }>) => {
  const name = e.data?.channel;
  if (!name || (globalThis as { __served?: boolean }).__served) return;
  (globalThis as { __served?: boolean }).__served = true;
  const runtime = new Runtime();
  runtime.emit = serve(channelEndpoint(new BroadcastChannel(name)), runtime);
});
