// The preview origin's service worker (built to /__vm_preview_sw.js, scope "/"):
// answers every request on this origin from the guest's server, through a
// PreviewGateway (runtime/src/preview.ts) for this origin's port.
//
// Its connection is a MessagePort from the IDE page, handed over by a page of
// this origin (boot.ts, or client.ts in a previewed page). Browsers stop idle
// service workers, which loses the port; the next request then asks an open
// page for a new one, or sends a navigation back through boot.ts.
//
// Responses get a CSP that keeps the previewed app's network on this origin:
// guest code reaches the internet only through the gate.
import { connect, portEndpoint, type Client } from "@browser-vm/runtime/rpc";
import type { PreviewGateway, PreviewResponse } from "@browser-vm/runtime/preview";

// The worker's own types, declared here: the web project type-checks against the DOM.
interface FetchEvent extends Event { request: Request; respondWith(r: Promise<Response> | Response): void }
interface ExtendableEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface ExtendableMessageEvent extends Event { data: any; ports: readonly MessagePort[] }
interface WindowClient { url: string; postMessage(m: unknown, transfer?: Transferable[]): void }
interface Scope {
  clients: { matchAll(o?: { type?: string; includeUncontrolled?: boolean }): Promise<WindowClient[]>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "fetch", h: (e: FetchEvent) => void): void;
  addEventListener(type: "install" | "activate", h: (e: ExtendableEvent) => void): void;
  addEventListener(type: "message", h: (e: ExtendableMessageEvent) => void): void;
}
const sw = self as unknown as Scope;

const OWN = "/__vm_preview__/";
/** The guest port this origin shows: sent with each connection (for the "nothing is listening" page). */
let guestPort = 0;
/** Applied to every page: the app may load and connect to this origin only (its server in the VM). */
const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self'; frame-ancestors *";

let gateway: Client<PreviewGateway> | undefined;
let gatewayWaiters: ((g: Client<PreviewGateway>) => void)[] = [];

sw.addEventListener("install", () => { sw.skipWaiting(); });
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));
sw.addEventListener("message", (e) => {
  if (e.data?.vmPreview !== "port" || !e.ports[0]) return; // (pings only keep the worker alive)
  if (Number(e.data.guestPort) > 0) guestPort = Number(e.data.guestPort);
  gateway = connect<PreviewGateway>(portEndpoint(e.ports[0]));
  for (const w of gatewayWaiters.splice(0)) w(gateway);
  e.ports[1]?.postMessage("ok");
});

/** The gateway; after a restart of this worker, asks the open pages of this origin for a new one. */
async function getGateway(): Promise<Client<PreviewGateway>> {
  if (gateway) return gateway;
  const waiting = new Promise<Client<PreviewGateway>>((res, rej) => {
    gatewayWaiters.push(res);
    setTimeout(() => rej(new Error("no page of this preview could connect it to the VM")), 5_000);
  });
  for (const c of await sw.clients.matchAll({ type: "window" })) c.postMessage({ vmPreview: "need-port" });
  return waiting;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error(what), { code: "Timeout" })), ms))]);

const page = (status: number, title: string, text: string, retry = false) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title>${retry ? '<meta http-equiv="refresh" content="2">' : ""}` +
    `<body style="font:14px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 16px;color:#333">` +
    `<h1 style="font-size:16px">${title}</h1><p>${text}</p></body>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP } });

sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // the CSP stops the app's own cross-origin requests
  if (url.pathname.startsWith(OWN) || url.pathname === "/__vm_preview_sw.js") return; // this machinery itself
  e.respondWith(handle(e.request, url));
});

async function handle(req: Request, url: URL): Promise<Response> {
  const navigate = req.mode === "navigate";
  let gw: Client<PreviewGateway>;
  try {
    gw = await getGateway();
  } catch {
    // Start over from boot.ts, which connects us again.
    if (navigate) return Response.redirect(`${OWN}?path=${encodeURIComponent(url.pathname + url.search)}`, 302);
    return new Response("the preview lost its connection to the VM; reload the page", { status: 503 });
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
  let r: PreviewResponse;
  try {
    r = await withTimeout(gw.api.http({ method: req.method, path: url.pathname + url.search, headers: [...req.headers], body }), 130_000, "the server in the VM didn't answer");
  } catch (err) {
    const { code, message } = err as Error & { code?: string };
    // A dead connection (the IDE page reloaded): forget it, so the next request reconnects.
    if (code === "Timeout") gateway = undefined;
    if (!navigate) return new Response(message, { status: 502 });
    if (code === "Refused") {
      return page(502, `Nothing is listening on port ${guestPort} yet`, `Start your server in the VM's terminal, listening on <code>0.0.0.0:${guestPort}</code> (not only 127.0.0.1). This page retries every 2 seconds.`, true);
    }
    return page(502, "The preview couldn't load this page", message.replace(/</g, "&lt;"));
  }
  const headers = new Headers();
  for (const [k, v] of r.headers) try { headers.append(k, v); } catch {}
  let resBody: Uint8Array | null = r.body;
  if (/^text\/html/i.test(headers.get("content-type") ?? "")) {
    // client.js: WebSockets through the VM, and reconnecting this worker.
    const html = new TextDecoder().decode(r.body);
    const tag = `<script src="${OWN}client.js"></script>`;
    const at = html.search(/<head[^>]*>/i);
    resBody = new TextEncoder().encode(at >= 0 ? html.replace(/<head[^>]*>/i, (h) => h + tag) : tag + html);
    headers.set("content-security-policy", CSP);
  }
  if ([101, 204, 205, 304].includes(r.status)) resBody = null;
  return new Response(resBody as BodyInit | null, { status: r.status, statusText: r.statusText, headers });
}
