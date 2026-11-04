// Passkeys for the vault, via the WebAuthn PRF extension.
//
// A passkey normally signs challenges for a server. Here there is no server;
// what we use is the PRF extension: the authenticator derives 32 bytes from a
// salt and a secret it never reveals, after verifying the user (Touch ID,
// Windows Hello, a phone's screen lock). Those bytes become the vault key.
//
// Why this suits non-technical users better than a passphrase:
//   * nothing to remember or to type into a possibly fake dialog: the prompt is
//     the operating system's, which a web page cannot imitate;
//   * the credential is bound to THIS origin's hostname (rpId). A page on any
//     other origin, including the IDE's, cannot ask the authenticator for it;
//   * the PRF output has full entropy, so a copy of the stored vault can't be
//     brute-forced the way a weak passphrase could.
//
// Must run in a top-level window from a user gesture (the settings popup).
import { random } from "./vault.js";

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const rpId = () => location.hostname; // the gate's own host, never the registrable domain

export const passkeysSupported = () => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.create;

const prfOf = (cred) => {
  const r = cred.getClientExtensionResults().prf?.results?.first;
  return r ? new Uint8Array(r) : null;
};

/**
 * Registers a new passkey and obtains its PRF output. Returns
 * { credential: { id, transports, label, created }, prfSalt, prfBytes }.
 * Two prompts: one to create, one to evaluate the PRF (some platforms only
 * evaluate it during an assertion).
 */
export async function createPasskey({ rpName, label, exclude = [], prfSalt = random(32) }) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: random(32), // nobody verifies the signature; the PRF is what matters
    rp: { id: rpId(), name: rpName },
    user: { id: random(16), name: `${label} · ${new Date().toLocaleDateString()}`, displayName: label },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: exclude.map((c) => ({ type: "public-key", id: unb64url(c.id), transports: c.transports })),
    extensions: { prf: {} },
  } });
  if (!cred.getClientExtensionResults().prf?.enabled) throw new Error("this passkey provider doesn't support the PRF extension; use a passphrase instead");
  const credential = { id: b64url(cred.rawId), transports: cred.response.getTransports?.() ?? [], label, created: Date.now() };
  const { prfBytes } = await assertPasskey({ credentials: [{ ...credential, prfSalt: b64url(prfSalt) }] });
  return { credential, prfSalt, prfBytes };
}

/**
 * Unlock prompt. `credentials` are the vault's passkey wraps' { id, transports, prfSalt }.
 * Returns { credentialId, prfBytes }.
 */
export async function assertPasskey({ credentials }) {
  const salts = Object.fromEntries(credentials.map((c) => [c.id, { first: unb64url(c.prfSalt) }]));
  const single = credentials.length === 1;
  const a = await navigator.credentials.get({ publicKey: {
    challenge: random(32),
    rpId: rpId(),
    userVerification: "required",
    allowCredentials: credentials.map((c) => ({ type: "public-key", id: unb64url(c.id), transports: c.transports })),
    extensions: { prf: single ? { eval: salts[credentials[0].id] } : { evalByCredential: salts } },
  } });
  const prfBytes = prfOf(a);
  if (!prfBytes) throw new Error("the passkey didn't return a PRF value");
  return { credentialId: b64url(a.rawId), prfBytes };
}
