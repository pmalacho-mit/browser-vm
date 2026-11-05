# machines/x86_64/emulator

The emulator used when the site is built with `VM_ARCH=x86_64`: a fork of v86
that adds x86-64 long mode and a 64-bit JIT.

source:  https://github.com/pmalacho-mit/v86_64, this project's fork of
         https://github.com/portlandhodl/v86_64 (itself forked from copy/v86 on 2026-10-02)
commit:  4e9b7b4cc912507919d9f37991eefab51e12d9f9 (2026-11-05, "Merge pull request #2
         from pmalacho-mit/issue/1"): portlandhodl's c3945744 plus the 64-bit
         snapshot fix (03001ff1, "Save and restore the 64-bit CPU state")
build:   the fork's own CI ("CI" workflow, push of that commit), published by
         github-actions[bot] as release `latest` on 2026-11-05T04:46:44Z
license: BSD-2-Clause (`LICENSE`); `src/floppy.js` contains MIT-licensed code (`LICENSE.MIT`).
         Both files are taken from the commit above.

| file | SHA-256 | what |
|---|---|---|
| `libv86.mjs` | `91caf03ec451a667eecb2e9e494b16f674c803f76e92549f702f3f8419330561` | JavaScript side (Closure Compiler build) |
| `v86.wasm` | `f73d6b1f6a111263c5401c19f064809440aaf141aa6110bf2675ff8f428143b7` | CPU + JIT core |
| `v86-fallback.wasm` | `5adb41cdebe97570a4374268594f2619ef9ccf5c5a41ad44f8404818e9e8690c` | the same without SIMD/bulk memory, for engines lacking them |

The checksums match the digests GitHub records for the release assets, checked
on 2026-11-05 by `npm run v86_64` (now `npm run emulator:x86_64`; `V86_64_REPO=pmalacho-mit/v86_64` then, now
the default). The release also has `v86-mem64.wasm` and debug builds, which
this project doesn't use.

## Updating

- `npm run emulator:x86_64` (`machines/x86_64/fetch-emulator.mjs`) downloads the fork's current CI
  release, refuses anything not published by GitHub Actions, and checks every
  file against GitHub's recorded digest. It prints the commit and checksums for
  this file. The fork publishes only a moving `latest` release, so a past
  commit's build can't be downloaded later; these vendored files are the record.
- `machines/x86_64/build-emulator.sh` builds a given commit from source instead (Rust with
  the wasm32 target, clang, Java for Closure Compiler, optionally binaryen).
  Expect different bytes than CI, with the same behavior.

Bump the commit deliberately, update this file, and rerun both
`npm run test:boot` and `npm run test:boot:x86_64`.

## History

- 2026-11-05: moved from portlandhodl/v86_64 at `c3945744` to this project's
  fork at `4e9b7b4c`, for the snapshot fix. The previous files' SHA-256s were
  `443d8bea…` (libv86.mjs), `fc9e655c…` (v86.wasm), `5438fe36…` (v86-fallback.wasm);
  that `libv86.mjs` had been rebuilt from source and came out byte-identical.

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
`npm run test:boot:x86_64` and `images/test/compare-machines.mjs`. Known limits per the
fork's README: one CPU, guest RAM below 4 GiB, no AVX.

**Snapshot restore: fixed at `4e9b7b4c`.** Before, a restored 64-bit VM
triple-faulted on its next interrupt (`page fault during #DF delivery`): the
64-bit CPU state wasn't in the saved state. `npm run test:boot:x86_64` now
restores a snapshot and checks the shell answers and files survive.

**Still open: Go programs abort** ("sysMemStat overflow"), so the 64-bit VM
can't run the Go guest agent and keeps the image's shell agent (no `exec`,
`ports` or `refresh`). Playgrounds need the Go agent, so they stay 32-bit.

It also relies on the same v86 internals as the 32-bit build
(`types/v86-internals.d.ts`: `fs9p`, `bus`, the fake network's TCP
connections). Re-check them when bumping the commit.
