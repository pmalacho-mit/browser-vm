# Handoff: fixing snapshot restore in the v86_64 fork

browser-linux-ide's 64-bit VM (`VM_ARCH=x86_64`) runs on the
[v86_64](https://github.com/portlandhodl/v86_64) fork, and that fork can't
restore a saved 64-bit state. This folder holds what an agent needs to fix it
in a fork of the fork:

| File | What it is |
|---|---|
| `snapshot-restore-issue.md` | The bug: cause (64-bit CPU state missing from `save_state()`), the fields involved, a suggested fix, how to reproduce it, tests to add, acceptance criteria. Written so it can also be filed on the fork as is. |
| `.devcontainer/` | The environment to do it in. Copy it into the fork, replacing the fork's own `.devcontainer/`. |

## The environment

The fork's own `.devcontainer/` builds an x86 (`linux/amd64`) image, which on an
Apple Silicon Mac means emulating x86 for everything, including Rust compiles.
This one runs natively on `linux/arm64` (desolate, colima, Docker Desktop) and
also works on x86 hosts:

- Debian 13 with Node 24, Rust stable (wasm32 target, plus the musl targets for
  `tests/api/memhog*`), clang 19 + lld, Java 21 for Closure Compiler, nasm, QEMU,
  and i686/x86-64 cross compilers on ARM hosts.
- Declared as `image` + features + `post-create.sh`, like this project's own
  devcontainer, so desolate can derive its CA-trusting base image from it.
- Port 8000 forwarded for `./tools/serve.mjs --port 8000`.

Checked on 2026-11-05 on linux/arm64 (a desolate container): the image and
setup script build cleanly, `make all-debug` and the release build succeed in
about 75 seconds, `build/libv86.mjs` comes out byte-identical to the fork's CI
build, and the snapshot bug reproduces with the freshly built emulator.

On an ARM host, everything except `make nasmtests` runs. Those tests execute x86
programs natively under `gdb` to record expected results, which needs a real x86
CPU; the fork's CI covers them on every push. `make qemutests` and
`make jitpagingtests` build 32-bit x86 test programs, so pass
`CC=i686-linux-gnu-gcc` on ARM.

## Steps

1. Fork <https://github.com/portlandhodl/v86_64> (*Fork* button, or
   <https://github.com/portlandhodl/v86_64/fork>) and clone your fork.
2. In the clone, replace `.devcontainer/` with this folder's `.devcontainer/` and
   open it in desolate.
3. Enable GitHub Actions on the fork (*Actions* tab). Forks start with Actions off;
   with them on, each push to `master` publishes a `latest` release, the same way
   the original fork does.
4. Give the agent `snapshot-restore-issue.md`.

## Pointing browser-linux-ide at the fixed fork

Once the fix is on your fork's `master` and its CI has published the release:

```
V86_64_REPO=<you>/v86_64 npm run v86_64   # downloads and verifies the CI build
npm run profile:boot:x86_64               # should now print "shell answered"
npm run test:boot && npm run test:boot:x86_64
```

Then update `vendor/v86_64/PROVENANCE.md` (source, commit, checksums), make the
fork the default in `scripts/fetch-v86_64.mjs` and `scripts/build-v86_64.sh`,
update ATTRIBUTION.md, and remove the "Known gap" note from the README's 64-bit
section.
