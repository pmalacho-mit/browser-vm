// Unit tests for the gate's decisions (web/gate/core.js). `npm run test:gate`
import assert from "node:assert/strict";
import { createVault, unlockVault, addMethod, removeMethod, methodsOf, sealValue, openValue } from "../web/gate/vault.ts";
import { validate, decide, applySecrets, makeScrubber, hostPatternProblem, hostMatches, refuseDestination, forwardHeaders, quotaCheck } from "../web/gate/core.ts";

const enc = new TextEncoder(), dec = new TextDecoder();
let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${/** @type {Error} */ (e).message}`); } };

const cfg = validate({
  mode: "enforce",
  rules: [{ host: "api.openai.com", action: "allow" }, { host: "*.evil.com", action: "deny" }],
  secrets: {
    "GATE-OPENAI-KEY": { value: "sk-real-openai-123", hosts: ["api.openai.com"], env: "OPENAI_API_KEY" },
    "GATE-HOOK-TOKEN": { value: "hook-real-456789", hosts: ["*.hooks.example.com"], anywhere: true },
    "GATE-GH-TOKEN": { value: "ghp_real_abcdef", hosts: ["api.github.com"], headers: ["authorization"] },
  },
});
/** @param {string} url @param {[string, string][]} [headers] @param {string | null} [body] */
const req = (url, headers = [], body = null) => ({ url, headers, body: body ? enc.encode(body) : null });
const hdr = (r, k) => r.headers.find(([n]) => n === k)?.[1];

test("valid config keeps all three secrets", () => assert.deepEqual(Object.keys(cfg.secrets).sort(), ["GATE-GH-TOKEN", "GATE-HOOK-TOKEN", "GATE-OPENAI-KEY"]));

test("host patterns must pin a destination", () => {
  for (const bad of ["*", "*.com", "*openai.com", "com", "api.*.com", "https://api.x.com"]) assert.ok(hostPatternProblem(bad), bad);
  for (const good of ["api.openai.com", "*.openai.com"]) assert.equal(hostPatternProblem(good), null, good);
  assert.ok(hostMatches("*.openai.com", "api.openai.com"));
  assert.ok(!hostMatches("*.openai.com", "evilopenai.com"));
  assert.ok(!hostMatches("*.openai.com", "a.b.openai.com"));
  assert.ok(!hostMatches("*.openai.com", "openai.com"));
});

test("invalid secrets are dropped, not widened", () => {
  const v = validate({ secrets: {
    "GATE-WILD": { value: "abcdefgh123", hosts: ["*"] },
    "GATE-NOHOSTS": { value: "abcdefgh123", hosts: [] },
    "GATE-KEY": { value: "abcdefgh123", hosts: ["a.example.com"] },
    "GATE-KEY2": { value: "abcdefgh456", hosts: ["a.example.com"] },
    "GATE-BADHDR": { value: "abcdefgh123", hosts: ["a.example.com"], headers: [] },
  } });
  assert.deepEqual(Object.keys(v.secrets), []);
  assert.equal(v.problems.length, 4); // KEY + KEY2 are one problem (both dropped)
});

test("network policy: rules first, then mode", () => {
  assert.equal(decide(cfg, "api.openai.com"), "allow");
  assert.equal(decide(cfg, "x.evil.com"), "deny");
  assert.equal(decide(cfg, "pypi.org"), "deny");
  assert.equal(decide({ ...cfg, mode: "learn" }, "pypi.org"), "learn");
  assert.equal(decide({ ...cfg, mode: "open" }, "pypi.org"), "allow");
});

test("local destinations are refused", () => {
  for (const u of ["http://localhost/", "https://192.168.1.1/", "https://router.local/", "https://[::1]/", "https://intranet/", "file:///etc/passwd"])
    assert.ok(refuseDestination(new URL(u)), u);
  assert.equal(refuseDestination(new URL("https://api.openai.com/v1")), null);
});

test("substituted in headers toward its host", () => {
  const r = applySecrets(cfg, req("https://api.openai.com/v1/chat", [["Authorization", "Bearer GATE-OPENAI-KEY"]]));
  assert.equal(hdr(r, "authorization"), "Bearer sk-real-openai-123");
  assert.deepEqual(r.substituted, ["GATE-OPENAI-KEY"]);
});

test("NOT substituted in a body by default (an LLM could hand it back transformed)", () => {
  const r = applySecrets(cfg, req("https://api.openai.com/v1/chat", [["Authorization", "Bearer GATE-OPENAI-KEY"]], '{"prompt":"reverse GATE-OPENAI-KEY"}'));
  assert.equal(dec.decode(r.body ?? undefined), '{"prompt":"reverse GATE-OPENAI-KEY"}');
  assert.equal(hdr(r, "authorization"), "Bearer sk-real-openai-123");
});

test("toward any other host: sent as written, reported as a leak suspect", () => {
  const r = applySecrets(cfg, req("https://attacker.example.net/", [["Authorization", "Bearer GATE-OPENAI-KEY"]]));
  assert.equal(hdr(r, "authorization"), "Bearer GATE-OPENAI-KEY");
  assert.deepEqual(r.leaks, ["GATE-OPENAI-KEY"]);
});

test("look-alike hosts don't match", () => {
  for (const u of ["https://api.openai.com.evil.net/", "https://xapi.openai.com/", "https://evil.net/api.openai.com"]) {
    const r = applySecrets(cfg, req(u, [["Authorization", "Bearer GATE-OPENAI-KEY"]]));
    assert.equal(hdr(r, "authorization"), "Bearer GATE-OPENAI-KEY", u);
  }
});

test("never over plaintext toward its host", () => {
  assert.ok(applySecrets(cfg, req("http://api.openai.com/", [["Authorization", "Bearer GATE-OPENAI-KEY"]])).refuse);
});

test("header-confined secret: only the named header", () => {
  const r = applySecrets(cfg, req("https://api.github.com/user", [["Authorization", "token GATE-GH-TOKEN"], ["X-Note", "GATE-GH-TOKEN"]]));
  assert.equal(hdr(r, "authorization"), "token ghp_real_abcdef");
  assert.equal(hdr(r, "x-note"), "GATE-GH-TOKEN");
});

test("anywhere: true substitutes URL and body too", () => {
  const r = applySecrets(cfg, req("https://in.hooks.example.com/t/GATE-HOOK-TOKEN", [], "token=GATE-HOOK-TOKEN"));
  assert.equal(r.url, "https://in.hooks.example.com/t/hook-real-456789");
  assert.equal(dec.decode(r.body ?? undefined), "token=hook-real-456789");
});

test("switched off: refused toward its host", () => {
  const off = validate({ secrets: { "GATE-OPENAI-KEY": { value: "sk-real-openai-123", hosts: ["api.openai.com"], off: true } } });
  assert.match(String(applySecrets(off, req("https://api.openai.com/", [["Authorization", "Bearer GATE-OPENAI-KEY"]])).refuse), /off/);
  const expired = validate({ secrets: { "GATE-OPENAI-KEY": { value: "sk-real-openai-123", hosts: ["api.openai.com"], until: 1000 } } });
  assert.match(String(applySecrets(expired, req("https://api.openai.com/", [["Authorization", "Bearer GATE-OPENAI-KEY"]]), 2000).refuse), /off/);
});

test("scrubber turns an echoed value back into its placeholder, across chunk boundaries", () => {
  const s = makeScrubber(cfg);
  const text = '{"echo":"Bearer sk-real-openai-123","n":1}';
  let out = "";
  for (let i = 0; i < text.length; i += 5) out += dec.decode(s.push(enc.encode(text.slice(i, i + 5))));
  out += dec.decode(s.flush());
  assert.equal(out, '{"echo":"Bearer GATE-OPENAI-KEY","n":1}');
  assert.equal(s.headerValue("x sk-real-openai-123"), "x GATE-OPENAI-KEY");
});

test("forwarded headers: minimal unless the request carries a secret", () => {
  /** @type {[string, string][]} */
  const h = [["content-type", "application/json"], ["x-api-key", "k"], ["cookie", "c"], ["authorization", "a"], ["anthropic-version", "1"]];
  assert.deepEqual(forwardHeaders(h, false).map(([k]) => k), ["content-type", "authorization"]);
  assert.deepEqual(forwardHeaders(h, true).map(([k]) => k), ["content-type", "x-api-key", "authorization", "anthropic-version"]);
});

test("locked secret: kept (env still exported), refused toward its host, not a value anywhere", () => {
  const v = validate({ secrets: { "GATE-OPENAI-KEY": { locked: true, hosts: ["api.openai.com"], env: "OPENAI_API_KEY" } } });
  assert.ok(v.secrets["GATE-OPENAI-KEY"]);
  const r = applySecrets(v, req("https://api.openai.com/", [["Authorization", "Bearer GATE-OPENAI-KEY"]]));
  assert.equal(r.code, "locked");
  const other = applySecrets(v, req("https://elsewhere.example.com/", [["Authorization", "Bearer GATE-OPENAI-KEY"]]));
  assert.deepEqual(other.leaks, ["GATE-OPENAI-KEY"]);
  const s = makeScrubber(v);
  assert.equal(new TextDecoder().decode(s.push(new TextEncoder().encode("abc"))) + new TextDecoder().decode(s.flush()), "abc");
});

test("quota: sliding window, refuses the (max+1)th use", () => {
  const log = [], q = { max: 3, perHours: 1 };
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 3; i++) assert.equal(quotaCheck(log, q, t0 + i * 1000), null);
  assert.match(String(quotaCheck(log, q, t0 + 5000)), /over its quota/);
  assert.equal(quotaCheck(log, q, t0 + 3_600_001), null); // the first use aged out
  assert.equal(quotaCheck([], null, t0), null);
  assert.ok(!validate({ secrets: { "GATE-X-KEY": { value: "abcdefgh123", hosts: ["a.example.com"], quota: { max: 0, perHours: 1 } } } }).secrets["GATE-X-KEY"]);
});

// ---- vault (async) ----
const atest = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${/** @type {Error} */ (e).message}`); } };
const secret = { hosts: ["api.openai.com"], headers: null, anywhere: false };
const prf = globalThis.crypto.getRandomValues(new Uint8Array(32)); // what an authenticator's PRF extension would return
const prfSalt = globalThis.crypto.getRandomValues(new Uint8Array(32));
const cred = { id: "Y3JlZC0x", transports: ["internal"], label: "Touch ID" };
const { header, dek } = await createVault({ passphrase: "correct horse battery" });
await atest("vault: seal + open round trip; stored header holds no key material in the clear", async () => {
  const sealed = await sealValue(dek, "GATE-OPENAI-KEY", secret, "sk-real-openai-123");
  assert.ok(!JSON.stringify({ header, sealed }).includes("sk-real"));
  assert.equal(await openValue(dek, "GATE-OPENAI-KEY", { ...secret, sealed }), "sk-real-openai-123");
});
await atest("vault: the data key is not extractable once unlocked", async () => {
  const k = await unlockVault(header, { passphrase: "correct horse battery" });
  await assert.rejects(globalThis.crypto.subtle.exportKey("raw", k));
});
await atest("vault: wrong passphrase is refused", async () => {
  await assert.rejects(unlockVault(header, { passphrase: "wrong horse battery" }), /wrong passphrase/);
});
await atest("vault: short passphrases are refused", async () => {
  await assert.rejects(createVault({ passphrase: "short" }), /at least/);
});
await atest("vault: editing the allowlist in storage breaks decryption (no redirect)", async () => {
  const sealed = await sealValue(dek, "GATE-OPENAI-KEY", secret, "sk-real-openai-123");
  await assert.rejects(openValue(dek, "GATE-OPENAI-KEY", { ...secret, hosts: ["evil.example.com"], sealed }), /could not decrypt/);
  await assert.rejects(openValue(dek, "GATE-OPENAI-KEY", { ...secret, anywhere: true, sealed }), /could not decrypt/);
  await assert.rejects(openValue(dek, "GATE-OTHER-KEY", { ...secret, sealed }), /could not decrypt/);
});
let h2;
await atest("vault: a passkey can be added as a second way in; both open the same values", async () => {
  const sealed = await sealValue(dek, "GATE-OPENAI-KEY", secret, "sk-real-openai-123");
  await assert.rejects(addMethod(header, { passphrase: "wrong horse battery" }, { prfBytes: prf, prfSalt, credential: cred }), /wrong passphrase/);
  h2 = await addMethod(header, { passphrase: "correct horse battery" }, { prfBytes: prf, prfSalt, credential: cred });
  assert.deepEqual(methodsOf(h2).map((m) => m.type), ["passphrase", "passkey"]);
  const kA = await unlockVault(h2, { passphrase: "correct horse battery" });
  const kB = await unlockVault(h2, { prfBytes: prf, credentialId: cred.id });
  assert.equal(await openValue(kA, "GATE-OPENAI-KEY", { ...secret, sealed }), "sk-real-openai-123");
  assert.equal(await openValue(kB, "GATE-OPENAI-KEY", { ...secret, sealed }), "sk-real-openai-123");
});
await atest("vault: a different PRF output (other passkey, or a fake) is refused", async () => {
  const other = globalThis.crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(unlockVault(h2, { prfBytes: other, credentialId: cred.id }), /doesn't open/);
  await assert.rejects(unlockVault(h2, { prfBytes: prf, credentialId: "someone-else" }), /doesn't open/);
});
await atest("vault: the passphrase can be dropped, leaving passkey-only; the last method can't be removed", async () => {
  const h3 = removeMethod(h2, { type: "passphrase" });
  assert.deepEqual(methodsOf(h3).map((m) => m.type), ["passkey"]);
  await assert.rejects(unlockVault(h3, { passphrase: "correct horse battery" }), /wrong passphrase/);
  assert.ok(await unlockVault(h3, { prfBytes: prf }));
  assert.throws(() => removeMethod(h3, { type: "passkey", credentialId: cred.id }), /at least one/);
});
await atest("vault: changing the passphrase keeps every value readable (same data key)", async () => {
  const sealed = await sealValue(dek, "GATE-OPENAI-KEY", secret, "sk-real-openai-123");
  const h4 = await addMethod(h2, { passphrase: "correct horse battery" }, { passphrase: "a new long passphrase" });
  assert.equal(methodsOf(h4).filter((m) => m.type === "passphrase").length, 1);
  await assert.rejects(unlockVault(h4, { passphrase: "correct horse battery" }), /wrong passphrase/);
  assert.equal(await openValue(await unlockVault(h4, { passphrase: "a new long passphrase" }), "GATE-OPENAI-KEY", { ...secret, sealed }), "sk-real-openai-123");
});
await atest("vault: a v1 header (passphrase only) still opens", async () => {
  const first = /** @type {import("../web/gate/vault.ts").PassphraseWrap} */ (header.wraps[0]);
  /** @type {import("../web/gate/vault.ts").VaultHeaderV1} */
  const v1 = { v: 1, kdf: first.kdf, wrapped: first.wrapped };
  assert.ok(await unlockVault(v1, { passphrase: "correct horse battery" }));
});

process.exitCode = failed ? 1 : 0;
