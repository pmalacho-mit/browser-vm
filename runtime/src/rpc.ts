// A small request/event protocol between a runtime and its frontends.
//
//   client → server   { t: "hello", client }                      until acknowledged
//                     { t: "req", client, id, method, args }
//   server → client   { t: "hello-ack", client }
//                     { t: "res", client, id, value } | { t: "res", client, id, error }
//                     { t: "evt", topic, data }                    to every client
//
// It runs over anything that can post structured-clonable messages: a
// MessagePort, a BroadcastChannel (several clients on one channel; replies
// carry the client id), or an in-process pair (tests, Node). Errors keep their
// `code`, so a VmFsError arrives as one.
import { VmFsError, type FsErrorCode } from "./vmfs.ts";

/** Where messages go and come from. */
export interface Endpoint {
  post(message: unknown, transfer?: Transferable[]): void;
  listen(handler: (message: any) => void): void;
}

export const portEndpoint = (port: MessagePort): Endpoint => ({
  post: (m, transfer) => port.postMessage(m, transfer ?? []),
  listen: (h) => { port.onmessage = (e) => h(e.data); },
});

/** BroadcastChannel can't transfer, so buffers are copied. */
export const channelEndpoint = (ch: BroadcastChannel): Endpoint => ({
  post: (m) => ch.postMessage(m),
  listen: (h) => { ch.onmessage = (e) => h(e.data); },
});

/** Two connected endpoints in one process (structured clone, as across a port). */
export function endpointPair(): [Endpoint, Endpoint] {
  const handlers: [((m: any) => void)[], ((m: any) => void)[]] = [[], []];
  const make = (me: 0 | 1): Endpoint => ({
    post: (m) => { const copy = structuredClone(m); queueMicrotask(() => handlers[me ^ 1].forEach((h) => h(copy))); },
    listen: (h) => { handlers[me].push(h); },
  });
  return [make(0), make(1)];
}

type AnyFn = (...args: any[]) => any;
/** The methods of an API object, as callable remotely. */
export type Remote<T> = { [K in keyof T as T[K] extends AnyFn ? K : never]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

interface SerializedError { name: string; message: string; code?: string; path?: string }
const serializeError = (e: unknown): SerializedError => {
  const err = e as Error & { code?: string; path?: string };
  return { name: err?.name ?? "Error", message: err?.message ?? String(e), code: err?.code, path: err?.path };
};
const deserializeError = (e: SerializedError) =>
  e.name === "VmFsError" || (e.code && ["FileNotFound", "FileExists", "FileNotADirectory", "FileIsADirectory", "NoPermissions", "Unavailable"].includes(e.code))
    ? new VmFsError(e.code as FsErrorCode, e.message, e.path)
    : Object.assign(new Error(e.message), { code: e.code });

/** Collects ArrayBuffers in a result, so a MessagePort can transfer instead of copy. */
const transferables = (v: unknown): Transferable[] => {
  if (v instanceof Uint8Array && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && v.buffer instanceof ArrayBuffer) return [v.buffer];
  if (v && typeof v === "object" && !ArrayBuffer.isView(v)) return Object.values(v).flatMap(transferables);
  return [];
};

/**
 * Serves `api`'s methods on `endpoint`. Returns `emit(topic, data)` for events.
 * Only own and prototype methods whose names don't start with "_" are callable.
 */
export function serve(endpoint: Endpoint, api: object): (topic: string, data: unknown) => void {
  const callable = (name: string): AnyFn | undefined => {
    if (name.startsWith("_") || name === "constructor") return undefined;
    const f = (api as Record<string, unknown>)[name];
    return typeof f === "function" ? (f as AnyFn).bind(api) : undefined;
  };
  endpoint.listen(async (m) => {
    if (m?.t === "hello") return endpoint.post({ t: "hello-ack", client: m.client });
    if (m?.t !== "req") return;
    const f = callable(String(m.method));
    try {
      if (!f) throw new Error(`no such method: ${m.method}`);
      const value = await f(...(m.args ?? []));
      endpoint.post({ t: "res", client: m.client, id: m.id, value }, transferables(value));
    } catch (e) {
      endpoint.post({ t: "res", client: m.client, id: m.id, error: serializeError(e) });
    }
  });
  return (topic, data) => endpoint.post({ t: "evt", topic, data }, transferables(data));
}

export interface Client<T> {
  /** Remote methods. Calls made before the server answers are queued. */
  api: Remote<T>;
  /** Subscribe to an event topic. */
  on(topic: string, handler: (data: any) => void): { dispose(): void };
  /** Resolves once the server has answered (it may start after the client). */
  connected: Promise<void>;
}

/** Connects to a server on `endpoint`. */
export function connect<T>(endpoint: Endpoint): Client<T> {
  const client = crypto.randomUUID();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const handlers = new Map<string, Set<(d: any) => void>>();
  let onConnected!: () => void;
  const connected = new Promise<void>((res) => (onConnected = res));
  let isConnected = false;
  endpoint.listen((m) => {
    if (m?.t === "evt") { for (const h of handlers.get(m.topic) ?? []) try { h(m.data); } catch {} return; }
    if (m?.client !== client) return;
    if (m.t === "hello-ack") { if (!isConnected) { isConnected = true; onConnected(); } return; }
    if (m.t === "res") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(deserializeError(m.error)) : p.resolve(m.value);
    }
  });
  // Say hello until the server is there.
  const hello = () => { if (!isConnected) { endpoint.post({ t: "hello", client }); setTimeout(hello, 200); } };
  hello();
  const call = async (method: string, args: unknown[]) => {
    await connected;
    const id = nextId++;
    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    // Arguments are copied, never transferred: the caller may still use its buffers.
    endpoint.post({ t: "req", client, id, method, args });
    return p;
  };
  const api = new Proxy({}, { get: (_t, method) => (...args: unknown[]) => call(String(method), args) }) as Remote<T>;
  return {
    api,
    connected,
    on(topic, handler) {
      let set = handlers.get(topic);
      if (!set) handlers.set(topic, (set = new Set()));
      set.add(handler);
      return { dispose: () => { set.delete(handler); } };
    },
  };
}
