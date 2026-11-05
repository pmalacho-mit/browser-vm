#!/usr/bin/env bash
# Rebuilds machines/x86_64/emulator/ (the 64-bit emulator used when VM_ARCH=x86_64) FROM
# SOURCE, at a pinned commit of https://github.com/pmalacho-mit/v86_64 (this
# project's fork of portlandhodl/v86_64).
#
# Usually you want `npm run emulator:x86_64` instead (machines/x86_64/fetch-emulator.mjs): it takes the
# fork's own CI build and verifies it. Build from source to check that build,
# or to try a commit the fork's CI hasn't released. Expect different bytes than
# CI (toolchain versions), with the same behavior; run both test:boot variants.
#
# Needs: git, rustup with the wasm32-unknown-unknown target, clang (with the
# wasm32 target, i.e. any normal LLVM clang), make, Java (Closure Compiler),
# and optionally binaryen's wasm-opt (npm i -g binaryen) for a smaller, faster build.
#
#   machines/x86_64/build-emulator.sh                 # pinned commit
#   V86_64_COMMIT=<sha> machines/x86_64/build-emulator.sh
#   V86_64_REPO=<owner>/v86_64 V86_64_COMMIT=<sha> machines/x86_64/build-emulator.sh   # another fork
set -euo pipefail
cd "$(dirname "$0")/../.."   # the repo root: build/ is its artifact cache
COMMIT="${V86_64_COMMIT:-4e9b7b4cc912507919d9f37991eefab51e12d9f9}"
REPO="${V86_64_REPO:-pmalacho-mit/v86_64}"
SRC=build/v86_64-src
OUT=machines/x86_64/emulator

if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none "https://github.com/$REPO" "$SRC"
fi
git -C "$SRC" remote set-url origin "https://github.com/$REPO"
git -C "$SRC" fetch -q origin "$COMMIT" 2>/dev/null || true
git -C "$SRC" checkout -q "$COMMIT"

rustup target add wasm32-unknown-unknown >/dev/null
command -v wasm-opt >/dev/null || echo "note: wasm-opt not found; the build works but is ~20% larger and slower (npm i -g binaryen)"

make -C "$SRC" build/v86.wasm build/v86-fallback.wasm build/libv86.mjs

mkdir -p "$OUT"
cp "$SRC/build/v86.wasm" "$SRC/build/v86-fallback.wasm" "$SRC/build/libv86.mjs" "$SRC/LICENSE" "$SRC/LICENSE.MIT" "$OUT/"
echo "machines/x86_64/emulator rebuilt from source at $COMMIT."
echo "Update machines/x86_64/emulator/PROVENANCE.md (commit, \"built from source\", checksums) before committing."
(cd "$OUT" && sha256sum libv86.mjs v86.wasm v86-fallback.wasm)
