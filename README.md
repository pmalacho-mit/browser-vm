# browser-vm

A platform for building **browser VMs**: web pages that run a real Linux
computer inside the visitor's browser, with an editor (or an AI agent)
attached, and a network the user controls. Everything runs client-side; a build
is a few folders of static files.

This repository has the platform's layers, two implementations or more of
each, and two apps built from them: `ide` (VS Code and a real Linux VM, what
this repo deploys) and `python` (a small Python sandbox).

```
npm install
npm run build          # the ide app → dist/ide/{site,gate,preview}/
npm start              # http://localhost:8080   (use "localhost", not 127.0.0.1)
npm run dev            # build, serve, and rebuild on every change

npm run build -- python && node tools/serve.mjs dist/python     # the other app
```

What the `ide` app gives you after a few seconds: an editor whose Explorer *is*
the VM's `/root/project`, terminals that are shells inside the VM, Ctrl+P and
Find in Files over the VM's files, edits that the guest sees immediately (and
vice versa), HTTP/HTTPS from inside the VM through a network gate that holds
your API keys, previews of servers running in the VM, and playgrounds that
restore a ready toolchain (Python, Node, Svelte, Rust) in about two seconds.

## The one idea

The VM's root filesystem is a JavaScript object. Linux mounts it as its disk
(virtio-9p), and every editor reads and writes the same object through the
runtime. There is one copy of every file and nothing to sync. Serial ports
carry terminals and a control channel; an emulated network card carries
traffic out through the gate and into the VM for previews.

## The layers

```
                 ┌──────────────────────────────────────────────────────────────┐
  apps/          │ an app = machine + images + surfaces + gate (+ previews)      │  ide, python
                 └──────────────────────────────────────────────────────────────┘
                         │ built by tools/ into dist/<app>/{site,gate,preview}/
  surfaces/      VS Code · lite · MCP          what the user (or an agent) touches
                         │ the runtime protocol: files, terminals, exec, ports, previews
  host/          runtime frame · runtime host · preview origins     how a web page runs a VM
                         │
  runtime/       Runtime API · LinuxVM · guest half (vm-init, agent) · network stack (tls)
                 │                         │
                 │ boots                   │ every guest request goes through a Gate
  machines/      i686 · x86_64             gates/   web (own origin, vault) · node (policy)
  images/        base · playgrounds              core (policy engine, shared)
```

| Layer | What it is | Implementations | Read |
|---|---|---|---|
| **machines** | the computer: emulator (x86 → WebAssembly), firmware, kernel | `i686` (upstream v86), `x86_64` (the v86_64 fork, experimental) | [machines/](machines/README.md) |
| **images** | what's on its disk | `base` (a Dockerfile, cold boot), playgrounds (snapshots) | [images/](images/README.md) |
| **runtime** | runs one machine with one image; the API every surface uses | in a browser worker, or in-process under Node | [runtime/](runtime/README.md) |
| **gates** | the VM's only way out: policy and secrets | `web` (its own origin, encrypted vault), `node` (policy only) | [gates/](gates/README.md) |
| **host** | how a page runs a VM: the network-locked runtime frame, preview origins | | [host/](host/README.md) |
| **surfaces** | what the user touches | VS Code, lite, MCP | [surfaces/](surfaces/README.md) |
| **apps** | browser VMs: one config each | `ide`, `python` | [apps/](apps/README.md) |
| **tools** | app → one folder per origin; local server; dev mode | | [tools/](tools/README.md) |

[ARCHITECTURE.md](ARCHITECTURE.md) has the contract between each pair of
layers, who may import whom, and how to add a surface, gate, machine,
playground or app. Each layer is an npm workspace package (`@browser-vm/…`)
whose `exports` is its public API.

## Development

```
npm run dev                # build, serve on :8080 (and the gate alone on :8081), rebuild on change
npm run typecheck          # every package (also in CI)

npm run test:gate          # the gate's policy and vault, under Node (~2 s)
npm run test:boot          # boot the base image on the machine under Node: consoles, 9p, agent, network, snapshots
npm run test:runtime       # the runtime through its protocol, with a fake gate (needs a build)
npm run test:mcp           # the MCP server, as an MCP client sees it (needs a build)
npm run test:e2e           # the ide app in headless Chromium (npx playwright install chromium first)
npm run test:e2e:python    # the python app (npm run build -- python first)

npm run kernel             # rebuild the machine's kernel           (machines/)
npm run image              # rebuild the base image (Docker)        (images/)
npm run playgrounds        # build the playground snapshots         (images/)
npm run agent / tls        # rebuild the guest agent / tls.wasm (Go) (runtime/)
npm run emulator:x86_64    # update the 64-bit emulator from its CI release (machines/)
```

Add `:x86_64` (`build:x86_64`, `dev:x86_64`, `test:boot:x86_64`,
`kernel:x86_64`, `image:x86_64`) for the 64-bit machine, or pass
`--arch=x86_64`. Locally built pieces land in `build/` and win over the
prebuilt ones checked in.

The browser code is TypeScript, compiled by esbuild; Node runs the `.ts`
files directly in tests and the MCP server (`--experimental-strip-types`).
Conventions, all enforced by `tsconfig.base.json`:

- **Imports name the real file** (`./core.ts`); across packages, the package
  name (`@browser-vm/runtime/rpc`).
- **Only type syntax that can be erased** (`erasableSyntaxOnly`): no `enum`,
  `namespace` or constructor parameter properties.
- **`import type`** for type-only imports (`verbatimModuleSyntax`).
- v86 APIs used beyond v86's own types are declared in
  `runtime/types/v86-internals.d.ts`. Re-check them when upgrading v86.

Build scripts, resolvers and tests stay JavaScript (`.mjs`), type-checked
through JSDoc (`tsconfig.scripts.json`). The optional bridge extension stays
JavaScript too, since Chrome loads it unbuilt.

## Deploying

A build makes one folder per origin; upload each to a static host (nginx, S3,
GitHub Pages; no special headers needed):

| Folder | Origin | Needed for |
|---|---|---|
| `dist/<app>/site/` | the app, e.g. `https://ide.example.com/` (any path works) | everything |
| `dist/<app>/gate/` | a second host name, e.g. `https://gate.example.com/` | the VM's network |
| `dist/<app>/preview/` | a wildcard, e.g. `https://*.preview.example.com/` | previews of servers in the VM |

Tell the build where they are:

```
IDE_URL=https://ide.example.com/ GATE_URL=https://gate.example.com/ \
PREVIEW_URL=https://{id}.preview.example.com/ npm run build
```

The build writes them into `site.js` in `site/` and `gate/`: the app's pages
read where the gate is, and the gate admits exactly that app origin and nothing
else. Set `IDE_URL` and `GATE_URL` both or neither. With neither, you get the
local layout (app on `localhost:<port>`, gate on `gate.localhost:<port>`), and
on any other host the VM has no network. The build reads only these variables,
so where you run it never changes the output.

- **Previews.** `{id}` becomes `<port>-<tab>`, one origin per port and tab, so
  this needs wildcard DNS and a wildcard TLS certificate. GitHub Pages can't do
  that; without `PREVIEW_URL`, previews work only on localhost.
- **Webviews** (VS Code's Markdown preview, extension UIs): see `WEBVIEW_HOST`
  in [surfaces/](surfaces/README.md#vs-code-vscode).
- **Behind a port forwarder** that gives each port one exact host name (GitHub
  Codespaces, tunnels, desolate), `gate.<host>` and `*.preview.<host>` won't
  reach you. Use more ports instead: `npm start` serves the gate alone on 8081
  and previews on 8082–8085, and you build with the forwarded URLs:
  `IDE_URL` (8080), `GATE_URL` (8081), and `PREVIEW_ORIGINS` (8082–8085, up to
  four previews at once). Under desolate, `npm run build:desolate` (or
  `dev:desolate`) does this; the dev container forwards all six ports. Gate
  settings and secrets are stored per origin, so a new gate origin starts with
  fresh ones.
- **GitHub Pages:** `.github/workflows/deploy-pages.yml` builds the `ide` app,
  runs the tests, and publishes `site/`. A single Pages site is one origin, so
  the gate needs a second host (see the workflow's comments).

The [gates README](gates/README.md) ends the web gate's section with a
deployment checklist.

## Limitations

- **No persistence.** Reloading reboots the VM from its image. Next step:
  `emulator.save_state()` into IndexedDB/OPFS, or sync `/root/project` to OPFS.
- **Network is HTTP(S) to CORS-enabled sites only** in a browser, plus sites
  approved in the gate's optional bridge extension. For full TCP you'd need a
  relay: v86 supports Wisp and WebSocket relays.
- **Previews need a wildcard origin** when deployed (or a few extra ports, up to
  one preview each), and load only from their own server (no CDNs). Streaming responses (server-sent events) arrive only
  when they end.
- **Speed.** Emulated x86 runs at a fraction of native speed: fine for shells,
  git and scripts, slow for heavy compiles (see the Rust measurements in
  [images/](images/README.md#playgrounds)). The editor itself runs natively.
- **32-bit by default.** The 64-bit machine is experimental and has no playgrounds yet ([machines/](machines/README.md#x86_64-experimental)).
- **Three terminals max** (one per serial port). More would need the agent to
  multiplex PTYs over one channel.
- **VS Code 1.91, web extensions only** ([surfaces/](surfaces/README.md#vs-code-vscode)).

## Licenses

Project code (including the bridge extension): MIT. Third-party pieces keep
their own licenses; [ATTRIBUTION.md](ATTRIBUTION.md) lists them all.
Code-OSS/vscode-web (MIT); v86 and `images/builder/*.py` (BSD-2, see
`images/builder/LICENSE.v86`); the v86_64 fork in `machines/x86_64/emulator/`
(BSD-2 with MIT-licensed parts; see that folder); the Go runtime in
`runtime/tls/prebuilt/tls.wasm`, the guest agent and `runtime/tls/wasm_exec.mjs`
(BSD-3, `runtime/tls/LICENSE.go`); SeaBIOS/VGABIOS in `machines/firmware/`
(LGPLv3); the Linux kernels in `machines/<arch>/prebuilt/bzImage` (GPLv2:
unmodified v6.18 source plus `machines/kernel/common.config` and
`machines/<arch>/kernel.config`); and Alpine packages in the images (various;
Alpine 3.22.7 minirootfs).
