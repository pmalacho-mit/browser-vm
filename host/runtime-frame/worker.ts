// The runtime worker (built to <site>/host/runtime/worker.js), started by
// frame.ts inside the runtime frame, whose CSP allows no network beyond this
// site: the VM's traffic can only leave through the gate.
//
// It is the runtime's host in the browser: it makes the Runtime, gives it the
// web gate's client as its Gate and the VM folder as its assets, and serves it
// to surfaces over a BroadcastChannel named by the page.
import { Runtime } from "@browser-vm/runtime";
import { channelEndpoint, serve } from "@browser-vm/runtime/rpc";
import { WebGateClient } from "@browser-vm/gate-web/client";

interface Start {
  /** The runtime's BroadcastChannel (host/src/runtime-host.ts). */
  channel?: string;
  /** The web gate relay's BroadcastChannel; absent when the app has no gate. */
  gate?: string;
  /** URL of the VM folder (machine + images). */
  assets?: string;
  /** A preview origin's connection to one guest port (with a MessagePort). */
  preview?: number;
}

let runtime: Runtime | undefined;
addEventListener("message", (e: MessageEvent<Start>) => {
  const { channel, gate, assets, preview } = e.data ?? {};
  if (channel && !runtime) {
    runtime = new Runtime({ gate: gate ? new WebGateClient(gate) : undefined, assets });
    runtime.emit = serve(channelEndpoint(new BroadcastChannel(channel)), runtime);
  }
  if (runtime && typeof preview === "number" && e.ports[0]) {
    runtime._preview(preview, e.ports[0]).catch((err) => console.warn(`[preview] ${err.message}`));
  }
});
