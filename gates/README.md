# Gates: the VM's only way out

The runtime never reaches the network for the guest itself. It is given a
`Gate` (`../runtime/src/gate.ts`) and sends every guest HTTP(S) request
through it. A gate decides what leaves, and may swap secret placeholders for
real values on the way. No gate, no network.

```ts
interface Gate {
  fetch: FetchLike;                 // one guest request; reject with a GuestError (guestMessage) to refuse
  connect?(hooks: GateHooks): void; // tell the runtime about notices and secret placeholders
  show?(text: string): void;        // show the gate's own UI, if it has one
}
```

| Package | What it is | Where it runs | Secrets | Used by |
|---|---|---|---|---|
| `core/` (`@browser-vm/gate-core`) | the policy engine: site rules, placeholders, scrubbing, the default policy. Not a gate itself; no I/O | anywhere | | both gates |
| `web/` (`@browser-vm/gate-web`) | the browser gate | its own web origin, in a hidden iframe | an encrypted vault in that origin | browser apps (`gate: "web"`) |
| `node/` (`@browser-vm/gate-node`) | a policy gate: core rules, nothing else | in-process | none | the MCP server, tests |

An app picks its gate (`gate: "web"` or `"none"`, `../apps/`). The runtime
frame (`../host/`) gives the runtime the web gate's client; the MCP server
makes a node gate from its `--allow` flags.

**Writing a gate.** Implement `Gate` and hand it to `new Runtime({ gate })`.
In a browser it must run on its own origin, because the runtime frame can't
reach the network (and shouldn't: the gate is what holds secrets the page and
the VM can't read). The web gate shows the shape: a client that implements
`Gate` in the runtime worker, a relay on the page, and the gate app itself on
the other origin.

## The web gate (`web/`)

```
web/
  app/            the gate app, served on the gate origin (dist/<app>/gate/): gate.ts (the proxy),
                  manage.ts (settings popup), vault.ts + webauthn.ts (encryption), config.ts (who may embed it)
  src/client.ts   WebGateClient: the Gate the runtime worker uses (BroadcastChannel to the page)
  src/relay.ts    on the page (site/host/gate-relay.js): embeds the gate app, relays both ways
  src/protocol.ts the messages between the three
  bridge-extension/  the optional Chrome extension (below)
  build.mjs       its part of an app build
  test/           gate-test.mjs: core rules and the vault, under Node (npm run test:gate)
```


Every request from the VM goes through the web gate, a small app on its own
origin (`gate.localhost:8080` locally, `gate.example.com` in production),
embedded in the page as a hidden iframe. Secrets live only there. It follows the design of
desolate's mitmproxy addon (placeholders substituted in flight, per-secret host
allowlists, leak-suspect auditing, response scrubbing), with the browser
supplying the isolation:

```
VM ─► net.ts ─► WebGateClient (runtime worker, src/client.ts) ─BroadcastChannel─► page (src/relay.ts) ─MessagePort─►
      gate iframe (app/gate.ts), origin gate.<host>:  local-network refusal → network policy →
      secret substitution → fetch(credentials: "omit") → scrub response → back
```

**What the browser guarantees:**

- **The IDE origin can't read the gate's memory or storage.** That rules out the
  VM, editor extensions, webviews and the app's pages themselves. The same-origin
  policy takes the place of your proxy's VM boundary. Secret values are typed
  only into the gate's settings popup (top-level, gate origin), stored in the
  gate's IndexedDB, and can't be read back out through its API.
- **Neither the runtime nor editor extensions have a network of their own.**
  The runtime frame's CSP is `connect-src 'self'` (`../host/`), and the VS Code
  surface's build rewrites the extension host's CSP to `connect-src 'self' https://open-vsx.org`, and starts
  the extension host from a blob so every worker it spawns inherits that CSP.
  Upstream allows any `https:` origin. Tested: `fetch()` from the extension host
  and its child workers is blocked. The VM's traffic leaves only through the
  gate.
- **The destination is proven.** A secret is matched against the hostname of
  the URL the gate itself passes to `fetch()`, and the browser verifies TLS for
  exactly that name. There's no separate IP for a caller to choose, so the
  Host-header bypass your addon defends against doesn't exist here. `net.ts`
  also refuses requests whose Host doesn't match the TLS SNI (421).

**Secret rules** (`core/src/core.ts`, unit tests in `npm run test:gate`):

- **Keyed by placeholder.** For example `GATE-OPENAI-KEY`, exported in the VM as
  `$OPENAI_API_KEY` through `/etc/profile.d/gate-secrets.sh`, which contains
  names only.
- **Substituted only over https, and only toward the secret's hosts.** Hosts are
  either `api.x.com` or `*.x.com`. `*`, `*.com` and `*x.com` are rejected.
- **Headers only by default.** A body or URL is something a service can compute
  on: "reverse this key" to an LLM hands the value back transformed, and no
  scrubber can catch that. `anywhere: true` is an explicit opt-in.
- **Sent anywhere else, the placeholder goes out as written** and is logged as
  `LEAK-SUSPECT`.
- **Never across a redirect.** A request carrying a secret uses
  `redirect: "manual"`, so it can't follow a redirect. Plain `fetch()` would
  follow it with custom headers attached.
- **Exact echoes are scrubbed** from responses and response headers, across
  chunk boundaries.
- **Invalid configuration is dropped, not widened.** That covers no hosts, a
  wildcard host, and two placeholders where one contains the other.
- **Secrets can be switched off** in the popup.

**Encryption at rest** (`web/app/vault.ts`, `web/app/webauthn.ts`):

- **One data key, several ways to unlock it.** A random 256-bit key encrypts
  each value (AES-256-GCM, fresh IV). That key is stored wrapped, once per
  unlock method; adding or removing a method never re-encrypts a value.
- **Passkey (recommended).** Touch ID, Windows Hello or a phone, through the
  WebAuthn PRF extension: after verifying the user, the authenticator derives
  32 bytes from a salt and a secret it never reveals, and those bytes (via
  HKDF) wrap the data key. Nothing to remember, full-entropy key, and the
  credential is bound to the gate's own hostname (`rpId`), so no other origin,
  the IDE's included, can ask the authenticator for it. Supported in current
  Chrome, Safari and Firefox; the UI falls back to a passphrase elsewhere.
- **Passphrase.** PBKDF2-SHA256, 600,000 iterations, random salt. A weak
  passphrase can be brute-forced offline by anyone who copies the stored vault,
  which is why passkeys are the first option offered.
- **Allowlist binding.** Each ciphertext is bound (as AAD) to its placeholder
  and everything that decides where it may be sent: hosts, headers and
  `anywhere`. Editing an allowlist in storage, or moving a ciphertext under
  another name, makes decryption fail rather than redirect the value.
- **Locked state.** The vault starts locked on each page load. A request that
  needs a secret is refused (`DENY-LOCKED`), the VM is told why, and VS Code
  offers *Unlock the gate*. Placeholders and network rules stay readable, so
  the VM keeps its placeholders and network while locked.
- **Adding a method re-proves an existing one** (current passphrase, or a
  passkey tap): the key in memory is never extractable.
- **Lost every way in** means *Reset secrets*: the values are unrecoverable by
  design. Values stored in the clear by an earlier version are encrypted when a
  method is first set up.
- **"Stay unlocked on this device"** (passphrase only) stores the unwrapped key
  as a non-extractable CryptoKey. Anyone using that browser profile can then
  use the secrets, and the checkbox says so.

**Network policy:**

- **Modes:** *Ask first* (the default: only sites on the list; anything else is
  stopped and the user is asked), *Learn* (allowed, and each new site is listed
  for one-click rules) and *Open* (any public site, logged).
- **Deployment defaults** (`core/src/default-policy.ts`, shared with the node gate): the shipped list is package
  registries (npm, PyPI, crates, Go) and GitHub's raw/API hosts. Add the hosts
  your own tool needs. Users' own rules take precedence.
- **Always refused:** localhost, IP addresses and local-network names. That
  stops the VM reaching the user's LAN or router.
- **Per-secret usage limits** ("at most N requests per H hours"): caps what a
  runaway or malicious program can spend with a key. Reset by reloading.

**Notices** (through the runtime's `notice` event; the VS Code surface shows them): the gate tells the user, in plain words, when code
is stopped at an unlisted site (with *Allow or review…*), when a secret is used
with a site for the first time in a session, when a secret hits its limit, and
when code tried to send a secret somewhere it isn't meant for (an error-level
warning: "the real value was NOT sent; this can be a sign of malicious code").

**Settings** open from the VS Code command *Linux VM: Manage Secrets & Network
Access*. That shows a card inside the gate iframe, and clicking it opens a
top-level popup with an unguessable window name. The framed gate never takes a
decision from a click, because an iframe can be overlaid and clickjacked. It
only opens the popup. Secret values and passphrases are typed only there, where
the address bar shows the gate's own host.

### Threat model for non-technical users

The user runs code they didn't write and can't read: a tool someone shared, or
one an agent modified. Assume that code is hostile. What it can and can't do:

| It wants to… | Outcome |
|---|---|
| read or change the user's files on their computer | impossible: the VM has only its own filesystem; the page has no file access |
| reach the user's machine, router or office network | refused by the gate, in every mode |
| send the user's data to a site of its choosing | stopped unless the site is on the list (*Ask first*); the user sees a notice and decides |
| steal an API key | sees only the placeholder; the real value goes only to that key's sites, over HTTPS, in headers; a leak attempt is a loud warning |
| run up a bill with a key | bounded by the key's usage limit |
| act as the user on a website | impossible: no cookies, logins or client certificates are ever sent |
| get the real key back from an allowed site | possible only if that site reflects a header it was sent, transformed; exact echoes are scrubbed. Keys stay confined to headers by default for this reason |
| fake the unlock prompt to phish the passphrase | a page can draw a fake dialog; a passkey prompt comes from the OS and is bound to the gate's origin, so it can't be faked or redirected. Prefer passkeys |
| install a malicious editor extension | the gallery is off by default (`ENABLE_EXTENSION_GALLERY` in `surfaces/vscode/page/boot.ts`); ship the extensions you need as built-ins |
| change the IDE's settings from the project (`.vscode/settings.json`) | `linuxVm.*` settings are machine-scoped: a workspace can't override them |

**What still doesn't hold:**

- **A transformed value can be recovered** by code in the VM wherever an
  allowed host reflects a secret it received, transformed. The guarantee is
  *where* a value can go, not that it stays unknown. (Same conclusion as
  desolate's notes.)
- **Editor extensions are trusted.** Everything in the web extension host
  (ours, and any you ship as built-in) shares one worker and the same channel
  to the gate; a malicious one could read the VM's files, spoof responses to
  the VM, or request through the gate. It still can't read secrets or leave the
  gate's policy. Keep the gallery off for users who can't vet extensions.
- **Webviews** run on their own origins with CSPs their extension chooses, so a
  malicious *editor extension* could reach the network through one.
- **Browser extensions the user installed** with permission for the gate's
  origin can read its storage and watch the popup. That is the browser's trust
  model; nothing a page can do about it.
- **CORS still applies.** Sites that refuse browser requests need the bridge
  extension below, which receives the substituted request.
- **Quotas and notices are per page load.** Reloading resets them.
- **Development is over plain http.** Passkeys and WebCrypto need a secure
  context: `localhost` counts, a deployment must be https.

**Deployment checklist:** serve the app's `site/` and `gate/` folders on two
https hosts (`ide.example.com`, `gate.example.com`) and build with `IDE_URL`
and `GATE_URL` set to them (see Deploying in the top-level README); list your
tool's hosts in `defaultPolicy` (`core/src/default-policy.ts`); keep
`ENABLE_EXTENSION_GALLERY` off; set `WEBVIEW_HOST` for self-hosted webviews.

### The bridge extension (optional, `web/bridge-extension/`)

Without it, the VM reaches every CORS-enabled site, which covers most package
registries. With it, users can also reach sites that refuse browser access,
such as `git clone` from github.com, one site at a time. Load
`dist/<app>/bridge-extension/` unpacked from `chrome://extensions`: an app
build writes it with the app's gate origin (`GATE_URL`) filled in. The code is
described in `web/bridge-extension/README.md`.

```
gate: fetch() fails with a CORS error (GET/HEAD only), after policy and secrets
   → postMessage ─► content.js (injected only into the gate's origin) ─runtime port─► background.js
   → fetch(url, {credentials: "omit"}) with the extension's host permission
```

The browser enforces the security model; this code doesn't:

- **No hosts at install.** Each site is an *optional* host permission that the user
  grants through Chrome's own dialog, opened from the extension's popup with a
  click. A web page can't trigger, fake or skip that dialog. The popup lists
  waiting and allowed sites, and Revoke removes a site.
- **Anonymous requests.** `credentials: "omit"` means no cookies, no saved HTTP
  auth and no client certificates. An approved site sees what any server-side
  proxy would send. It can't act as the user.
- **Public HTTPS only.** `policy.js` refuses IP addresses, `localhost` and
  local-network names (`.local`, `.internal`, `.lan`, …), non-443 ports and
  `http:`, approved or not. A response that redirected to an unapproved or
  local host is thrown away.
- **Only the gate can use it.** Chrome injects `content.js` only into the
  gate's origin, and the background worker checks the sender's origin again.
  The gate serves only the IDE origin it's configured for.

What it can't fix: raw TCP (ssh, `git://`, databases). Extensions have no
socket API anymore. And there's a residual risk: an approved site gets
whatever the VM sends it, but that's equally true without the extension, for
any CORS-enabled site.

## The node gate (`node/`)

`nodeGate({ allow, rules, hint, log, fetch })`: the default policy (package
registries) plus `allow` hosts, and never private addresses or IPs. It has no
secrets (there's no vault to keep them from the host) and none of the browser's
CORS limits. The MCP server uses it:

```ts
const gate = nodeGate({ allow: ["example.com"], hint: (h) => `Restart with --allow ${h}.` });
const rt = new Runtime({ gate, assets });
```
