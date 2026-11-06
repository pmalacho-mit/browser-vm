# Can the Claude Code extension run in the browser VS Code?

Findings for issue #5. Checked against `Anthropic.claude-code` **2.1.318** from
Open VSX (2026-11-06). Nothing here changes the app; the one new file besides
this note is the probe, `images/test/claude-probe.mjs`.

**Short answer.** Not as shipped, and not by installing the `.vsix` into this
workbench. The pieces underneath it do work: its native `claude` binary runs on
the 64-bit machine. Two things stand between us and a working playground: a
host for the extension's Node code, and a login that survives the browser's
CORS rules.

## What the extension is

| Fact | How I checked | Consequence |
|---|---|---|
| Published per platform (`linux-x64`, `alpine-x64`, `darwin-*`, `win32-*`, …), **no universal / web build**. `linux-x64` is 162 MB. | `GET open-vsx.org/api/Anthropic/claude-code` | Nothing installable in a web workbench. |
| `package.json` has `main: ./extension.js`, **no `browser`**. `extensionKind: ["workspace"]`. | unzipped the `.vsix` | The web extension host (a Worker) never loads it. VS Code runs it only in a Node extension host. |
| `engines.vscode: ^1.94.0`. This repo's workbench (`vscode-web`) is **1.91**. | manifest, `surfaces/vscode` | Refused as incompatible even before the entry point matters. |
| `extension.js` (3.4 MB bundle) requires `fs`, `child_process`, `os`, `net`, `tls`, `http(s)`, `crypto`, `readline`, … and calls `spawn()` in ~10 places. | grep over the bundle | Needs a Node runtime, or shims for each of those. |
| It starts `resources/native-binary/claude` (324 MB, a Bun-compiled executable, one per platform) and talks to it over stdio. The chat UI is a webview (`webview/index.js`, 6 MB) that doesn't care where it runs. | file listing, `file(1)` | The model-facing logic is the binary, not the extension. |

The npm package `@anthropic-ai/claude-code` is now just a launcher for the same
binaries (`@anthropic-ai/claude-code-linux-x64-musl` …), so there is no
plain-JS CLI to run under the VM's Node either.

## What I ran: the CLI on the repo's VM

`images/test/claude-probe.mjs` boots the **x86_64** machine under Node, copies
the `linux-x64-musl` binary (from `npm pack @anthropic-ai/claude-code-linux-x64-musl`)
into the guest, and runs a command.

```
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  images/test/claude-probe.mjs path/to/claude --mem=1536 --cmd="claude --version"
```

| Command in the guest | Result |
|---|---|
| `claude --version` | `2.1.318 (Claude Code)`, 3–4 s |
| `claude auth status` | JSON, `loggedIn: false`, 43 s (first start) |
| `claude -p 'say hi' --output-format json` | runs to the API layer and answers `Not logged in · Please run /login`, 41 s of the run |

- It works on the 64-bit machine only (the i686 kernel can't execute x86-64
  code). That machine is experimental and has **no playgrounds** yet.
- **RAM: 1536 MiB works; 2048 MiB and above crashes** the emulator at boot
  (`RangeError: offset is out of bounds` in `libv86.mjs`, with 2048 and 3072).
  Memory needs to be set as `n * 1024 * 1024`; `n << 20` overflows at 2048.
- The binary is 324 MB and goes into the guest in under a second (an in-memory
  inode). A browser would have to fetch it, so a deployed playground ships
  ~150 MB compressed unless it is fetched on demand.
- Startup is slow (tens of seconds) on one emulated core. Usable, not snappy.
- I did **not** run a real conversation: that needs credentials, and I used
  none.

## What blocks it, in order

1. **Nothing hosts the extension.** Two ways, neither small:
   - *A Node extension host inside the VM* (a VS Code server on Alpine/x86_64,
     the workbench attached to it as a remote). Honest guess: it doesn't fit in
     1.5 GB and one slow core next to the `claude` process, and the workbench
     would need to be a version that matches a current server.
   - *Run `extension.js` in the browser's extension host with shims* for
     `child_process`, `fs`, `os`… mapped onto the runtime, a patched `engines`,
     and any 1.92–1.94 API it uses on a 1.91 workbench. `spawn()` is the hard
     part: the runtime's `exec` is **one-shot** (stdin in, stdout/stderr out when
     the process ends, `runtime.ts:228`). The extension needs a long-lived,
     bidirectional pipe to `claude` (stream-json). That means a new streaming
     `spawn` in the Go guest agent and in the runtime protocol.
2. **Login can't complete in a browser tab.** Login is "open a URL, paste the
   code back", and the CLI then POSTs the code to
   `platform.claude.com/v1/oauth/token`. Through the web gate that is a browser
   `fetch` from the gate's origin, and the endpoint answers the preflight with
   **`400 Disallowed CORS origin`** (also `console.anthropic.com`, the
   `/api/oauth/*` endpoints and `claude.ai`; I checked with `OPTIONS` from
   `curl` using a `*.localhost` Origin). The bridge extension (Chrome only,
   per-site approval) is the repo's answer to that; its content script
   currently matches only `http://gate.localhost/*`, not a desolate/Pages gate.
3. **Even with a token, the Messages API needs a header the CLI doesn't send.**
   `api.anthropic.com` answers a preflight with `200` and
   `access-control-allow-origin: *` **only if** the request lists
   `anthropic-dangerous-direct-browser-access`; without it, `400`. The gate would
   have to add that header for `api.anthropic.com` (the gate only forwards a
   safelist of headers unless the request carries a secret, `core.ts:292`). The
   host also isn't in the default policy list (`default-policy.ts`), so the user
   would have to allow `api.anthropic.com` and the OAuth hosts.

## Ways forward (a decision for the maintainer)

- **A. Probe, then shim (smaller).** Add a streaming `spawn` to the guest agent
  and runtime protocol; run `extension.js` in the existing web extension host
  with node shims; build an x86_64 `claude` playground that restores a
  snapshot with the binary in place. Authenticate with a long-lived token from
  `claude setup-token` run on the user's own machine, pasted into the gate as a
  secret (`CLAUDE_CODE_OAUTH_TOKEN`), with the gate adding the browser-access
  header for `api.anthropic.com`. That is a "code", but not the in-app
  `/login` flow.
- **B. Keep the in-app login.** As A, plus a way past the OAuth CORS refusal: a
  small relay on a host the maintainer controls (breaks the "everything
  client-side" rule), or the bridge extension extended to the gate's origin.
- **C. Real VS Code server in the VM**, the workbench as a remote. Most faithful
  to "the extension runs unmodified"; the least likely to fit the memory and
  speed of the emulated machine, and it needs a newer workbench build.
- **D. Skip the extension.** The CLI runs in the VM's terminal today (once the
  binary is on the disk), with the same login and CORS limits.

## Not verified

- That vscode-web 1.91 rejects the `.vsix` — inferred from the manifest
  (`engines`, no `browser` entry), not run.
- Anything past "Not logged in": a prompt/response round trip, the OAuth
  exchange itself (I did not send a real code), or `stream-json` mode.
- Behaviour in a browser: the probe runs headless under Node with the node
  `fetch`, so none of the CORS findings above were exercised through the real
  gate. They come from `OPTIONS` requests.
