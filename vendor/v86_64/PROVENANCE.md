# vendor/v86_64

The emulator used when the site is built with `VM_ARCH=x86_64`: a fork of v86
that adds x86-64 long mode and a 64-bit JIT.

source:  https://github.com/portlandhodl/v86_64 (forked from copy/v86 on 2026-10-02)
commit:  c394574477b57eadfc859f593b4aecb08fa37cb6 (2026-10-15, "Merge pull request #43")
build:   the fork's own CI ("CI" workflow, push of that commit), published by
         github-actions[bot] as release `latest` on 2026-10-15T02:52:51Z
license: BSD-2-Clause (`LICENSE`); `src/floppy.js` contains MIT-licensed code (`LICENSE.MIT`).
         Both files are taken from the commit above.

| file | SHA-256 | what |
|---|---|---|
| `libv86.mjs` | `443d8bea59edb13fa701eb9f13bdc1e78a85925b75c005723c95ce5a4245d262` | JavaScript side (Closure Compiler build) |
| `v86.wasm` | `fc9e655c68eaf8aed50ccf987897bfb211ae793832b498a6d9c6a4733618ad2b` | CPU + JIT core |
| `v86-fallback.wasm` | `5438fe367c032bf45e9dac7dd23e5823f251525dc7e062c6a860d0d7707ecd13` | the same without SIMD/bulk memory, for engines lacking them |

The checksums match the digests GitHub records for the release assets, checked
on 2026-11-05. `libv86.mjs` was also rebuilt from source at that commit
(`make build/libv86.mjs` in `docs/v86_64-fork/.devcontainer`, linux/arm64) and
came out byte-identical. The `.wasm` files differ when rebuilt (newer Rust and
clang than the CI run), as expected. The release also has `v86-mem64.wasm` and debug builds, which
this project doesn't use.

## Updating

- `npm run v86_64` (`scripts/fetch-v86_64.mjs`) downloads the fork's current CI
  release, refuses anything not published by GitHub Actions, and checks every
  file against GitHub's recorded digest. It prints the commit and checksums for
  this file. The fork publishes only a moving `latest` release, so a past
  commit's build can't be downloaded later; these vendored files are the record.
- `scripts/build-v86_64.sh` builds a given commit from source instead (Rust with
  the wasm32 target, clang, Java for Closure Compiler, optionally binaryen).
  Expect different bytes than CI, with the same behavior.

Bump the commit deliberately, update this file, and rerun both
`npm run test:boot` and `npm run test:boot:x86_64`.

## History

The first copy of these files came from another agent's integration package,
built in a sandbox that couldn't reach static.rust-lang.org (Rust 1.91.1 with
`-Zbuild-std`, then `wasm-opt -O3`). Its `libv86.mjs` was byte-identical to
the CI release above. Its `.wasm` files differed (about 0.7 MB smaller each,
from `wasm-opt`) and couldn't be reproduced or verified, so they were replaced
with the CI build of the same commit.

## Status (Nov 2026)

Experimental. The fork is about a month old, maintained by one person, and its
contribution policy accepts only AI-generated changes. Upstream v86 has not
merged 64-bit support. This project's stack (9p root filesystem, serial
consoles, vm-init/vm-agent, fetch()/TLS network) runs on it unchanged; see
`npm run test:boot:x86_64` and `scripts/compare-64.mjs`. Known limits per the
fork's README: one CPU, guest RAM below 4 GiB, no AVX.

Found here (2026-11-05): **snapshot restore fails.** `save_state()` succeeds,
but an emulator started with that state panics on the next interrupt:
`Triple fault: page fault during #DF delivery, cr2=ec0` (`src/rust/cpu/cpu.rs:3756`).
This happens with the CI build and with a source build of the same commit; upstream
v86 restores the same project's 32-bit VM fine. Likely some 64-bit CPU state is
missing from the saved state. Not reported to the fork as of this date.
Reproduce with `npm run profile:boot:x86_64`; check again when bumping the commit.

It also relies on the same v86 internals as the 32-bit build
(`types/v86-internals.d.ts`: `fs9p`, `bus`, the fake network's TCP
connections). Re-check them when bumping the commit.
