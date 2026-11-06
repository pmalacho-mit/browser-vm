# Claude Code in the browser VM: what works, what blocks it, the plan

Findings for issue #5, checked on 2026-11-06 with `Anthropic.claude-code`
**2.1.318** from Open VSX, **openvscode-server 1.109.5**, and the x86_64
machine (v86_64 fork at `d26cf8d2`). Everything here was run, not inferred,
unless marked otherwise. Nothing in the shipped apps changes; what this branch
adds is listed at the end.

## Short answer

- **The extension can't run in the browser workbench this repo ships** (Code-OSS
  1.91 web): it is a Node extension (`main`, no `browser` entry, needs VS Code
  ≥ 1.94) that spawns a 324 MB native `claude` binary.
- **A real VS Code server inside the VM works, almost.** openvscode-server
  (MIT, Open VSX) runs on the 64-bit machine with the extension preinstalled:
  it listens after 16 s, serves the workbench to a real browser, the Explorer
  shows the VM's files, the extension host starts and the Claude Code
  extension's UI appears. **One bug stands in the way: the fork's JIT emits an
  invalid WebAssembly module** the moment the workbench's WebSocket connects,
  and the emulator dies. With the JIT off everything else runs, too slowly to
  use (remote handshakes time out and retry; the Explorer appears after 1.5–5
  min; the extension had not activated 20 min later).
- **An API key works, an in-app OAuth login doesn't.** `api.anthropic.com`
  answers browser requests with `access-control-allow-origin: *` as long as the
  request carries `anthropic-dangerous-direct-browser-access: true`; the gate
  can hold the key and add that header. The OAuth token exchange
  (`platform.claude.com/v1/oauth/token`) refuses browser origins
  (`400 Disallowed CORS origin`), so `/login` from inside the VM can't finish. A
  long-lived token from `claude setup-token` (made on the user's own machine) is
  the other "paste a code" option.

## 1. The extension, as published

| Fact | Checked by | Consequence |
|---|---|---|
| Per-platform `.vsix` only (`linux-x64`, `alpine-x64`, `darwin-*`, `win32-*`; 162 MB); no universal/web build | `GET open-vsx.org/api/Anthropic/claude-code` | nothing a web extension host can load |
| `main: ./extension.js`, no `browser`; `extensionKind: ["workspace"]`; `engines.vscode: ^1.94.0` | the manifest in the `.vsix` | needs a Node extension host and VS Code ≥ 1.94 (this repo's `vscode-web` is 1.91) |
| `extension.js` (3.4 MB) requires `fs`, `child_process`, `net`, `tls`, `http(s)`, `os`, `crypto`, …, spawns in ~10 places | grep of the bundle | not shimmable in a reasonable amount of work |
| spawns `resources/native-binary/claude` (324 MB, Bun-compiled, dynamically linked) and talks stream-json over stdio; the chat UI is a webview | file listing, `file(1)` | the extension host must be *in* the VM, next to the binary |
| `@anthropic-ai/claude-code` on npm is a launcher for the same binaries (`…-linux-x64-musl` etc.), Node ≥ 22 | npm registry | no pure-JS CLI either |

## 2. The `claude` binary on the 64-bit machine

`images/test/claude-probe.mjs` boots the x86_64 machine under Node, copies a
binary in (or boots another image with `--image=`), and runs a command.

| In the guest (Alpine base image, musl build) | Result |
|---|---|
| `claude --version` | `2.1.318 (Claude Code)` in 3–4 s |
| `claude auth status` | JSON, `loggedIn: false`; 43 s (first start) |
| `claude -p 'say hi' --output-format json` | reaches the API layer: `Not logged in · Please run /login` |

The glibc build runs the same way on the Debian image below. I could not run a
real prompt: no credential was available in this environment.

## 3. A VS Code server in the VM (option C)

**Image.** `images/claude-probe/` builds a Debian bookworm x86_64 image with
openvscode-server 1.109.5 at `/opt/openvscode-server` and the extension unzipped
into `/root/.openvscode-server/extensions/` (266 MB compressed; `build.sh`,
Docker with linux/amd64 emulation; Node won't run under qemu-user, so the
`.vsix` is unpacked rather than installed). It still boots with `vm-init` and
the Go agent; `installAgent` had to learn that `/sbin` is a symlink there
(`runtime/src/agent-client.ts`).

**Probe.** `images/test/vscode-server-probe.mjs` boots that image, starts the
server, measures, fetches `/` through the same TCP path previews use
(`PreviewGateway`), bridges a local port to the guest's server, and (with
`--browser`) drives headless Chromium through the workbench. Measured on this
8-core aarch64 dev container, 1536 MiB guest:

| Step | JIT on | JIT off (`--no-jit`) |
|---|---|---|
| server listening on :3000 after launch | 16–20 s | 31 s |
| first `GET /` (workbench HTML) | 22–27 s | 35 s |
| workbench shell rendered in the browser | 17–24 s after navigation | 18 s |
| workbench's WebSocket to the server | **emulator dies: JIT CompileError** (3 of 3 runs) | handshakes time out (60 s limits) and retry; Explorer lists `/root/project` after 86 s (282 s with another VM sharing the CPU) |
| extension host process in the guest | — | 4 s later (90 MB RSS) |
| Claude Code extension | — | its editor-title button appears (contributions scanned); its command `claude-vscode.sidebar.open` is still "not found" 20 min later, so **activation was not observed** |
| memory in the guest | 41 MB used of 1485 with the server up | 173 MB with server, extension host and file watcher |

The JIT failure is deterministic for this workload and is an emulator bug, not
VS Code's: `CompileError: i64.store[0] expected type i32, found i64.load of
type i64` in the module handed to `codegen_finalize` while compiling V8's own
generated code inside node. The refused module (which reproduces the error on
its own with `new WebAssembly.Module(bytes)`), the guest code page and a
disassembly are in `images/claude-probe/repro/`, with an issue text for the
fork (`ISSUE.md`; file it with
`gh issue create --repo pmalacho-mit/v86_64 --title "JIT emits i64 address into i64.store (CompileError) running openvscode-server's node" --body-file images/claude-probe/repro/ISSUE.md`).

**Two more limits found on the way:**

- **Guest RAM ceiling is about 2 GiB minus the largest file.** 2000 MiB boots;
  2047 MiB and up crash at start (`RangeError: offset is out of bounds`). Worse,
  at 2000 MiB large zstd blobs silently read back as zeros (the 123 MB `node`
  binary → "Exec format error"): decompression scratch shares the emulator's
  32-bit WebAssembly memory with the guest. **1536 MiB works for everything in
  this image** (338 MB `claude` included). Keep guest RAM + the biggest
  compressed+decompressed file under 2 GiB, or store very large files
  uncompressed.
- **The server's own HTTPS needs `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/browser-vm-ca.pem`**
  (the per-tab CA), as the profile sets for shells; the probe launches it so.
  And `--disable-workspace-trust`, or the trust dialog eats the first keystrokes.

## 4. Network and login

| Request | From a browser origin (`curl -X OPTIONS` / `POST` with `Origin:`) |
|---|---|
| `POST api.anthropic.com/v1/messages` with `anthropic-dangerous-direct-browser-access` listed | preflight 200, response `access-control-allow-origin: *` (also on a 401) |
| the same without that header | preflight 400 |
| `POST platform.claude.com/v1/oauth/token` (also `console.anthropic.com`, `api.anthropic.com/api/oauth/*`, `claude.ai/api/oauth/*`) | `400 Disallowed CORS origin`, for `*.localhost` and even for `Origin: https://claude.ai` |

So, through the web gate: the Messages API works if the gate adds the header
for `api.anthropic.com` (it forwards only safelisted headers unless the request
carries a secret, `gates/core/src/core.ts` `forwardHeaders`), and
`api.anthropic.com` must be allowed (not in `default-policy.ts` today). Login
inside the VM stops at the token exchange. Telemetry hosts (`statsig.anthropic.com`,
Sentry) can simply stay blocked (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`).

## 5. The plan

**Goal:** people work in a browser-based computer with Claude Code beside them,
in a real VS Code, with the smallest security footprint: the agent, its binary
and its shell all live in the VM; the only way out is the gate; the key never
enters the VM.

0. **Unblock the emulator** (the fork): fix the JIT emitter (`repro/ISSUE.md`).
   Nothing below is worth building until a run of the probe with the JIT on
   gets past the WebSocket step. Then re-measure: every number above with the
   JIT on but for the first three is unknown.
1. **A `vscode-server` surface and a `claude` app on x86_64.**
   - Image: the Debian one here, as an image the app can name (`image:
     "claude"`), plus a **playground snapshot** with the server already
     listening (restore ≈ 1 s instead of a 16 s start plus a 25 s first
     request), the agent's `refresh` re-issuing the CA as it does now.
   - Page: a boot page like `surfaces/vscode/page/boot.ts` but for the server's
     workbench: its static files copied into the site at build time (from the
     tarball's `out/`), `remoteAuthority` set to a virtual host, and
     **`webSocketFactory`** implemented over `PreviewGateway.socketOpen/Write/Close`
     (the raw TCP-into-the-guest path that exists for previews), so the remote
     connection needs no new runtime or agent feature. Webview and extension
     resources (`vscode-remote-resource`) go through a preview origin's service
     worker. The webview host stays `vscode-cdn.net` or is self-hosted, as today.
   - Launch: a service script in the image (`NODE_EXTRA_CA_CERTS`,
     `--disable-workspace-trust`, `--without-connection-token`, bound to
     `0.0.0.0` because connections arrive from v86's router address).
   - The existing `linux-vm` extension and its terminals stay for the i686 app;
     this app uses the server's own terminals and file system (the Explorer
     *is* `/root/project` either way, through 9p).
2. **Credentials through the gate, no login UI.**
   - A secret `GATE-ANTHROPIC-KEY` (API key) or `GATE-CLAUDE-OAUTH-TOKEN`
     (`claude setup-token`), exported in the VM as `ANTHROPIC_API_KEY` /
     `CLAUDE_CODE_OAUTH_TOKEN` through `/etc/profile.d/gate-secrets.sh` as other
     secrets are; the extension's `claudeCode.environmentVariables` setting can
     pass them to the extension host too.
   - Gate: allow `api.anthropic.com` for that secret, add
     `anthropic-dangerous-direct-browser-access: true` on requests to it, and set
     `claudeCode.disableLoginPrompt` in the image's settings.
   - The user's "code" is then the key or token pasted into the gate's popup
     (gate origin, encrypted vault), never typed into the VM.
3. **In-app `/login`, if still wanted:** only with something outside the
   browser's CORS rules: the repo's bridge extension (Chrome, per-site approval;
   its content script must also match the deployed gate origin) or a tiny
   token-exchange relay you host. Decide after 1–2 work.

**Risks to keep in view:** one emulated core (expect tens of seconds for the
server to start and for the first interactions; snapshots hide the start only),
the 2 GiB memory line, a ~2 GB WebAssembly memory in the user's tab, the
extension's auto-update and gallery traffic (set `extensions.autoUpdate: false`,
keep Open VSX reachable or not), and that every release of the extension is a
new 162 MB `.vsix` baked into an image.

## What this branch adds

- `runtime/src/agent-client.ts`: `installAgent` follows a symlinked `/sbin`.
- `images/test/claude-probe.mjs`: run `claude` (or anything) on the x86_64 VM.
- `images/test/vscode-server-probe.mjs`: the option C probe (server, HTTP,
  bridge, headless Chromium, JIT failure capture, `--no-jit`).
- `images/claude-probe/`: the Debian + openvscode-server + extension image
  (`build.sh`, `Dockerfile`), and `repro/` for the fork.
- This note.

**Not verified:** a prompt/response round trip (no credential here); the gate
path in a real browser (CORS facts come from `curl`); that `vscode-web` 1.91
rejects the `.vsix` (from the manifest); the extension activating and spawning `claude`
from the server (under the interpreter it had not activated after 20 min; with
the JIT this is the first thing to check once the fork is fixed).
