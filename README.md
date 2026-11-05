# browser-linux-ide

VS Code (Code-OSS) and a real Linux VM, **running entirely in the browser**.
The server is any static file host. Nothing executes server-side.

```
npm install
npm run build      # assembles the static site in dist/
npm run test:boot  # optional: headless boot + filesystem + network checks in Node
npm start          # http://localhost:8080   (use "localhost", not 127.0.0.1 — see Webviews)
                   # behind a port forwarder? see "Behind a port forwarder" under Deploying
npm run dev        # build, serve, and rebuild on every change (see Development)
```

What you get after ~10 s: an editor whose Explorer *is* the VM's `/root/project`,
terminals that are shells inside the VM, Ctrl+P / Find in Files over the VM's
files, edits that the guest sees immediately (and vice versa), and HTTP/HTTPS
from inside the VM via the browser's `fetch()` (see Networking).

## How it works

```
┌──────────────────────────────── browser tab ─────────────────────────────────┐
│  index.html  → boots the Code-OSS web workbench (dist/vscode, MIT)           │
│     folderUri = vmfs:/root/project          extension gallery = Open VSX     │
│                                                                              │
│  ┌─ web-worker extension host ──────────┐                                    │
│  │  linux-vm extension (extension/src)   │      BroadcastChannel             │
│  │   FileSystemProvider "vmfs:"          │◄──── requests, events ───────┐    │
│  │   File/TextSearchProvider             │      (runtime/src/rpc.ts)    │    │
│  │   Pseudoterminals ×3                  │                              │    │
│  └───────────────────────────────────────┘                              │    │
│  ┌─ hidden iframe runtime/ (CSP: connect-src 'self') ──────────────────┼─┐  │
│  │  runtime worker (runtime/src/runtime.ts)                            ▼ │  │
│  │   files, search ──► v86 FS object (JS, in memory)                     │  │
│  │   terminals    ──► serial ports 0/2/3      agent RPC ──► port 1       │  │
│  │                                                                       │  │
│  │   v86: x86 CPU → WASM JIT ────────────────────────────────────────┐   │  │
│  │   │ Linux 6.18 i686 (guest/prebuilt/bzImage)                      │   │  │
│  │   │   root fs = virtio-9p  ◄── served by that same FS object       │   │  │
│  │   │   /sbin/vm-init: shells on ttyS0/2/3, vm-agent on ttyS1        │   │  │
│  │   │   userland = docker export of guest/Dockerfile (Alpine x86)    │   │  │
│  │   └────────────────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
   files fetched lazily over HTTP:  vm/fs.json (index) + vm/rootfs/<sha256>.bin.zst
```

The key idea: the guest's root filesystem is a JavaScript object (v86's 9p
server). The Linux kernel mounts it over virtio-9p, and the editor reads and
writes **the same inodes** through the runtime. There is no syncing and no
second copy.

The VM runs in its own worker, the **runtime**, not inside VS Code. VS Code is
one frontend of it; `lite/` (CodeMirror + xterm.js) and the MCP server are two
more. See "The runtime and its frontends".

## What's technically necessary (and what I ran into building it)

| Piece | Where | Notes |
|---|---|---|
| **Workbench** | `node_modules/vscode-web` → `dist/vscode` | Prebuilt Code-OSS 1.91 web build (MIT). The host page passes `IWorkbenchConstructionOptions` via `window.product`. |
| **Host page** | `web/index.html`, `web/boot.ts` | Opens `vmfs:/root/project`, registers the extension through `additionalBuiltinExtensions`, sets Open VSX, allows proposed APIs, sets the webview endpoint. Works from any sub-path. |
| **Runtime** | `runtime/src`, `web/runtime/`, `web/runtime-host.ts` | The VM and everything editors need from it (files, search, terminals, exec), in its own Web Worker behind a request/event protocol. See "The runtime and its frontends". |
| **VS Code extension** | `extension/src` | A *web* extension (`"browser"` entry) in VS Code's extension-host Web Worker: maps the runtime onto VS Code's file system, search and terminal APIs. |
| **Emulator** | npm `v86` (BSD-2) | x86 → WASM JIT. Only 32-bit x86, so the guest is i686. |
| **Kernel** | `guest/kernel*.config`, `guest/build-kernel.sh` | `tinyconfig` plus virtio-pci, 9p, 8250 serial and devtmpfs, all built in, so there's no initramfs and no modules. 2 MB. Like Docker, the *runtime* supplies the kernel and the image supplies only userland. The 32-bit kernel needs `CONFIG_COMPAT_32BIT_TIME`: without it, `futex(2)` returned ENOSYS, Go programs crashed, npm failed, and V8 ran several times slower (`node -e 1`: 12.5 s → 2.9 s). |
| **Userland** | `guest/Dockerfile`, `guest/build-rootfs.sh` | Any `linux/386` image. `docker export` → `tools/fs2json.py` + `copy-to-sha256.py` (from v86) → JSON index + content-addressed zstd blobs. |
| **PID 1** | `guest/vm-init` | Mounts `/proc`, `/sys`, `/dev`, `/tmp`. Runs a respawning `setsid -c` login shell per console (that's what gives job control and Ctrl+C) and starts the agent. Independent of the distro's init system. |
| **Control plane** | `guest/agent/` (Go), `runtime/src/agent-client.ts` | JSON-lines RPC on ttyS1: `resize` (TIOCSWINSZ → SIGWINCH, so vim/top re-layout), `hangup` (closing a terminal tab SIGHUPs that session, like SSH), `exec` (exit code, stdout, stderr), `ports` (listening sockets) and `refresh` (after a snapshot restore: reseed the RNG, set the clock, swap in this tab's CA). The runtime writes the binary into the guest before boot, so it works with any image; images still ship the shell agent `guest/vm-agent` (resize and hangup only) as a fallback. `npm run agent` rebuilds it (reproducibly). |

Gotchas worth knowing (each is commented where it's handled):

- **Write into the existing inode.** v86's `create_file()` makes a *new* inode,
  while the guest still holds the old one. The provider does `ChangeSize` +
  `Write` on the existing id instead.
- **Guest page cache.** With 9p `cache=loose`, the guest kept serving stale
  bytes after editor saves. The root is mounted with `cache=mmap`: ordinary
  reads and writes stay uncached (coherent with the editor), while memory-mapped
  files (program binaries and libraries) are cached. With `cache=none`, every
  page of a program was read over 9p as it ran: `node -e 1` took 40 s instead
  of 12.5 s. The kernel command line lives in `runtime/src/guest-config.ts`.
- **File contents stay cached.** v86 drops a file's downloaded contents when the
  guest closes it, so every run of a program fetched and decompressed it again.
  `runtime/src/blob-cache.ts` keeps them in a memory LRU instead
  (`linuxVm.fileCacheMB`, default 256), and keeps the compressed blobs in the
  browser's Cache Storage, so a second visit downloads none. Blob names are
  content hashes, so `npm start` serves them as `immutable`; on your own host,
  serve `extensions/linux-vm/vm/rootfs/*` with a long `max-age` too.
- **Change events.** v86's FS has no event API, so the provider wraps
  `CreateFile`/`Write`/`Unlink`/`Rename` on the instance. The guest's 9p
  server calls the same methods, so `touch foo` in the terminal shows up in the
  Explorer.
- **Nested workers.** v86 schedules itself with a blob-URL Worker and revokes
  the URL immediately. VS Code's extension host (where the VM used to run)
  wraps `Worker` and loads the URL later, so `vm.ts` defers
  `URL.revokeObjectURL`.
- **COM4.** Linux runs a loopback self-test only on COM4, and v86's UART doesn't
  emulate loopback, so ttyS3 probed as "unknown". `vm-init` runs
  `setserial /dev/ttyS3 uart 16550A` to declare it.
- **Search.** In the desktop app, Ctrl+P and Find in Files are ripgrep on a
  Node server. In pure web, a custom scheme needs the *proposed*
  `fileSearchProvider`/`textSearchProvider` APIs, enabled through
  `productConfiguration.extensionEnabledApiProposals`.
- **Webviews** (Markdown preview, extension UIs) must run on
  `https://<hash>.<webview-host>/`, because the bootstrap page checks its own
  hostname. `*.localhost` resolves to loopback in browsers, so local dev works
  with no setup. For a real deployment, see below.
- **Docker owns `/etc/hostname`**, so it isn't in `docker export`. `vm-init`
  sets the hostname itself.

## Networking (still no server)

The guest has a virtio NIC on v86's fake network stack (ARP, DNS and TCP,
implemented in JavaScript). `runtime/src/net.ts` takes over TCP connections
to ports 80 and 443 and replays each HTTP request with the browser's `fetch()`:

```
guest: wget https://registry.npmjs.org/left-pad
  │ DNS  → v86 answers every name with one fake IP
  │ TCP  → ends in JavaScript (v86 fake TCP stack)
  ▼
:443 → tls.wasm  (Go crypto/tls → WASM, tls/main.go) completes the handshake with a
       certificate for the SNI hostname, signed by a CA generated in this tab
:80  → as is
  ▼
HttpSession: parse HTTP/1.1 (over TLS, the Host must match the SNI) → hand the
             request to the network gate (below) → stream the response back
```

Same design as container2wasm's in-browser proxy. Details:

- **Per-tab CA.** `tls.wasm` generates a CA when it starts. The runtime writes
  its certificate to `/etc/ssl/certs/browser-vm-ca.pem` before boot, and
  `vm-init` appends it to the system bundle. `/etc/profile.d/browser-vm-network.sh`
  points Node, pip and requests at it, because they ship their own CA lists. The
  private key never leaves the tab's memory. The interception only touches the
  guest's own traffic, and the browser does real TLS to the real site.
- **The limit is CORS.** A site is reachable only if it sends
  `Access-Control-Allow-Origin`. Otherwise the guest gets `502` with an
  explanation. Measured from Chromium:
  - **Work:** registry.npmjs.org (metadata and tarballs), pypi.org,
    files.pythonhosted.org, raw.githubusercontent.com, api.github.com,
    index.crates.io.
  - **Refused:** github.com's git endpoint (`git clone`).
  - **Untested** (blocked by the sandbox this was built in): dl-cdn.alpinelinux.org,
    deb.debian.org. Try `apk update` in the VM.
- **Headers.** Ordinary requests forward only CORS-safelisted headers plus
  `authorization`, to avoid preflights. Requests that carry a secret keep all of
  theirs. The browser handles compression. Cookies are never sent.
- **Ports.** Only 80 and 443 are handled. Anything else (ssh, `git://`, raw TCP)
  is refused, because a page can't open raw sockets.
- **Inside the VM, `localhost` works normally.** `vm-init` writes `/etc/hosts`.
- **Turning it off.** Set `linuxVm.network` to `off` to remove the NIC.
- **Cost.** `tls.wasm` is 7.6 MB (2 MB gzipped), loaded in parallel with the VM.
  `npm run tls` rebuilds it (needs Go).

## The network gate: allowlist and secrets (`web/gate/`)

Every request from the VM goes through the **gate**, a small page on its own
origin (`gate.localhost:8080` locally, `gate.example.com` in production),
embedded as a hidden iframe. Secrets live only there. It follows the design of
desolate's mitmproxy addon (placeholders substituted in flight, per-secret host
allowlists, leak-suspect auditing, response scrubbing), with the browser
supplying the isolation:

```
VM ─► net.ts (runtime worker) ─BroadcastChannel─► index.html (gate-relay.ts) ─MessagePort─►
      gate iframe, origin gate.<host>:  local-network refusal → network policy →
      secret substitution → fetch(credentials: "omit") → scrub response → back
```

**What the browser guarantees:**

- **The IDE origin can't read the gate's memory or storage.** That rules out the
  VM, editor extensions, webviews and `index.html` itself. The same-origin
  policy takes the place of your proxy's VM boundary. Secret values are typed
  only into the gate's settings popup (top-level, gate origin), stored in the
  gate's IndexedDB, and can't be read back out through its API.
- **Editor extensions have no network of their own.** The build rewrites the
  extension host's CSP to `connect-src 'self' https://open-vsx.org`, and starts
  the extension host from a blob so every worker it spawns inherits that CSP.
  Upstream allows any `https:` origin. Tested: `fetch()` from the extension host
  and its child workers is blocked. The VM's traffic leaves only through the
  gate.
- **The destination is proven.** A secret is matched against the hostname of
  the URL the gate itself passes to `fetch()`, and the browser verifies TLS for
  exactly that name. There's no separate IP for a caller to choose, so the
  Host-header bypass your addon defends against doesn't exist here. `net.ts`
  also refuses requests whose Host doesn't match the TLS SNI (421).

**Secret rules** (`web/gate/core.ts`, unit tests in `npm run test:gate`):

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

**Encryption at rest** (`web/gate/vault.ts`, `web/gate/webauthn.ts`):

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
- **Deployment defaults** (`web/gate/config.ts`): the shipped list is package
  registries (npm, PyPI, crates, Go) and GitHub's raw/API hosts. Add the hosts
  your own tool needs. Users' own rules take precedence.
- **Always refused:** localhost, IP addresses and local-network names. That
  stops the VM reaching the user's LAN or router.
- **Per-secret usage limits** ("at most N requests per H hours"): caps what a
  runaway or malicious program can spend with a key. Reset by reloading.

**Notices** (`extension.ts`): the gate tells VS Code, in plain words, when code
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
| install a malicious editor extension | the gallery is off by default (`ENABLE_EXTENSION_GALLERY` in `web/boot.ts`); ship the extensions you need as built-ins |
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

**Deployment checklist:** serve the IDE and the gate on two https hosts
(`ide.example.com`, `gate.example.com`) and build with `IDE_URL` and
`GATE_URL` set to them (see Deploying); list your tool's hosts in
`defaultPolicy` (`web/gate/config.ts`); keep `ENABLE_EXTENSION_GALLERY` off;
set `WEBVIEW_HOST` for self-hosted webviews.

## Optional: the network bridge extension (`bridge-extension/`)

Without it, the VM reaches every CORS-enabled site, which covers most package
registries. With it, users can also reach sites that refuse browser access,
such as `git clone` from github.com, one site at a time. Load
`build/bridge-extension/` unpacked from `chrome://extensions`: `npm run build`
writes it with your gate's origin (`GATE_URL`) filled in.

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

## Boot speed

`npm run profile:boot` prints a cold-boot timeline, then snapshots the booted
VM and times a restore. Measured in Node (2 CPU cores):

| | to shell prompt |
|---|---|
| original kernel (XZ, legacy ptys, VT, PS/2 input) | 9.5 s |
| current kernel (`guest/kernel.config` "boot speed" block) | 4.9 s |
| restore a booted snapshot (128 MiB RAM; 2.7 MB zstd) | 0.3–0.9 s |

Where the remaining cold boot goes: ~0.1 s emulator load, ~0.4 s firmware and
LZ4 decompression, ~1.2 s kernel init, ~1.9 s `vm-init` (about 20 short-lived
processes, each re-reading busybox over 9p). In the browser, the VS Code page
shows a running VM about 4 s after load (the runtime starts with the page, in
parallel with the workbench); a playground restore, 1.4–2.7 s.

Snapshots (`emulator.save_state()`) restore in ~0.1 s at 128 MiB RAM but
~1.1 s at 512 MiB: restore cost scales with RAM size, not with what's in it.
Because the root filesystem lives in JavaScript, files can be written into a
restored VM without rebooting. One booted snapshot can therefore serve every
tool built on the same image. Restoring has to re-seed the guest's RNG (every
copy of a snapshot starts with the same entropy pool), set the clock, and
re-trust the tab's new CA certificate.

## 64-bit (experimental)

One switch selects the VM's CPU architecture for every script:

| | `VM_ARCH=i686` (default) | `VM_ARCH=x86_64` |
|---|---|---|
| Emulator | upstream v86 (npm) | [v86_64](https://github.com/portlandhodl/v86_64) fork, `vendor/v86_64/` (pinned commit) |
| Kernel config | `guest/kernel.config` + `kernel-i686.config` | `guest/kernel.config` + `kernel-x86_64.config` |
| Prebuilt kernel + image | `guest/prebuilt/` | `guest/prebuilt/x86_64/` |
| Local builds | `build/kernel/`, `build/guest/` | `build/kernel-x86_64/`, `build/guest-x86_64/` |

```
npm run build:x86_64          # site with the 64-bit VM (or: VM_ARCH=x86_64 npm run build)
npm run dev:x86_64            # the same, in watch mode
npm run test:boot:x86_64      # headless checks against the 64-bit VM
npm run compare:vm:x86_64     # boot + CPU benchmarks (npm run compare:vm for 32-bit)
npm run kernel:x86_64         # rebuild the 64-bit kernel
npm run guest:x86_64          # rebuild the 64-bit guest image (Docker, linux/amd64)
npm run v86_64                # update vendor/v86_64 from the fork's CI release (verified)
```

`scripts/targets.mjs` maps the architecture to files. `dist/` holds one VM at a
time: the last build wins. Everything else (the extension, gate, vault, network
and init script) is architecture-independent and unchanged; the runtime's
`import { V86 } from "v86"` is pointed at the selected emulator at build time.

Measured on a 2-core aarch64 dev container:

| | 32-bit | 64-bit |
|---|---|---|
| `npm run test:boot` checks | 14/14 | 14/14 |
| headless Chromium, page load → VM running | 4.1 s | 5.1 s |
| Node, boot → agent ready | 2.1 s | 2.5 s |
| shell loop / sha256 8 MB / gzip 8 MB / 64-bit math | 1.9 / 3.8 / 8.1 / 9.5 s | 2.1 / 2.0 / 7.1 / 7.7 s |

The payoff is software that ships only 64-bit builds. Biome 2.6.5's x86_64
binary from npm (`@biomejs/cli-linux-x64-musl`) runs in the 64-bit VM
(`biome --version` in 1.4 s); the 32-bit kernel can't execute it.

**Known gaps.** The Go guest agent aborts on the fork ("sysMemStat overflow",
an emulation bug), so the 64-bit VM uses the image's shell agent: terminals work,
but `exec`, `ports` and `refresh` don't. And **snapshots don't restore.** `save_state()` works, but a restored
64-bit VM triple-faults on its next interrupt ("page fault during #DF
delivery"), with the CI build and with a locally built one alike; the 32-bit VM
restores fine. Anything built on snapshots (resuming a session, quickboot
playgrounds) is 32-bit only until the fork fixes it.
`npm run profile:boot:x86_64` reproduces it. Cold boots are unaffected.

The fork is about a month old, maintained by one person, and accepts only
AI-generated contributions. `vendor/v86_64/PROVENANCE.md` records the pinned
commit and why its files can be trusted: they are the fork's own CI build of
that commit, checked against GitHub's recorded checksums. Keep 32-bit as the
default until the fork matures or upstream v86 adopts 64-bit.

## Playgrounds

A playground starts from a snapshot instead of booting: a runtime installed,
warmed up and waiting at a shell prompt, with a starter project in
`/root/project`. Open one with `?playground=<id>`, or the VS Code command
*Linux VM: Open a Playground…*.

| Playground | What's in it | Snapshot | Page load → running (headless Chromium) |
|---|---|---|---|
| `python-3.12` | Python 3.12.16, pip | 9.5 MB, 256 MiB RAM | 2.2 s |
| `node-24` | Node.js 24.22.1, npm 11 | 9.5 MB, 512 MiB RAM | 2.3 s |
| `node-24-python-3.12` | both | 9.6 MB, 512 MiB RAM | 2.7 s |
| `svelte-vite` | Svelte 5, Vite 7's dev server running, preview open | 43 MB, 768 MiB RAM | app shown at 17 s |
| `sveltekit` | SvelteKit 2 (SSR, API routes), dev server running, preview open | 47 MB, 768 MiB RAM | page rendered at 3 s, interactive at 12 s |
| `rust` | Rust 1.91 and Cargo, starter project built | 10 MB, 1 GiB RAM | 4.7 s |

```
npm run playgrounds                  # build them all into build/playgrounds/ (1 min each; 3–6 min with a dev server)
npm run playgrounds -- python-3.12   # or one
npm run build                        # ships the ones that match this build's emulator and kernel
```

Each is a folder in `playgrounds/` (manifest and starter project; see
`playgrounds/README.md`). The builder (`scripts/build-playgrounds.mjs`) needs
no Docker and runs on ARM hosts too: Alpine's minirootfs plus packages from
Alpine's static `apk` for the host, the packages' install scripts run inside
the VM, then the warm-up, then `save_state()`. All playgrounds share one
content-addressed blob pool, so a package two of them use is stored once.

A playground can start a dev server before its snapshot (`"server"` in its
manifest). The builder waits for the port, then crawls it the way a browser
would: the page, then every module the served code imports. The dev server's
slow first pass (Vite took 100 s to start and 156 s for SvelteKit's first
server render, on the emulated CPU) happens at build time, and the snapshot
has the results. Before saving, the builder drops unused caches and zeroes
free RAM, so a snapshot holds only memory in use.

The web framework playgrounds run on Vite 7, not 8: Vite 8's bundler
(rolldown) and lightningcss have no 32-bit Linux builds. Rollup has none either,
so the templates swap in its WebAssembly build
(`"overrides": { "rollup": "npm:@rollup/wasm-node" }`). npm packages are
installed on the host for the guest's platform (`npm ci --cpu=ia32 --libc=musl`),
not in the emulator.

**Rust, measured** (the roadmap said to measure before promising anything).
On the emulated CPU, in the restored playground:

| | |
|---|---|
| `cargo run`, already built | 4.3 s |
| rebuild after an edit | 3–12 s |
| cold build of hello world (done at build time) | 25 s debug, 16 s release |
| `cargo add itoa` (no dependencies of its own), then build | 47 s |
| `serde` with `derive` plus `serde_json`, first build | 21 min 42 s |

Standard-library code and small crates are fine. Crates that need procedural
macros (`serde_derive`, anything pulling in `syn`) take tens of minutes to
compile the first time, so the playground ships without them and its README
says so. A variant with such crates prebuilt in the snapshot would cost every
playground build those 20+ minutes; it isn't worth it until there's demand.

When the browser restores one, the agent's `refresh` gives it this tab's clock,
fresh randomness and the tab's CA (every copy of a snapshot starts identical).
A snapshot only restores on the emulator and kernel it was built with, so the
site build skips stale ones (rebuild them) and CI rebuilds them when anything
that goes into them changes. 32-bit only for now (see "64-bit").

## Previews: servers in the VM

A server listening on `0.0.0.0` in the guest opens in the browser. In VS Code,
use *Linux VM: Preview a Port…*, or the notice that appears when a new port
starts listening; it opens in the Simple Browser. In `lite/`, use the
*preview :port* buttons. Playgrounds with a dev server open their preview
by themselves.

```
preview frame, origin 5173-<tab>.preview.<host>          IDE page (top)              runtime worker
  page ── fetch ─► service worker ── HTTP request ─┐
                                                    ├─ MessagePort (asked for with
  client.js ── WebSocket ─► raw TCP over the VM ────┘   postMessage to the top page) ─► PreviewGateway(5173)
                                                                                         └► v86 connect(5173)
                                                                                            → guest TCP
```

- **Each port gets its own origin**, `<port>-<tab>.preview.<host>`, separate
  from the IDE's, so a previewed app can't reach the IDE page, the runtime's
  BroadcastChannel or the gate. Its connection
  (`runtime/src/preview.ts`) reaches that one guest port and nothing else.
- **A service worker** (`web/__vm_preview__/sw.ts`) answers every request on
  that origin by making the same HTTP request to the guest, over v86's fake
  TCP stack. The guest sees it come from 192.168.86.1 with `Host: localhost`, so
  dev servers' host checks pass.
- **WebSockets** can't be intercepted by a service worker. A script injected
  into each HTML page (`client.ts`) replaces `WebSocket` for that origin with
  one that runs the WebSocket protocol over a raw TCP connection into the VM.
  That's what hot reload uses.
- **The app's network stays in the VM.** Preview pages get the CSP
  `connect-src 'self'` (and `default-src 'self' …`), so they reach their own
  server and nothing else. Code in the VM still reaches the internet only
  through the gate. Images and scripts from CDNs don't load in a preview.
- **File watching polls.** The 9p root delivers no inotify events (uncached 9p
  doesn't share inodes between lookups, so a watch never sees a change). Dev
  servers must poll: the templates set `server.watch.usePolling` for Vite.
  Polling also notices files saved from the editor, which bypass the guest
  kernel. Other tools: `nodemon -L`, `CHOKIDAR_USEPOLLING=1`, webpack
  `watchOptions.poll`.

Locally, previews use `*.preview.localhost` on the same port (browsers resolve
`*.localhost` to your machine). Deployed, set `PREVIEW_URL` (see "Deploying").
Previews only work inside the page that runs the VM: the frame gets its
connection from that page.

## The runtime and its frontends

Everything an editor needs from the VM sits behind one API,
`Runtime` in `runtime/src/runtime.ts`: `boot`, files (`stat`, `readdir`,
`read`, `write`, `mkdir`, `remove`, `rename`), search (`searchFiles`,
`searchText`), terminals (`openTerminal`, `writeTerminal`, `resizeTerminal`,
`closeTerminal`), processes (`exec`, `ports`) and the gate (`showGate`). It
emits events: `state`, `log`, `fs` (changes from the editor and the guest
alike), `term-data`, `notice`, `refused`, `booted`.

`runtime/src/rpc.ts` carries that API over anything that posts messages: a
BroadcastChannel in a page, a MessagePort, or an in-process pair in Node.
Calls return promises; errors keep their codes (`FileNotFound`, …).

```ts
import { channelEndpoint, connect } from "../runtime/src/rpc.ts";
import type { Runtime } from "../runtime/src/runtime.ts";

const rt = connect<Runtime>(channelEndpoint(new BroadcastChannel(window.__vmRuntimeChannel!)));
await rt.api.boot({ assetBase: "/extensions/linux-vm/vm", playground: "python-3.12" });
rt.on("term-data", ({ id, data }) => term.write(data));
const { id } = await rt.api.openTerminal({ rows: 24, cols: 80 });
await rt.api.write("/root/project/main.py", new TextEncoder().encode("print(42)\n"));
const r = await rt.api.exec(["python3", "main.py"], { cwd: "/root/project" });
```

In a page, `runtime-host.js` starts the runtime: a hidden iframe
(`runtime/index.html`) whose CSP allows connections to its own site only, so the
guest's traffic can only leave through the network gate. The iframe starts the
worker from a blob URL so the worker inherits that CSP even on hosts that can't
set HTTP headers. The page learns the channel name from
`window.__vmRuntimeChannel`; VS Code gets it through the setting
`linuxVm.runtimeChannel`.

| Frontend | Where | What it is |
|---|---|---|
| VS Code | `index.html`, `extension/src/` | the full IDE; the extension is a thin client (20 KB) |
| Lite | `lite/index.html`, `web/lite/` | a file tree, CodeMirror 6 and xterm.js, about 1.7 MB unminified. Takes `?playground=` too. The reference for bringing your own editor. |
| MCP server | `mcp/server.ts` | the runtime under Node, for AI agents (below) |

### MCP server

`mcp/server.ts` gives an agent its own VM over the
[Model Context Protocol](https://modelcontextprotocol.io) (stdio). Its tools are
`run_command`, `read_file`, `write_file`, `list_directory`, `search_text` and
`list_ports`. It runs the same runtime in-process under Node, with VM assets
from `dist/` (`npm run build` first).

```
claude mcp add browser-vm -- node --experimental-strip-types /path/to/browser-vm/mcp/server.ts --playground node-24
```

Options: `--playground <id>`, `--allow <host>` (repeatable), `--network off`,
`--memory-mb <n>`, `--assets <dir>`. The guest's network uses the gate's own
policy code (`web/gate/core.ts`): package registries plus `--allow` hosts, and
never private addresses or IPs. There is no browser here, so no CORS limits
and no secret vault. Use `node` directly or `npm run -s mcp`: without `-s`,
npm prints a banner on stdout, which is the protocol channel.

## Customizing the guest

Edit `guest/Dockerfile` (keep the two `COPY` lines; its architecture must match
the VM's, which `build-rootfs.sh` sets from `VM_ARCH`), then:

```
npm run guest                                  # needs Docker; output in build/guest/
PACKAGES="git python3 build-base" npm run guest
npm run build
```

`build/guest` takes priority over `guest/prebuilt/guest` when present.

**The prebuilt guest is minimal (busybox + apk).** It was built in an
environment without access to Alpine's package mirror. On your machine,
`npm run guest` installs the Dockerfile's default `git nodejs npm python3 nano less`
(all of which Alpine builds for x86). Because blobs are fetched lazily, a bigger
image costs disk space on the host but adds nothing to boot time.

Kernel: `npm run kernel` → `build/kernel/bzImage` (`npm run kernel:x86_64` →
`build/kernel-x86_64/bzImage`). It builds natively on Linux (gcc, make, flex,
bison, bc, lz4) and in a Debian container elsewhere.

`npm run test:boot` boots the guest headlessly in Node and checks consoles,
the 9p bridge in both directions, resize, and networking (with a stub
`fetch`). No browser needed. `npm run test:gate` unit-tests the gate's
decisions and the vault (both unlock methods).

## Development

The browser code is TypeScript, compiled by esbuild (`scripts/esbuild.config.mjs`):

| Source | Output | Runs in |
|---|---|---|
| `runtime/src/*.ts` | `dist/runtime/worker.js` (with the emulator for `VM_ARCH`) | the runtime worker |
| `web/runtime/frame.ts` | `dist/runtime/frame.js` | the runtime's hidden iframe |
| `extension/src/*.ts` | `dist/extensions/linux-vm/dist/extension.js` | VS Code's extension-host Web Worker |
| `web/gate-relay.ts`, `web/runtime-host.ts`, `web/boot.ts`, `web/amd-config.ts` | `dist/*.js` (classic scripts, loaded in order by `index.html`) | the IDE page |
| `web/lite/lite.ts` | `dist/lite/lite.js` + `lite.css` | the lite page |
| `web/gate/*.ts` | `dist/gate/gate.js` + `chunks/` (ES module) | the gate's origin |
| `mcp/server.ts` | not bundled; Node runs it directly | an MCP client's child process |
| `types/gate-protocol.ts` | types only | messages shared by the page, runtime and gate |

Static files under `web/` (`*.html`, `*.css`, …) are copied to the same place
in `dist/`.

```
npm run dev        # full build, then rebuild on change and serve on :8080/:8081
npm run typecheck  # tsc over runtime/, extension/, web/, scripts/ and mcp/ (also run in CI)
npm run test:runtime   # the runtime through its protocol, under Node (needs a build)
npm run test:mcp       # the MCP server, as an MCP client sees it (needs a build)
npm run test:e2e       # the built site in headless Chromium (npx playwright install chromium first)
```

After a change, reload the page (*Developer: Reload Window* reloads the
extension, but not the runtime worker: that needs a page reload). esbuild strips types without
checking them, so a type error doesn't block a rebuild; `npm run typecheck`
or your editor reports it. Changes to the kernel, guest image or `tls.wasm`
still need their own `npm run kernel/guest/tls` and a restart.

Conventions, all enforced by `tsconfig.base.json`:

- **Imports name the real file** (`./core.ts`). esbuild and Node both resolve it.
- **Only type syntax that can be erased** (`erasableSyntaxOnly`): no `enum`,
  `namespace` or constructor parameter properties. That is what lets the tests
  import `.ts` files directly (`node --experimental-strip-types`).
- **`import type`** for type-only imports (`verbatimModuleSyntax`).
- v86 APIs the project uses beyond v86's own types are declared in
  `types/v86-internals.d.ts`. Re-check them when upgrading v86.

The scripts in `scripts/` and the optional `bridge-extension/` stay JavaScript.
Scripts are type-checked through JSDoc (`checkJs`); Chrome loads the bridge
extension unbuilt.

## Deploying

Upload `dist/` to any static host (nginx, S3, GitHub Pages: a `.nojekyll` file
is included). No special headers are needed: v86 doesn't need
`SharedArrayBuffer`, so no COOP/COEP.

For the **network gate**, serve the same files on a second name, for example
`gate.example.com`, and tell the build both origins:

```
IDE_URL=https://ide.example.com/ GATE_URL=https://gate.example.com/ npm run build
```

The build writes them to `dist/site.js`, a static file: `index.html` reads
where the gate is, and the gate admits exactly that IDE origin and nothing
else. Set both or neither. With neither, you get the local default (IDE on
`localhost:<port>`, gate on `gate.localhost:<port>`), and on any other host the
VM has no network. The build reads only these two variables, so where you run
it never changes the output.

**Behind a port forwarder** that gives each port one exact hostname (GitHub
Codespaces, tunnels, desolate), `gate.<host>` won't reach you. Use a second
port as the gate's origin instead: `npm start` serves `dist/` on 8080 and 8081,
and you build with the two forwarded URLs as `IDE_URL` and `GATE_URL`. Under
desolate, `npm run build:desolate` does this from `DESOLATE_EXTERNAL_8080_URL`
and `DESOLATE_EXTERNAL_8081_URL`. Gate settings and secrets are stored per
origin, so a new gate origin starts with fresh ones.

For **previews** of servers in the VM, point a wildcard name at the same files,
served at its root, and pass it with `{id}` for the first label:

```
PREVIEW_URL=https://{id}.preview.example.com/ npm run build
```

`{id}` becomes `<port>-<tab>`, one origin per port and tab, so this needs
wildcard DNS and a wildcard TLS certificate for `*.preview.example.com`.
GitHub Pages can't do that; without `PREVIEW_URL`, previews work only on
localhost.

For **webviews**, point a wildcard name at the same files (for example
`*.webview.example.com` with a wildcard TLS certificate) and set `WEBVIEW_HOST`
in `web/boot.ts`. If it's left `null` on a non-localhost host, webviews load
from Microsoft's `*.vscode-cdn.net` copy, which works but is a third-party
runtime dependency.

## Limitations and next steps

- **No persistence.** Reloading reboots the VM from the image. Next step:
  `emulator.save_state()` into IndexedDB/OPFS (this captures CPU, RAM and all
  modified files), or sync `/root/project` to OPFS.
- **Network is HTTP(S) to CORS-enabled sites only** (see Networking), plus
  sites approved in the optional bridge extension. For full
  TCP you'd need a relay: v86 supports Wisp and WebSocket relays.
- **Previews need a wildcard origin** when deployed (`PREVIEW_URL`), and
  load only from their own server (no CDNs). Streaming responses (server-sent
  events) arrive only when they end: each request is one connection read to
  the end.
- **Speed.** Emulated x86 runs at a fraction of native speed: fine for shells,
  git and scripts, slow for heavy compiles. The editor itself runs natively.
- **32-bit by default.** `VM_ARCH=x86_64` switches to the experimental 64-bit
  emulator (see "64-bit (experimental)").
- **Workbench version.** `vscode-web` on npm is Code-OSS 1.91 (2024). For a
  current build, compile Code-OSS yourself (`npx gulp vscode-web-min`). Newer
  versions load as ES modules, so the script tags in `index.html` change, and
  the API proposal names may differ.
- **Only web extensions** (with a `"browser"` entry) install from Open VSX.
  Language servers that need Node can't run in the workbench, but could run in
  the guest.
- **Three terminals max** (one per serial port). More would need the agent to
  multiplex PTYs over one channel.

## Licenses

Project code (including `bridge-extension/`): MIT. Third-party pieces keep their own licenses: Code-OSS/vscode-web
(MIT), v86 and `tools/*.py` (BSD-2, see `tools/LICENSE.v86`), the v86_64 fork
in `vendor/v86_64/` (BSD-2 with MIT-licensed parts; see that folder), Go runtime in
`tls/prebuilt/tls.wasm` and `vendor/go/wasm_exec.mjs` (BSD-3, `vendor/go/LICENSE`), SeaBIOS/VGABIOS in
`vendor/` (LGPLv3), the Linux kernels in `guest/prebuilt/bzImage` and
`guest/prebuilt/x86_64/bzImage` (GPLv2: unmodified v6.18 source plus
`guest/kernel.config` and `guest/kernel-<arch>.config`), and Alpine packages in
the guest images (various; Alpine 3.22.7 minirootfs).
