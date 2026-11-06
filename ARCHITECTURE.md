# Architecture

This is the map of the layers and the contracts between them. Each layer's
README has the details; the top-level README has the commands.

browser-vm is a platform for building **browser VMs**: web pages that run a real
Linux computer inside the visitor's browser, with an editor (or an agent)
attached, and a network the user controls. Everything runs client-side; a build
is a few folders of static files.

This repository is a monorepo. Each layer is its own package with a small
contract, and each layer has more than one implementation, so the seams are
visible. An **app** picks one implementation per layer, and `npm run build`
turns it into deployable folders.

```
                 ┌──────────────────────────────────────────────────────────────┐
  apps/          │ an app = machine + images + surfaces + gate (+ previews)      │  ide, python
                 └──────────────────────────────────────────────────────────────┘
                         │ built by tools/ into dist/<app>/{site,gate,preview}/
  surfaces/      VS Code · lite · MCP          what the user (or an agent) touches
                         │ the runtime protocol (rpc.ts): files, terminals, exec, ports, previews
  host/          runtime frame · runtime host · preview origins     how a web page runs a VM
                         │
  runtime/       Runtime API · LinuxVM · guest half (vm-init, agent) · network stack (tls)
                 │                         │
                 │ boots                   │ every guest request goes through a Gate
  machines/      i686 · x86_64             gates/   web (own origin, vault) · node (policy)
  images/        base · playgrounds              core (policy engine, shared)
```

## The layers

### 1. Machines: the computer (`machines/`)

An emulator build (WebAssembly), PC firmware, and a Linux kernel built for that
emulator. Identified by its architecture.

| Machine | Emulator | Kernel |
|---|---|---|
| `i686` (default) | upstream v86, from npm | `machines/i686/kernel.config` |
| `x86_64` (experimental) | the v86_64 fork, vendored in `machines/x86_64/emulator/` | `machines/x86_64/kernel.config` |

Contract: `machine(arch)` in `machines/index.mjs` resolves the emulator
(`libv86.mjs`, `v86.wasm`), firmware and kernel.

### 2. Images: what's on the computer's disk (`images/`)

A root filesystem in v86's 9p format (`fs.json` plus content-addressed blobs),
optionally with a **snapshot** (RAM, CPU and devices) to resume instead of boot.

| Image | Kind | Built by |
|---|---|---|
| `base` | cold boot | `images/base/` (a Dockerfile) |
| playgrounds (`python-3.12`, `svelte-vite`, …) | snapshot | `images/builder/` from `images/playgrounds/<id>/playground.json` |

Contract: every image contains the runtime's guest half (`/sbin/vm-init`,
`/sbin/vm-agent`). A snapshot only restores on the exact machine (emulator and
kernel) it was made on; its `manifest.json` records both.

### 3. Runtime: runs one machine with one image (`runtime/`)

`Runtime` (`runtime/src/runtime.ts`) owns the VM and is the only API above it:
files, search, terminals, `exec`, ports, previews. It works in-process (Node) or
across a message channel (`runtime/src/rpc.ts`), so a frontend never touches
the emulator. It has a host half (TypeScript) and a guest half (`runtime/guest/`:
`vm-init` as PID 1, the agent on a serial port), plus the guest's network stack
(`net.ts` and `runtime/tls/`, which ends the guest's TCP and HTTPS in JavaScript).

Contract with the layer below: a machine's assets and an image's files in one
asset folder. Contract with the gate: the runtime makes no network request for
the guest itself. It is given a `Gate` (`runtime/src/gate.ts`) and sends every
guest request through it. No gate, no network.

### 4. Gates: the VM's only way out (`gates/`)

A `Gate` is `fetch()` plus a few hooks (`connect` for notices and secret
placeholders, `show` for its UI): it decides which guest requests leave, and
may substitute secrets the guest only knows as placeholders.

| Gate | Where it runs | Used by |
|---|---|---|
| `gates/web` | its own web origin, in a hidden iframe; vault in that origin's IndexedDB; settings popup | browser apps |
| `gates/node` | in-process, policy only (no secrets) | the MCP server, tests |
| `gates/core` | (not a gate: the policy engine both use) | |

The web gate has three pieces, one per context: the gate app (`gates/web/app/`,
served on the gate origin), the relay (`relay.ts`, on the page) and the client
(`client.ts`, the `Gate` the runtime is given, in the runtime worker).

### 5. Host: how a web page runs a VM (`host/`)

- **Runtime frame** (`host/runtime-frame/`): a hidden iframe whose CSP allows no
  network except its own site; it starts the runtime worker and hands it the
  web gate's client.
- **Runtime host** (`host/src/runtime-host.ts`): the script a page includes to
  get a runtime: it embeds the frame and names the channel to reach it.
- **Preview origins** (`host/preview/`): one origin per guest port, served
  by a service worker that forwards requests to the guest's server.

### 6. Surfaces: what the user touches (`surfaces/`)

Clients of the runtime protocol. A surface imports only `@browser-vm/runtime/rpc`
and the runtime's types.

| Surface | What it is |
|---|---|
| `surfaces/vscode` | Code-OSS (web) with a thin extension that maps the runtime to VS Code's file system, terminal and search APIs |
| `surfaces/lite` | one page: file tree, CodeMirror, xterm.js, preview pane |
| `surfaces/mcp` | an MCP server for AI agents (Node); it hosts the runtime itself, with the node gate |

### 7. Apps: browser VMs (`apps/`)

An app is a config file, `apps/<name>/app.config.mjs`:

```js
export default {
  title: "Code in a Browser VM",
  machine: "i686",                         // --arch / VM_ARCH override it
  image: "base",
  playgrounds: "all",                      // or ["python-3.12"], or []
  surfaces: { "/": "vscode", "/lite/": "lite" },
  gate: "web",                             // or "none": no network
  previews: true,
};
```

| App | What it is |
|---|---|
| `apps/ide` | VS Code at `/`, lite at `/lite/`, every playground, the web gate (what this repo deploys) |
| `apps/python` | lite only, starting in the Python playground, no previews |

## The build

`npm run build [-- <app>]` (`tools/build.mjs`) produces one folder per origin.
The default app is `ide`.

```
dist/<app>/
  site/      the app's origin              https://ide.example.com/        (or GitHub Pages)
    site.js                                deployment config, generated
    host/runtime-host.js, host/gate-relay.js
    host/runtime/                          the runtime frame and worker
    vm/                                    machine + images: v86.wasm, bzImage, fs.json, rootfs/, playgrounds/
    <surfaces at their paths>              index.html + vscode/ + extensions/ at /, lite/ at /lite/
  gate/      the gate's origin             https://gate.example.com/
  preview/   preview origins (wildcard)    https://{id}.preview.example.com/
  bridge-extension/                        optional Chrome extension for the gate (load unpacked; not deployed)
```

Each folder is plain static files: upload each to its own origin. Origins are
build-time settings (`IDE_URL`, `GATE_URL`, `PREVIEW_URL`), not part of the app.
Locally, `npm start` serves all three from one port, routing by host name:
`localhost` → `site/`, `gate.localhost` → `gate/`, `*.preview.localhost` → `preview/`.

Each buildable package exports a **part** (`build.mjs`): the esbuild bundles it
needs and the files it copies or generates, written into the right folder.
`tools/` composes the parts an app names; `npm run dev` runs the same parts in
watch mode.

## Who may import whom

```
machines  ← nothing                       images   ← machines, runtime (builder only)
runtime   ← v86                           gate-core ← nothing
gate-web  ← gate-core, runtime (types)    gate-node ← gate-core, runtime (types)
host      ← runtime, gate-web (client)    surfaces ← runtime/rpc + types (mcp: runtime, gate-node)
tools     ← every package's part          apps     ← nothing (config only)
```

Each package's `package.json` `exports` is its public API; TypeScript, esbuild
and Node all refuse deep imports past it. The runtime also exports
`./internals/*` for image builders and boot tests, which drive v86 directly.
One edge is type-only: each package's `build.mjs` takes its `Part` and
`BuildContext` types from `@browser-vm/tools` (JSDoc), the way a plugin takes
its host's types.

## Adding to the platform

- **A surface**: a package in `surfaces/` with a `build.mjs` part; connect with
  `connect<Runtime>(channelEndpoint(new BroadcastChannel(window.__vmRuntimeChannel)))`
  after including `site.js`, `host/gate-relay.js` and `host/runtime-host.js`.
- **A playground**: a folder in `images/playgrounds/`, then `npm run playgrounds`.
- **A gate**: implement `Gate` from `@browser-vm/runtime`. In a browser it must
  run on its own origin, because the runtime frame can't reach the network.
- **A machine**: an entry in `machines/index.mjs` with an emulator, a kernel
  config and a prebuilt kernel.
- **An app**: `apps/<name>/app.config.mjs`, then `npm run build -- <name>`.

## Where things moved (from the single-package layout)

| Before | After |
|---|---|
| `runtime/src/*` | `runtime/src/*` (`worker.ts` → `host/runtime-frame/`) |
| `runtime/src/gate-client.ts`, `types/gate-protocol.ts` | `gates/web/src/client.ts`, `gates/web/src/protocol.ts` |
| `web/gate/*` | `gates/web/app/*`; `core.ts` → `gates/core/src/`, `defaultPolicy` → `gates/core/src/default-policy.ts` |
| `web/gate-relay.ts` | `gates/web/src/relay.ts` |
| `bridge-extension/` | `gates/web/bridge-extension/` |
| `web/runtime/*`, `web/runtime-host.ts`, `web/__vm_preview__/*`, `web/globals.d.ts` | `host/` (`runtime-frame/`, `src/`, `preview/`, `types/`) |
| `web/index.html`, `web/boot.ts`, `web/amd-config.ts`, `extension/` | `surfaces/vscode/` |
| `web/lite/` | `surfaces/lite/` |
| `mcp/` | `surfaces/mcp/` (its policy gate → `gates/node/`) |
| `guest/vm-init`, `guest/vm-agent`, `guest/agent/` | `runtime/guest/` |
| `tls/`, `vendor/go/` | `runtime/tls/` |
| `guest/Dockerfile`, `overlay/`, `welcome/`, `build-rootfs.sh` | `images/base/` (`build.sh`; vm-init and vm-agent come in as a second build context) |
| `playgrounds/` | `images/playgrounds/` |
| `scripts/build-playgrounds.mjs`, `tools/*.py` | `images/builder/` |
| `guest/build-kernel.sh`, `guest/kernel*.config` | `machines/kernel/`, `machines/<arch>/` |
| `vendor/seabios.bin`, `vgabios.bin` | `machines/firmware/` |
| `vendor/v86_64/`, `scripts/fetch-v86_64.mjs`, `build-v86_64.sh` | `machines/x86_64/` (`emulator/`, `fetch-emulator.mjs`, `build-emulator.sh`) |
| `guest/prebuilt/` | split by owner: kernels → `machines/<arch>/prebuilt/`, base images → `images/base/prebuilt/`, agent → `runtime/guest/prebuilt/` |
| `scripts/targets.mjs` | `machines/index.mjs` (+ `images/index.mjs` for images, `runtime/assets.mjs` for the agent and `tls.wasm`) |
| `scripts/build-site.mjs`, `esbuild.config.mjs`, `dev.mjs`, `serve.mjs` | `tools/` and each package's `build.mjs` |
| `scripts/*-test.mjs` | next to what they test: `gates/web/test/` (gate), `images/test/` (boot, profile, compare machines), `runtime/test/` (runtime), `surfaces/mcp/test/` (mcp), `apps/ide/test/` (e2e) |
| `dist/` (one folder, served on every origin) | `dist/<app>/{site,gate,preview}/` |
