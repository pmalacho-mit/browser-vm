// The gate: the only way the VM (and editor extensions) reach the network, and
// the only place secrets exist. It runs on its OWN origin (gate.<your host>),
// so the same-origin policy keeps its storage and memory away from the IDE,
// the VM and every editor extension. That is the browser's version of putting
// the proxy in a separate VM.
//
//   framed (hidden iframe in the IDE)  → the proxy: requests in over a
//                                         MessagePort, fetch() out
//   popup  (#manage, opened by a click → settings: secrets (write-only),
//           inside the framed gate)       unlock, network mode, rules, audit log
import { validate, decide, applySecrets, makeScrubber, refuseDestination, forwardHeaders, quotaCheck } from "./core.js";
import { embedderOrigins, defaultPolicy } from "./config.js";
import { createVault, unlockVault, addMethod, removeMethod, methodsOf, sealValue, openValue } from "./vault.js";

// ---------------------------------------------------------------------------
// storage (IndexedDB in the gate origin; never readable by the IDE origin)

const idb = new Promise((res, rej) => {
  const r = indexedDB.open("gate", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const kv = async (mode, fn) => {
  const db = await idb;
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
};
const load = (k) => kv("readonly", (s) => s.get(k));
const store = (k, v) => kv("readwrite", (s) => (v === undefined ? s.delete(k) : s.put(v, k)));

// ---------------------------------------------------------------------------
// state

// Stored "settings": { mode, rules, vault: header, secrets: { NAME: { env, hosts, headers, anywhere, off, quota, sealed } } }
// Values exist only in `values`, and only while the vault is unlocked.
let raw = { mode: defaultPolicy.mode, rules: [], secrets: {} };
let dek = null;                 // the vault's data key while unlocked (non-extractable)
const values = new Map();       // placeholder -> plaintext value, while unlocked
const broken = new Map();       // placeholder -> why it couldn't be decrypted
const quotaLog = new Map();     // placeholder -> recent use timestamps (this page load)
const usedWith = new Set();     // "placeholder host" pairs seen this session (first-use notices)
const leakedTo = new Set();     // same, for leak notices
let remembered = false;

// The user's rules come first; the deployment's defaults apply after them.
const rulesInEffect = () => [...raw.rules, ...defaultPolicy.rules.filter((d) => !raw.rules.some((r) => r.host === d.host))];

// What the rules see: unlocked secrets carry their value, the rest are "locked".
const view = () => ({
  mode: raw.mode,
  rules: rulesInEffect(),
  secrets: Object.fromEntries(Object.entries(raw.secrets).filter(([n]) => !broken.has(n)).map(([n, s]) => {
    const { sealed, value: legacy, ...meta } = s;
    return [n, values.has(n) ? { ...meta, value: values.get(n) } : { ...meta, locked: true }];
  })),
});
let cfg = validate(view());
const seen = new Map();   // host -> { count, decision, last }
let audit = [];           // most recent first; persisted (it never contains a value)
const listeners = new Set();
let notify = () => {};    // set by the framed role: sends a notice to the IDE
const changed = () => {
  cfg = validate(view());
  cfg.problems.push(...[...broken.values()]);
  for (const f of listeners) try { f(); } catch {}
};
const vaultState = () => (!raw.vault ? "none" : dek ? "unlocked" : "locked");

async function openAll(key) {
  values.clear(); broken.clear();
  for (const [name, s] of Object.entries(raw.secrets)) {
    if (!s.sealed) continue;
    try { values.set(name, await openValue(key, name, s)); } catch (e) { broken.set(name, e.message); }
  }
  dek = key;
  changed();
}
const needUnlocked = () => (vaultState() === "unlocked" ? null : vaultState() === "none" ? "set up a passkey or passphrase first" : "unlock the gate first");

let auditTimer;
function record(entry) {
  audit.unshift({ t: Date.now(), ...entry });
  audit.length = Math.min(audit.length, 300);
  if (entry.verdict === "LEAK-SUSPECT") console.warn(`[gate] LEAK-SUSPECT ${entry.leaks.join(",")} → ${entry.host}`);
  clearTimeout(auditTimer);
  auditTimer = setTimeout(() => store("audit", audit).catch(() => {}), 500);
  for (const f of listeners) try { f(); } catch {}
}

// Re-seals every value: needed when its binding (allowlist) or the key changes.
async function sealAll(key, secrets) {
  const out = {};
  for (const [name, s] of Object.entries(secrets)) {
    const { value, sealed, ...meta } = s;
    const plain = value ?? values.get(name);
    out[name] = plain ? { ...meta, sealed: await sealValue(key, name, meta, plain) } : s;
  }
  return out;
}

// The API the settings popup uses (same origin, so it calls these directly).
// Note what is missing: there is no way to read a secret's value back.
const api = {
  state: () => ({
    mode: raw.mode,
    rules: rulesInEffect(),
    vault: vaultState(),
    methods: methodsOf(raw.vault),
    remembered,
    legacy: Object.values(raw.secrets).some((s) => s.value),
    secrets: Object.entries(raw.secrets).map(([name, s]) => ({
      name, env: s.env || "", hosts: s.hosts, headers: s.headers || null, anywhere: !!s.anywhere, off: !!s.off, quota: s.quota || null,
      valid: !!cfg.secrets[name], locked: !values.has(name), broken: broken.has(name), usedThisSession: (quotaLog.get(name) || []).length,
    })),
    problems: cfg.problems,
    seen: [...seen].map(([host, v]) => ({ host, ...v })).sort((a, b) => b.last - a.last),
    audit: audit.slice(0, 100),
  }),

  // ---- vault. A `method` is { passphrase } or { prfBytes, prfSalt?, credential?, credentialId? } (see vault.js).
  async setupVault(method) {
    if (raw.vault) return "a vault already exists";
    try {
      const v = await createVault(method);
      // Seal any values stored in the clear by an earlier version.
      raw = { ...raw, vault: v.header, secrets: await sealAll(v.dek, raw.secrets) };
      await store("settings", raw);
      await openAll(v.dek);
      return null;
    } catch (e) { return e.message; }
  },
  async unlock(method, remember) {
    try {
      const key = await unlockVault(raw.vault, method);
      await openAll(key);
      if (remember) { await store("deviceKey", key); remembered = true; changed(); }
      return null;
    } catch (e) { return e.message; }
  },
  lock() { dek = null; values.clear(); broken.clear(); changed(); },
  async forgetDevice() { await store("deviceKey", undefined); remembered = false; changed(); },
  /** Adds a way to unlock (re-proving an existing one). Also how the passphrase is changed. */
  async addMethod(existing, method) {
    try { raw = { ...raw, vault: await addMethod(raw.vault, existing, method) }; await store("settings", raw); changed(); return null; }
    catch (e) { return e.message; }
  },
  async removeMethod(pick) {
    try { raw = { ...raw, vault: removeMethod(raw.vault, pick) }; await store("settings", raw); changed(); return null; }
    catch (e) { return e.message; }
  },
  async resetVault() { // lost every way in: the values are unrecoverable by design
    raw = { mode: raw.mode, rules: raw.rules, secrets: {} };
    dek = null; values.clear(); broken.clear();
    await store("settings", raw); await store("deviceKey", undefined); remembered = false; changed();
  },

  // ---- secrets
  async setSecret(name, { value, hosts, env, headers, anywhere, quota }) {
    const blocked = needUnlocked();
    if (blocked) return blocked;
    const prev = raw.secrets[name];
    const plain = value || values.get(name);
    if (!plain) return "enter the value";
    const { sealed: _s, value: _v, ...prevMeta } = prev || {};
    const meta = { ...prevMeta, hosts, env: env || undefined, headers: headers?.length ? headers : null, anywhere: !!anywhere, quota: quota || undefined };
    const test = validate({ secrets: { [name]: { ...meta, value: plain } } });
    if (!test.secrets[name]) return test.problems.find((p) => p.includes(name)) || "invalid";
    const others = validate({ ...view(), secrets: { ...view().secrets, [name]: { ...meta, value: plain } } });
    if (!others.secrets[name]) return others.problems.find((p) => p.includes(name)) || "invalid";
    // Sealed against its (possibly new) allowlist: the binding is part of the ciphertext.
    const next = { ...meta, sealed: await sealValue(dek, name, test.secrets[name], plain) };
    raw = { ...raw, secrets: { ...raw.secrets, [name]: next } };
    values.set(name, plain); broken.delete(name);
    if (value) quotaLog.delete(name);
    await store("settings", raw); changed(); return null;
  },
  async toggleSecret(name) { raw.secrets[name].off = !raw.secrets[name].off; await store("settings", raw); changed(); },
  async deleteSecret(name) { delete raw.secrets[name]; values.delete(name); broken.delete(name); await store("settings", raw); changed(); },
  async setMode(mode) { raw = { ...raw, mode }; await store("settings", raw); changed(); },
  async setRule(host, action) {
    raw = { ...raw, rules: [...raw.rules.filter((r) => r.host !== host), ...(action ? [{ host, action }] : [])] };
    await store("settings", raw); changed();
  },
  async clearAudit() { audit = []; await store("audit", undefined); changed(); },
  subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
};

// ---------------------------------------------------------------------------
// optional: the bridge browser extension (sites that refuse browser access)

const bridge = (() => {
  const TAG = "__vmNetBridge";
  let version = null, nextId = 1;
  const reqs = new Map();
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    if (e.data[TAG] === "hello") version = e.data.version;
    if (e.data[TAG] !== "from-ext") return;
    const m = e.data.msg, r = reqs.get(m.id);
    if (!r) return;
    if (m.error) { reqs.delete(m.id); const err = Object.assign(new Error(m.error.message), { code: m.error.code }); r.ctl ? r.ctl.error(err) : r.reject(err); }
    else if (m.head) r.resolve(Object.assign(new Response(new ReadableStream({ start: (c) => (r.ctl = c) }), m.head), { bridged: true }));
    else if (m.chunk) r.ctl?.enqueue(unb64(m.chunk));
    else if (m.end) { reqs.delete(m.id); r.ctl?.close(); }
  });
  window.postMessage({ [TAG]: "to-ext", ping: true }, location.origin);
  return {
    get available() { return !!version; },
    fetch(url, init) {
      const id = `g${nextId++}`;
      const p = new Promise((resolve, reject) => reqs.set(id, { resolve, reject }));
      window.postMessage({ [TAG]: "to-ext", msg: { id, url, method: init.method, headers: init.headers, body: init.body ? b64(init.body) : undefined } }, location.origin);
      return p;
    },
  };
})();

// ---------------------------------------------------------------------------
// the proxy

async function handle(m, reply) {
  const fail = (code, message) => { reply({ id: m.id, error: { code, message } }); return null; };
  let url;
  try { url = new URL(m.url); } catch { return fail("refused", "invalid URL"); }
  const host = url.hostname.toLowerCase();
  const base = { method: m.method, host, path: url.pathname };

  const why = refuseDestination(url);
  if (why) { record({ ...base, verdict: "DENY-LOCAL" }); return fail("refused", `${host}: ${why}`); }

  const decision = decide(cfg, host);
  const s = seen.get(host) || { count: 0 };
  seen.set(host, { count: s.count + 1, decision, last: Date.now() });
  if (decision === "deny") {
    record({ ...base, verdict: "DENY-POLICY" });
    if (s.count === 0) notify({ kind: "refused", host });
    return fail("denied", `${host} is not on this VM's network allowlist.`);
  }

  const a = applySecrets(cfg, { url: m.url, headers: m.headers, body: m.body || null });
  if (a.refuse) { record({ ...base, verdict: a.code === "locked" ? "DENY-LOCKED" : "DENY-SECRET" }); return fail(a.code || "refused", a.refuse); }
  if (a.leaks.length) {
    record({ ...base, verdict: "LEAK-SUSPECT", leaks: a.leaks });
    const fresh = a.leaks.filter((n) => !leakedTo.has(`${n} ${host}`));
    if (fresh.length) { fresh.forEach((n) => leakedTo.add(`${n} ${host}`)); notify({ kind: "leak", host, names: fresh }); }
  }
  for (const name of a.substituted) {
    const log = quotaLog.get(name) || (quotaLog.set(name, []), quotaLog.get(name));
    const over = quotaCheck(log, cfg.secrets[name].quota);
    if (over) {
      record({ ...base, verdict: "DENY-QUOTA", substituted: [name] });
      if (log.over !== true) { log.over = true; notify({ kind: "quota", host, names: [name] }); }
      return fail("quota", `secret ${name} is ${over}`);
    }
    if (!usedWith.has(`${name} ${host}`)) { usedWith.add(`${name} ${host}`); notify({ kind: "first-use", host, names: [name] }); }
  }

  const carries = a.substituted.length > 0;
  const init = {
    method: m.method,
    headers: forwardHeaders(a.headers, carries),
    body: a.body && !["GET", "HEAD"].includes(m.method) ? a.body : undefined,
    credentials: "omit",
    // fetch() follows redirects by itself, carrying custom headers along; a
    // secret must never ride a redirect to wherever it points.
    redirect: carries ? "manual" : "follow",
  };

  let resp;
  try {
    resp = await fetch(a.url, init);
  } catch (e) {
    if (!bridge.available || !["GET", "HEAD"].includes(m.method)) {
      record({ ...base, verdict: decision === "learn" ? "LEARN" : "ALLOW", substituted: a.substituted, status: "CORS/network error" });
      return fail("network", e.message);
    }
    try { resp = await bridge.fetch(a.url, init); }
    catch (be) { record({ ...base, verdict: "BRIDGE", status: be.code || "error" }); return fail(be.code === "not-approved" ? "bridge-not-approved" : "network", be.message); }
  }
  if (resp.type === "opaqueredirect") {
    record({ ...base, verdict: "DENY-REDIRECT", substituted: a.substituted });
    return fail("refused", `${host} answered with a redirect; it is not followed while a secret is attached`);
  }
  record({ ...base, verdict: decision === "learn" ? "LEARN" : resp.bridged ? "BRIDGE" : "ALLOW", substituted: a.substituted, status: resp.status });

  const scrub = makeScrubber(cfg);
  reply({ id: m.id, head: { status: resp.status, statusText: resp.statusText, headers: [...resp.headers].map(([k, v]) => [k, scrub.headerValue(v)]), url: resp.url, redirected: resp.redirected } });
  const reader = resp.body?.getReader();
  try {
    for (;;) {
      const { value, done } = reader ? await reader.read() : { done: true };
      if (done) break;
      const out = scrub.push(value);
      if (out.length) reply({ id: m.id, chunk: out }, [out.buffer]);
    }
    const last = scrub.flush();
    if (last.length) reply({ id: m.id, chunk: last }, [last.buffer]);
    reply({ id: m.id, end: true });
  } catch (e) {
    fail("network", e.message);
  }
}

// ---------------------------------------------------------------------------
// roles

const framed = window.top !== window;
const referrerOrigin = (() => { try { return new URL(document.referrer).origin; } catch { return null; } })();

if (framed && !embedderOrigins().includes(referrerOrigin)) {
  // Embedded by a page that isn't our IDE: show nothing, do nothing. (A static
  // host can't send frame-ancestors; the postMessage origin check below is the
  // real control, this just keeps the page inert.)
  document.body.replaceChildren();
} else if (framed) {
  // The proxy. Only an IDE origin we were configured for may connect.
  let port = null;
  addEventListener("message", (e) => {
    if (!e.data?.gateInit || !embedderOrigins().includes(e.origin) || !e.ports[0]) return;
    port = e.ports[0];
    const reply = (msg, transfer) => port.postMessage(msg, transfer || []);
    notify = (notice) => reply({ notice });
    port.onmessage = (ev) => {
      const m = ev.data;
      if (m.ui === "show") return showCard(m.text);
      if (m.id) handle(m, reply).catch((err) => reply({ id: m.id, error: { code: "internal", message: String(err) } }));
    };
    const publish = () => reply({ secrets: Object.entries(cfg.secrets).filter(([, s]) => s.env).map(([name, s]) => ({ name, env: s.env })) });
    api.subscribe(publish);
    reply({ ready: true });
    publish();
  });
  window.__gate = api;

  // A small card the IDE can ask us to show. Settings open in a separate
  // top-level window: a framed page can be overlaid and clickjacked, so the
  // framed gate never takes a decision from a click; it only opens the popup.
  const card = document.getElementById("card");
  const hide = () => { card.hidden = true; parent.postMessage({ gateUI: "hide" }, "*"); };
  function showCard(text) {
    document.getElementById("card-text").textContent = text || "Secrets and network access for this VM.";
    card.hidden = false;
  }
  let popup = null;
  document.getElementById("open").onclick = () => {
    if (popup && !popup.closed) popup.focus();
    // An unguessable window name: a named window can be navigated by any page
    // in this browsing-context group that knows the name.
    else popup = window.open(`${location.pathname}#manage`, `gate-${crypto.randomUUID()}`, "popup,width=780,height=860");
    hide();
  };
  document.getElementById("dismiss").onclick = hide;

  Promise.all([load("settings"), load("audit"), load("deviceKey")]).then(async ([settings, savedAudit, key]) => {
    if (settings) raw = { ...raw, ...settings };
    if (Array.isArray(savedAudit)) audit = savedAudit;
    // Values from an earlier, unencrypted version stay usable until a vault seals them.
    for (const [name, s] of Object.entries(raw.secrets)) if (s.value) values.set(name, s.value);
    changed();
    if (raw.vault && key) { remembered = true; await openAll(key); }
  });
} else if (location.hash === "#manage" && window.opener?.__gate) {
  import("./manage.js").then((m) => m.render(window.opener.__gate));
} else {
  document.getElementById("standalone").hidden = false;
}
