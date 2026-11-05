// Encryption at rest for secret values (WebCrypto only; no DOM or storage, so
// it is unit-tested in Node by scripts/gate-test.mjs).
//
//   one random 256-bit data key (DEK) encrypts every value (AES-GCM, fresh IV each)
//   the DEK is stored WRAPPED, once per unlock method ("wrap"):
//     passphrase ──PBKDF2-SHA256, 600k iterations, random salt──► KEK ──AES-GCM──► wrapped DEK
//     passkey    ──WebAuthn PRF output (32 bytes, only the authenticator can
//                  produce it, after user verification) ──HKDF──► KEK ──AES-GCM──► wrapped DEK
//   Any wrap opens the vault; adding or removing a method never re-encrypts a value.
//
// Each value is encrypted with additional authenticated data (AAD) naming the
// secret AND everything that decides where it may be sent (hosts, headers,
// anywhere). Editing an allowlist in storage, or moving a ciphertext under
// another placeholder, makes decryption fail instead of redirecting the value.
//
// What is NOT encrypted: placeholder names, env names, hosts, network rules.
// They aren't secret, and keeping them readable lets the VM keep its
// placeholders and network while the vault is locked.
//
// The WebAuthn calls themselves live in manage.js (they need a top-level
// window and a user gesture); this module only turns the PRF bytes into a key.

const subtle = globalThis.crypto.subtle;

/** base64 IV + ciphertext. */
export interface Sealed { iv: string; ct: string }
export interface Kdf { name: "PBKDF2"; hash: string; iterations: number; salt: string }
/** What a passkey wrap remembers about its credential (no secret in it). */
export interface PasskeyCredential { id: string; transports: string[]; label: string; created?: number }
export interface PassphraseWrap { type: "passphrase"; kdf: Kdf; wrapped: Sealed }
export interface PasskeyWrap { type: "passkey"; credential: PasskeyCredential; prfSalt: string; hkdfSalt: string; created: number; wrapped: Sealed }
export type Wrap = PassphraseWrap | PasskeyWrap;
/** Stored vault header: the data key, wrapped once per unlock method. */
export interface VaultHeader { v: 2; wraps: Wrap[] }
/** The first format: a single passphrase wrap. Still readable. */
export interface VaultHeaderV1 { v: 1; kdf: Kdf; wrapped: Sealed }
/** A header as found in storage: either format. */
export type StoredHeader = VaultHeader | VaultHeaderV1;
/** Proof for opening the vault. */
export type UnlockMethod =
  | { passphrase: string }
  | { passphrase?: undefined; prfBytes: BufferSource; credentialId?: string };
/** A new way to unlock. */
export type NewMethod =
  | { passphrase: string }
  | { passphrase?: undefined; prfBytes: BufferSource; prfSalt: Uint8Array; credential: PasskeyCredential };
/** Which method to remove. */
export type MethodRef = { type: "passphrase" } | { type: "passkey"; credentialId: string };
/** The parts of a secret that bind its ciphertext (see bindingOf). */
export interface Binding { hosts?: string[]; headers?: string[] | null; anywhere?: boolean }
const enc = new TextEncoder(), dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 600_000; // OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256
export const MIN_PASSPHRASE = 10;

const b64 = (buf: ArrayBuffer | Uint8Array) => { const u8 = new Uint8Array(buf); let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const toB64 = b64, fromB64 = unb64;

// ---- key-encryption keys, one per method ------------------------------------

async function kekFromPassphrase(passphrase: string, kdf: Kdf) {
  const base = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: kdf.hash, salt: unb64(kdf.salt), iterations: kdf.iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

async function kekFromPrf(prfBytes: BufferSource, wrap: { hkdfSalt: string }) {
  // (No instanceof: the bytes may come from another window, i.e. another JS realm.)
  const bytes = ArrayBuffer.isView(prfBytes) ? new Uint8Array(prfBytes.buffer, prfBytes.byteOffset, prfBytes.byteLength) : new Uint8Array(prfBytes);
  if (bytes.length < 32) throw new Error("PRF output must be at least 32 bytes");
  const base = await subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: unb64(wrap.hkdfSalt), info: enc.encode("browser-vm gate vault v2") },
    base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

const checkPassphrase = (p: unknown) => {
  if (typeof p !== "string" || p.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
};

async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<Sealed> {
  const iv = random(12);
  return { iv: b64(iv), ct: b64(await subtle.wrapKey("raw", dek, kek, { name: "AES-GCM", iv })) };
}
async function unwrapDek(wrapped: Sealed, kek: CryptoKey, extractable: boolean) {
  return subtle.unwrapKey("raw", unb64(wrapped.ct), kek, { name: "AES-GCM", iv: unb64(wrapped.iv) },
    { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
}

/** A wrap entry for a passphrase. `dek` must be extractable (see withExtractable). */
export async function passphraseWrap(dek: CryptoKey, passphrase: string): Promise<PassphraseWrap> {
  checkPassphrase(passphrase);
  const kdf: Kdf = { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: b64(random(16)) };
  return { type: "passphrase", kdf, wrapped: await wrapDek(dek, await kekFromPassphrase(passphrase, kdf)) };
}

/**
 * A wrap entry for a passkey. `prfBytes` is the authenticator's PRF output for
 * `prfSalt` (manage.js obtains it); `credential` is { id (base64url), transports, label }.
 */
export async function passkeyWrap(dek: CryptoKey, prfBytes: BufferSource, prfSalt: Uint8Array, credential: PasskeyCredential): Promise<PasskeyWrap> {
  const wrap = { type: "passkey" as const, credential, prfSalt: b64(prfSalt), hkdfSalt: b64(random(32)), created: Date.now() };
  return { ...wrap, wrapped: await wrapDek(dek, await kekFromPrf(prfBytes, wrap)) };
}

// ---- the vault header -------------------------------------------------------

export const newDek = () => subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

/** The same key, extractable or not. Everything outside this module holds the non-extractable one. */
export async function withExtractable(key: CryptoKey, extractable: boolean) {
  return subtle.importKey("raw", await subtle.exportKey("raw", key), "AES-GCM", extractable, ["encrypt", "decrypt"]);
}

/** New vault with one unlock method: { passphrase } or { prfBytes, prfSalt, credential }. Returns { header, dek }. */
export async function createVault(method: NewMethod): Promise<{ header: VaultHeader; dek: CryptoKey }> {
  const dek = await newDek();
  const wrap = method.passphrase != null
    ? await passphraseWrap(dek, method.passphrase)
    : await passkeyWrap(dek, method.prfBytes, method.prfSalt, method.credential);
  return { header: { v: 2, wraps: [wrap] }, dek: await withExtractable(dek, false) };
}

/** Reads a v1 header (single passphrase wrap) as v2. */
export const upgradeHeader = (h: StoredHeader | undefined): VaultHeader | undefined => (h?.v === 1 ? { v: 2, wraps: [{ type: "passphrase", kdf: h.kdf, wrapped: h.wrapped }] } : h);

export const methodsOf = (header: StoredHeader | undefined) => upgradeHeader(header)?.wraps?.map((w) => w.type === "passkey"
  ? { type: w.type, credential: w.credential, prfSalt: w.prfSalt, created: w.created }
  : { type: w.type, credential: undefined, prfSalt: undefined, created: undefined }) ?? [];

/**
 * Opens the vault with one method. Throws "wrong passphrase" / "this passkey
 * doesn't open the vault". `extractable: true` only for re-wrapping.
 */
export async function unlockVault(stored: StoredHeader | undefined, method: UnlockMethod, { extractable = false } = {}): Promise<CryptoKey> {
  const header = upgradeHeader(stored);
  if (header?.v !== 2) throw new Error("unknown vault format");
  if (method.passphrase != null) {
    for (const w of header.wraps.filter((w): w is PassphraseWrap => w.type === "passphrase")) {
      try { return await unwrapDek(w.wrapped, await kekFromPassphrase(method.passphrase, w.kdf), extractable); } catch {}
    }
    throw new Error("wrong passphrase");
  }
  const wraps = header.wraps.filter((w): w is PasskeyWrap => w.type === "passkey" && (!method.credentialId || w.credential.id === method.credentialId));
  for (const w of wraps) {
    try { return await unwrapDek(w.wrapped, await kekFromPrf(method.prfBytes, w), extractable); } catch {}
  }
  throw new Error("this passkey doesn't open the vault");
}

/**
 * Header with one more unlock method. The data key in memory is never
 * extractable, so adding a method re-proves an existing one (`existing`):
 * "confirm your passphrase (or tap your passkey) to add this".
 */
export async function addMethod(stored: StoredHeader | undefined, existing: UnlockMethod, method: NewMethod): Promise<VaultHeader> {
  const header = upgradeHeader(stored)!;
  const x = await unlockVault(header, existing, { extractable: true });
  const wrap = method.passphrase != null
    ? await passphraseWrap(x, method.passphrase)
    : await passkeyWrap(x, method.prfBytes, method.prfSalt, method.credential);
  const wraps = header.wraps.filter((w) => !(w.type === "passphrase" && wrap.type === "passphrase")); // one passphrase at most
  return { v: 2, wraps: [...wraps, wrap] };
}

/** Header without one method. Refuses to remove the last one. */
export function removeMethod(stored: StoredHeader | undefined, pick: MethodRef): VaultHeader {
  const header = upgradeHeader(stored)!;
  const wraps = header.wraps.filter((w) => !(pick.type === w.type && (w.type === "passphrase" || (pick.type === "passkey" && w.credential.id === pick.credentialId))));
  if (!wraps.length) throw new Error("the vault needs at least one way to unlock it");
  return { v: 2, wraps };
}

// ---- values -------------------------------------------------------------------

/** The AAD: the placeholder and everything that decides where its value may go. */
export const bindingOf = (name: string, s: Binding) => enc.encode(JSON.stringify([
  name, [...(s.hosts || [])].map((h) => h.toLowerCase()).sort(), s.headers ? [...s.headers].map((h) => h.toLowerCase()).sort() : null, !!s.anywhere,
]));

export async function sealValue(dek: CryptoKey, name: string, secret: Binding, value: string): Promise<Sealed> {
  const iv = random(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: bindingOf(name, secret) }, dek, enc.encode(value));
  return { iv: b64(iv), ct: b64(ct) };
}

/** Throws if the ciphertext or anything in its binding was changed. */
export async function openValue(dek: CryptoKey, name: string, secret: Binding & { sealed: Sealed }): Promise<string> {
  try {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(secret.sealed.iv), additionalData: bindingOf(name, secret) }, dek, unb64(secret.sealed.ct));
    return dec.decode(pt);
  } catch {
    throw new Error(`${name}: could not decrypt (its stored allowlist or ciphertext was changed); re-enter the value`);
  }
}
