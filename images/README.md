# Images: what's on the computer's disk

An image is a root filesystem in v86's 9p format: `fs.json` (the file index:
names, modes, sizes, hashes) plus `rootfs/<sha256>.bin.zst`, one compressed
blob per file. The guest fetches a blob over HTTP the first time it reads the
file, so a bigger image costs disk space on the host but nothing at boot.

| Image | Kind | Source | Built by |
|---|---|---|---|
| `base` | cold boot | `base/Dockerfile` | `npm run image` (Docker) |
| playgrounds | snapshot (RAM, CPU, devices + the file index) | `playgrounds/<id>/playground.json` | `npm run playgrounds` (no Docker) |

```
images/
  index.mjs        baseImage(arch), builtPlaygrounds(machine), bootTarget(arch)
  base/            Dockerfile, overlay/ (shell profile, CA settings), welcome/ (the starter project),
                   build.sh, prebuilt/<arch>/ (fs.json + rootfs/)
  playgrounds/     one folder per playground: playground.json + template/
  builder/         build-playgrounds.mjs; fs2json.py and copy-to-sha256.py (from v86, BSD-2)
  test/            boot-test.mjs, boot-profile.mjs, compare-machines.mjs: boot an image on a machine under Node
```

**Every image contains the runtime's guest half**: `/sbin/vm-init` (PID 1) and
`/sbin/vm-agent` (the shell agent), from `../runtime/guest/`. That is the
image's contract with the runtime: shells on ttyS0, 2 and 3, the control
channel on ttyS1. The base image's Dockerfile copies them in from a second build
context; the playground builder copies them in itself. The kernel is not part
of an image: the machine supplies it (`../machines/`).

## The base image

Any `linux/386` image (`linux/amd64` for the x86_64 machine). `docker export`
→ `builder/fs2json.py` + `copy-to-sha256.py` → JSON index + content-addressed
zstd blobs.

```
npm run image                                   # needs Docker; output in build/guest/
PACKAGES="git python3 build-base" npm run image
npm run image:x86_64                            # → build/guest-x86_64/
npm run build                                   # an app build ships it
```

`build/guest` takes priority over `base/prebuilt/i686` when present. Keep the
two `COPY --from=guest` lines in the Dockerfile.

**The prebuilt base image is minimal (busybox + apk).** It was built in an
environment without access to Alpine's package mirror. On your machine,
`npm run image` installs the Dockerfile's default `git nodejs npm python3 nano less`.

`npm run test:boot` (`test/boot-test.mjs`) boots the base image headlessly in
Node and checks consoles, the 9p bridge in both directions, the agent (exec,
ports, resize), networking with a stub `fetch`, and a snapshot round trip. No
browser needed.

## Playgrounds

A playground starts from a snapshot instead of booting: a toolchain installed,
warmed up and waiting at a shell prompt, with a starter project in
`/root/project`. Open one with `?playground=<id>`, the VS Code command
*Linux VM: Open a Playground…*, or an app's `start` (`../apps/`). The fields of
`playground.json` are in `playgrounds/README.md`.

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
npm run build                        # an app ships the ones it asks for that match its machine
```

The builder (`builder/build-playgrounds.mjs`) needs no Docker and runs on ARM
hosts too: Alpine's minirootfs plus packages from Alpine's static `apk` for the
host, the packages' install scripts run inside the VM, then the warm-up, then
`save_state()`. All playgrounds share one content-addressed blob pool, so a
package two of them use is stored once.

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

**Rust, measured.** On the emulated CPU, in the restored playground:

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
says so.

**Snapshots are tied to their machine.** Each `manifest.json` records the
emulator and kernel it was built with (hashes); an app build skips a playground
built with different ones (rebuild it), and CI rebuilds them when anything that
goes into them changes. When the browser restores one, the agent's `refresh`
gives it this tab's clock, fresh randomness and the tab's CA (every copy of a
snapshot starts identical). Because the root filesystem lives in JavaScript,
files can be written into a restored VM without rebooting. i686 only for now
(see `../machines/README.md`).
