// Shared by the preview pages: asks the app's page (window.top, host/src/runtime-host.ts)
// for a connection to the guest port this origin previews. The page decides
// which port that is from our origin: the port in our host name
// ("5173-ab12cd34.preview.…"), or the one it assigned to this origin when the
// app has a fixed list of preview origins (PREVIEW_ORIGINS).

export interface Connection {
  /** A MessagePort to a PreviewGateway (runtime/src/preview.ts). */
  port: MessagePort;
  /** The guest port it reaches. */
  guestPort: number;
}

/** A fresh connection to this origin's guest port. */
export function requestPort(timeoutMs = 10_000): Promise<Connection> {
  return new Promise((resolve, reject) => {
    if (window.top === window) return reject(new Error("a preview only works inside the page that started the VM"));
    const nonce = crypto.randomUUID();
    const timer = setTimeout(() => { removeEventListener("message", onMessage); reject(new Error("the app's page didn't answer (is this preview still assigned here?)")); }, timeoutMs);
    const onMessage = (e: MessageEvent<{ vmPreview?: string; nonce?: string; guestPort?: number }>) => {
      if (e.source !== window.top || e.data?.vmPreview !== "port" || e.data.nonce !== nonce || !e.ports[0]) return;
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      resolve({ port: e.ports[0], guestPort: Number(e.data.guestPort) || 0 });
    };
    addEventListener("message", onMessage);
    // The request carries nothing secret; the app's page checks our origin before answering.
    window.top!.postMessage({ vmPreview: "port-request", nonce }, "*");
  });
}

/** Hands a gateway connection to the service worker and waits until it has it. */
export function givePortToWorker(sw: ServiceWorker, c: Connection): Promise<void> {
  return new Promise((resolve) => {
    const ack = new MessageChannel();
    ack.port1.onmessage = () => resolve();
    sw.postMessage({ vmPreview: "port", guestPort: c.guestPort }, [c.port, ack.port2]);
  });
}
