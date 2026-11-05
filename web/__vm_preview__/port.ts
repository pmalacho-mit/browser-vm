// Shared by the preview pages: asks the IDE page (window.top, web/runtime-host.ts)
// for a connection to this origin's guest port.

/** The guest port this origin previews ("5173-ab12cd34.preview.…" → 5173). */
export const guestPort = Number(location.hostname.split(".")[0].split("-")[0]);

/** A fresh MessagePort to a PreviewGateway (runtime/src/preview.ts) for guestPort. */
export function requestPort(timeoutMs = 10_000): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    if (window.top === window) return reject(new Error("a preview only works inside the IDE page that started the VM"));
    const nonce = crypto.randomUUID();
    const timer = setTimeout(() => { removeEventListener("message", onMessage); reject(new Error("the IDE page didn't answer")); }, timeoutMs);
    const onMessage = (e: MessageEvent<{ vmPreview?: string; nonce?: string }>) => {
      if (e.source !== window.top || e.data?.vmPreview !== "port" || e.data.nonce !== nonce || !e.ports[0]) return;
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      resolve(e.ports[0]);
    };
    addEventListener("message", onMessage);
    // The request carries nothing secret; the IDE page checks our origin before answering.
    window.top!.postMessage({ vmPreview: "port-request", nonce }, "*");
  });
}

/** Hands a gateway port to the service worker and waits until it has it. */
export function givePortToWorker(sw: ServiceWorker, port: MessagePort): Promise<void> {
  return new Promise((resolve) => {
    const ack = new MessageChannel();
    ack.port1.onmessage = () => resolve();
    sw.postMessage({ vmPreview: "port" }, [port, ack.port2]);
  });
}
