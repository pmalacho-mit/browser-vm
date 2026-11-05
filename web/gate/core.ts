// The gate's decisions, as pure functions (no DOM, no storage, no network) so
// they can be unit-tested in Node: scripts/gate-test.mjs.
//
// Model (after desolate's mitmproxy addon, adapted to a browser):
//   * A secret is keyed by its PLACEHOLDER, the string code inside the VM uses
//     (`Authorization: Bearer GATE-OPENAI-KEY`). Its value exists only in the
//     gate's origin and is substituted in flight, only toward its `hosts`.
//   * The destination is the URL the gate itself passes to fetch(). The browser
//     then verifies TLS for that hostname, so the name a secret is matched against
//     IS the proven destination; there is no separate IP the caller could pick.
//   * Secrets are substituted over https only, in request HEADERS only unless
//     the secret says `anywhere: true` (a body or URL can be computed on, e.g. by
//     an LLM, and handed back transformed; a header the host reads but doesn't
//     repeat can't).
//   * A placeholder headed anywhere else goes out as written (it is not a
//     secret) and is reported as a LEAK-SUSPECT.
//   * Responses are scrubbed: an exact echo of a value turns back into its
//     placeholder. (Not a boundary; see README.)

const enc = new TextEncoder(), dec = new TextDecoder();

// ---- types ----------------------------------------------------------------------

export type Mode = "open" | "learn" | "enforce";
export type Decision = "allow" | "deny" | "learn";

/** A network rule. `builtin` marks the deployment's defaults (config.ts). */
export interface Rule {
  host: string;
  action: "allow" | "deny";
  builtin?: boolean;
}

/** Where a secret may go and how often. Stored in the clear (not secret). */
export interface SecretMeta {
  /** Hostname patterns: "api.x.com" or "*.x.com". */
  hosts: string[];
  /** Header names it may be substituted into; null = any header. */
  headers?: string[] | null;
  /** Also substitute in the URL and body. */
  anywhere?: boolean;
  /** Environment variable that holds the placeholder inside the VM. */
  env?: string;
  /** Switched off by the user. */
  off?: boolean;
  /** Epoch ms after which the secret is off. */
  until?: number;
  quota?: Quota | null;
}

export interface Quota {
  max: number;
  perHours: number;
}

/** A secret as the rules see it: either its value, or `locked` while the vault is locked. */
export interface SecretInput extends SecretMeta {
  value?: string;
  locked?: boolean;
}

/** A secret that passed validate(): lowercase hosts and headers. */
export interface ValidSecret extends SecretInput {
  headers: string[] | null;
}

export interface Settings {
  mode?: string;
  rules?: Rule[];
  secrets?: Record<string, SecretInput>;
}

/** The checked configuration every request is decided against. */
export interface GateConfig {
  secrets: Record<string, ValidSecret>;
  rules: Rule[];
  mode: Mode;
  problems: string[];
}

/** One request, as it arrives from the VM. */
export interface GateRequestInput {
  url: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

export type Applied =
  | { refuse: string; code?: "locked"; url?: undefined; headers?: undefined; body?: undefined; substituted?: undefined; leaks?: undefined }
  | { refuse?: undefined; code?: undefined; url: string; headers: [string, string][]; body: Uint8Array | null; substituted: string[]; leaks: string[] };

// ---- names and host patterns ---------------------------------------------

export const PLACEHOLDER_RE = /^[A-Z][A-Z0-9_-]{5,63}$/;
export const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet"];

/** Why a destination is never reachable through the gate (or null). Private networks are not the VM's to reach. */
export function refuseDestination(url: URL): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return "only http(s) is supported";
  if (url.username || url.password) return "URLs with credentials are refused";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return "local hostnames are refused";
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return "IP addresses are refused (use a hostname)";
  if (!host.includes(".")) return "single-label hostnames are refused";
  return null;
}

/** A secret's host pattern must pin a destination: "api.x.com" or "*.x.com", never "*", "*.com" or "*x.com". */
export function hostPatternProblem(pattern: unknown): string | null {
  if (typeof pattern !== "string" || !pattern) return "is empty";
  const p = pattern.toLowerCase();
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(p)) return "must be a hostname, optionally with one leading '*.' label";
  const literal = p.startsWith("*.") ? p.slice(2) : p;
  if (literal.split(".").length < 2) return "must have at least two literal labels";
  return null;
}

export function hostMatches(pattern: string, host: string): boolean {
  pattern = pattern.toLowerCase(); host = host.toLowerCase();
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(1); // ".x.com"
    return host.endsWith(base) && !host.slice(0, -base.length).includes(".") && host.length > base.length;
  }
  return host === pattern;
}

/**
 * Validates a settings object. Returns { secrets, rules, mode, problems } with
 * invalid secrets DROPPED (the safe direction: an unknown placeholder is
 * substituted nowhere).
 */
export function validate(settings: Settings = {}): GateConfig {
  const problems: string[] = [];
  const secrets: Record<string, ValidSecret> = {};
  for (const [name, s] of Object.entries(settings.secrets || {})) {
    const bad = (why: string) => problems.push(`secret ${name}: ${why}; dropped`);
    if (!PLACEHOLDER_RE.test(name)) { bad("placeholder must be 6-64 chars of A-Z 0-9 _ - starting with a letter"); continue; }
    // A locked secret (vault not unlocked, see vault.js) has no value in memory.
    // It keeps its place so requests that need it are refused with "unlock",
    // rather than silently going out with the bare placeholder.
    const locked = !!s?.locked;
    if (!s || (!locked && (typeof s.value !== "string" || !s.value))) { bad("has no value"); continue; }
    if (!Array.isArray(s.hosts) || !s.hosts.length) { bad("has no hosts allowlist"); continue; }
    const hp = s.hosts.map((h) => [h, hostPatternProblem(h)]).filter(([, p]) => p);
    if (hp.length) { bad(hp.map(([h, p]) => `host ${JSON.stringify(h)} ${p}`).join(", ")); continue; }
    if (s.headers != null && (!Array.isArray(s.headers) || !s.headers.length || !s.headers.every((h) => typeof h === "string" && h))) {
      bad("headers must be a non-empty list of header names"); continue;
    }
    if (s.env != null && !ENV_RE.test(s.env)) { bad("env is not a valid variable name"); continue; }
    if (s.quota != null && !(Number.isInteger(s.quota.max) && s.quota.max > 0 && s.quota.perHours > 0 && s.quota.perHours <= 24 * 31)) {
      bad("quota must be { max: integer > 0, perHours: 0 < n <= 744 }"); continue;
    }
    if (!locked && s.value!.length < 8) { bad("value is too short to scrub safely"); continue; }
    secrets[name] = { ...s, hosts: s.hosts.map((h) => h.toLowerCase()), headers: s.headers?.map((h) => h.toLowerCase()) ?? null };
  }
  // No placeholder may contain another (substitution is a plain string replace).
  for (const a of Object.keys(secrets)) for (const b of Object.keys(secrets)) {
    if (a !== b && b.includes(a) && secrets[a] && secrets[b]) {
      problems.push(`secrets ${a} and ${b}: one name contains the other; both dropped`);
      delete secrets[a]; delete secrets[b];
    }
  }
  const mode: Mode = settings.mode === "learn" || settings.mode === "enforce" ? settings.mode : "open";
  const rules = (settings.rules || []).filter((r) => r && typeof r.host === "string" && ["allow", "deny"].includes(r.action) && !hostPatternProblem(r.host));
  return { secrets, rules, mode, problems };
}

// ---- the network policy ---------------------------------------------------

/** "allow" | "deny" | "learn" (allowed, but recorded as something enforce would refuse). First matching rule wins. */
export function decide(cfg: GateConfig, host: string): Decision {
  const rule = cfg.rules.find((r) => hostMatches(r.host, host));
  if (rule) return rule.action;
  return cfg.mode === "open" ? "allow" : cfg.mode === "learn" ? "learn" : "deny";
}

// ---- substitution -----------------------------------------------------------

const includesBytes = (hay: Uint8Array, needle: Uint8Array) => indexOfBytes(hay, needle) >= 0;
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
export function replaceBytes(hay: Uint8Array, needle: Uint8Array, repl: Uint8Array): Uint8Array {
  let i = indexOfBytes(hay, needle);
  if (i < 0) return hay;
  const parts: Uint8Array[] = []; let last = 0;
  while (i >= 0) { parts.push(hay.subarray(last, i), repl); last = i + needle.length; i = indexOfBytes(hay, needle, last); }
  parts.push(hay.subarray(last));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Applies the secrets to one request. Returns either
 *   { refuse: "why" }   or
 *   { url, headers, body, substituted: [names], leaks: [names] }
 * `headers` is an array of [name, value]; `body` a Uint8Array or null.
 */
export function applySecrets(cfg: GateConfig, req: GateRequestInput, now = Date.now()): Applied {
  const url = new URL(req.url);
  const host = url.hostname.toLowerCase();
  const bodyBytes = req.body || null;
  let headers = req.headers.map(([k, v]): [string, string] => [k.toLowerCase(), v]);
  let urlStr = url.href, body = bodyBytes;
  const substituted: string[] = [], leaks: string[] = [];

  for (const [name, s] of Object.entries(cfg.secrets)) {
    const nameBytes = enc.encode(name);
    const inHeader = (k: string) => !s.headers || s.headers.includes(k);
    const where = {
      headers: headers.some(([k, v]) => v.includes(name) && (s.anywhere || inHeader(k))),
      url: s.anywhere && urlStr.includes(name),
      body: s.anywhere && body && includesBytes(body, nameBytes),
    };
    // Mentions outside the places this secret lives aren't this secret at all.
    if (!where.headers && !where.url && !where.body) {
      const mentioned = headers.some(([, v]) => v.includes(name)) || urlStr.includes(name) || (body && includesBytes(body, nameBytes));
      if (mentioned && !s.hosts.some((p) => hostMatches(p, host))) leaks.push(name);
      continue;
    }
    if (!s.hosts.some((p) => hostMatches(p, host))) { leaks.push(name); continue; }
    if (url.protocol !== "https:") return { refuse: `secret ${name} may only be sent over https` };
    if (s.off || (s.until && now > s.until)) return { refuse: `secret ${name} is switched off; turn it on in the gate's settings` };
    if (s.locked) return { refuse: `the gate is locked, so secret ${name} can't be used; unlock it in the gate's settings`, code: "locked" };
    const value = s.value!; // not locked (checked above), so validate() guaranteed a value
    if (where.headers) headers = headers.map(([k, v]): [string, string] => [k, (s.anywhere || inHeader(k)) ? v.split(name).join(value) : v]);
    if (where.url) urlStr = urlStr.split(name).join(encodeURIComponent(value));
    if (where.body) body = replaceBytes(body!, nameBytes, enc.encode(value));
    substituted.push(name);
  }
  return { url: urlStr, headers, body, substituted, leaks };
}

// ---- quotas --------------------------------------------------------------------

/**
 * Sliding-window request quota for one secret. `log` is that secret's list of
 * recent use timestamps (mutated). Returns null and records this use, or the
 * reason it is over quota. A quota bounds how much a runaway or malicious
 * program can spend with a key; it is reset by reloading the page.
 */
export function quotaCheck(log: number[], quota: Quota | null | undefined, now = Date.now()): string | null {
  if (!quota) return null;
  const from = now - quota.perHours * 3_600_000;
  while (log.length && log[0] <= from) log.shift();
  if (log.length >= quota.max) {
    const retryIn = Math.ceil((log[0] + quota.perHours * 3_600_000 - now) / 60_000);
    return `over its quota of ${quota.max} requests per ${quota.perHours} h (next allowed in ${retryIn} min)`;
  }
  log.push(now);
  return null;
}

// ---- response scrubbing -----------------------------------------------------

/** Streaming exact-match scrubber: value bytes → placeholder bytes, across chunk boundaries. */
export function makeScrubber(cfg: GateConfig) {
  const known = Object.entries(cfg.secrets).filter((e): e is [string, ValidSecret & { value: string }] => !!e[1].value);
  const pairs = known.map(([name, s]) => [enc.encode(s.value), enc.encode(name)] as const);
  const keep = Math.max(0, ...pairs.map(([v]) => v.length - 1));
  let tail = new Uint8Array(0);
  const scrub = (b: Uint8Array) => pairs.reduce((acc, [v, n]) => replaceBytes(acc, v, n), b);
  return {
    headerValue: (v: string) => known.reduce((acc, [name, s]) => acc.split(s.value).join(name), v),
    /** Feed a chunk; returns the bytes that are safe to release now. */
    push(chunk: Uint8Array): Uint8Array {
      const all = new Uint8Array(tail.length + chunk.length); all.set(tail); all.set(chunk, tail.length);
      const out = scrub(all);
      // Hold back enough bytes that a value split across chunks is still caught.
      const cut = Math.max(0, out.length - keep);
      tail = out.slice(cut);
      return out.slice(0, cut);
    },
    flush(): Uint8Array { const t = scrub(tail); tail = new Uint8Array(0); return t; },
  };
}

// Headers forwarded to fetch() for ordinary requests: the CORS-safelisted set
// (anything else costs a preflight many servers don't answer). A request that
// carries a secret is going to an API that expects its headers, so it keeps them all.
export const SAFELISTED = new Set(["accept", "accept-language", "content-language", "content-type", "range"]);
export const NEVER_FORWARD = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "content-length",
  "upgrade", "te", "trailer", "expect", "cookie", "accept-encoding", "user-agent", "origin", "referer"]);
export function forwardHeaders(headers: [string, string][], carriesSecret: boolean): [string, string][] {
  return headers.filter(([k]) => !NEVER_FORWARD.has(k) && (carriesSecret || SAFELISTED.has(k) || k === "authorization"));
}

export const textOf = (b: Uint8Array) => dec.decode(b);
