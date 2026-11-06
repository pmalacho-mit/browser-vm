# Machines: the computer

A machine is the hardware and the kernel: an x86 emulator compiled to
WebAssembly, PC firmware, and a Linux kernel built for that emulator. Images
(`../images/`) supply everything above the kernel, like a container on a host.

| Machine | Emulator | Kernel | Go programs |
|---|---|---|---|
| `i686` (default) | upstream [v86](https://github.com/copy/v86), from npm (BSD-2) | `common.config` + `i686/kernel.config` | yes |
| `x86_64` (experimental) | the [v86_64](https://github.com/pmalacho-mit/v86_64) fork, vendored in `x86_64/emulator/` | `common.config` + `x86_64/kernel.config` | yes |

```
machines/
  index.mjs              machine(arch): resolves the emulator, firmware and kernel for one machine
  firmware/              SeaBIOS + VGABIOS (LGPLv3), the same for every machine
  kernel/                build.sh (one script for every machine), common.config
  i686/                  kernel.config, prebuilt/bzImage
  x86_64/                kernel.config, prebuilt/bzImage,
                         emulator/ (libv86.mjs, v86.wasm, PROVENANCE.md), fetch-emulator.mjs, build-emulator.sh
```

Pick a machine with `--arch=…` or `$VM_ARCH`; an app's `machine` is the
default (`../apps/`). Every script takes it: `npm run build:x86_64`,
`test:boot:x86_64`, `kernel:x86_64`, `image:x86_64`. Locally built kernels
(`build/kernel/`, `build/kernel-x86_64/`) win over the prebuilt ones here.

The runtime bundles the machine's emulator: `import { V86 } from "v86"` is
pointed at the machine's `libv86.mjs` at build time (`../host/build.mjs`), and
the runtime learns which machine it has from one build define,
`__VM_MACHINE__` (`{ arch }`). Types always come from the npm v86 package.

## The kernel

`tinyconfig` plus virtio-pci, 9p, 8250 serial and devtmpfs, all built in, so
there's no initramfs and no modules. 2 MB. The 32-bit kernel needs
`CONFIG_COMPAT_32BIT_TIME`: without it, `futex(2)` returned ENOSYS, Go programs
crashed, npm failed, and V8 ran several times slower (`node -e 1`: 12.5 s → 2.9 s).

```
npm run kernel             # → build/kernel/bzImage (first run clones Linux, ~2 GB)
npm run kernel:x86_64      # → build/kernel-x86_64/bzImage
```

It builds natively on Linux (gcc, make, flex, bison, bc, lz4), cross-compiles
on ARM hosts (`gcc-i686-linux-gnu`, `gcc-x86-64-linux-gnu`), and uses a Debian
container elsewhere. The kernels in `prebuilt/` are unmodified v6.18 with these
configs (GPLv2).

## Boot speed

`npm run profile:boot` (`../images/test/boot-profile.mjs`) prints a cold-boot
timeline, then snapshots the booted VM and times a restore. Measured in Node
(2 CPU cores):

| | to shell prompt |
|---|---|
| original kernel (XZ, legacy ptys, VT, PS/2 input) | 9.5 s |
| current kernel (`common.config`, "boot speed" block) | 4.9 s |
| restore a booted snapshot (128 MiB RAM; 2.7 MB zstd) | 0.3–0.9 s |

Where the remaining cold boot goes: ~0.1 s emulator load, ~0.4 s firmware and
LZ4 decompression, ~1.2 s kernel init, ~1.9 s `vm-init` (about 20 short-lived
processes, each re-reading busybox over 9p). In the browser, the VS Code
surface shows a running VM about 4 s after load (the runtime starts with the
page, in parallel with the workbench); a playground restore, 1.4–2.7 s.

Snapshots (`emulator.save_state()`) restore in ~0.1 s at 128 MiB RAM but
~1.1 s at 512 MiB: restore cost scales with RAM size, not with what's in it.

## x86_64 (experimental)

Measured on a 2-core aarch64 dev container:

| | i686 | x86_64 |
|---|---|---|
| headless Chromium, page load → VM running | 4.1 s | 5.1 s |
| Node, boot → agent ready | 2.1 s | 2.5 s |
| shell loop / sha256 8 MB / gzip 8 MB / 64-bit math | 1.9 / 3.8 / 8.1 / 9.5 s | 2.1 / 2.0 / 7.1 / 7.7 s |

The payoff is software that ships only 64-bit builds. Biome 2.6.5's x86_64
binary from npm (`@biomejs/cli-linux-x64-musl`) runs on it (`biome --version`
in 1.4 s); the 32-bit kernel can't execute it. `npm run compare:vm` and
`compare:vm:x86_64` (`../images/test/compare-machines.mjs`) boot either machine
and run the benchmarks; give it a `libv86.mjs`, `v86.wasm`, kernel and image to
try any other emulator build.

**Known gaps.** One CPU, guest RAM below 4 GiB, no AVX. Go programs used to
abort ("sysMemStat overflow": the fork's 64-bit `XADD` and `CMPXCHG` weren't
restartable after a page fault); fixed in the fork at `d26cf8d2` (its issue
#5), so the machine now runs the Go guest agent (`exec`, `ports`, `refresh`).
There are no 64-bit playgrounds yet: none has been built or tried on this machine.

**Where the emulator comes from.** `emulator/PROVENANCE.md` records the pinned
commit and why its files can be trusted: they are the fork's own CI build of
that commit, checked against GitHub's recorded checksums.

```
npm run emulator:x86_64          # update emulator/ from the fork's latest CI release (verified)
machines/x86_64/build-emulator.sh   # or build a commit from source (Rust, clang, Java)
```

The fork is young and maintained by one person; keep i686 the default until it
matures or upstream v86 adopts 64-bit.

## Adding a machine

An entry in `MACHINES` (`index.mjs`): the emulator folder (`libv86.mjs`,
`v86.wasm`, `v86-fallback.wasm`), kernel candidates, and whether Go runs on it.
Add a `kernel.config` fragment and a prebuilt kernel, a case in
`kernel/build.sh`, and a base image for the architecture (`../images/base/`).
