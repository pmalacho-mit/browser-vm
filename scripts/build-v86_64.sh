#!/usr/bin/env bash
# Rebuilds vendor/v86_64/ (the 64-bit emulator used when VM_ARCH=x86_64) FROM
# SOURCE, at a pinned commit of https://github.com/portlandhodl/v86_64.
#
# Usually you want `npm run v86_64` instead (scripts/fetch-v86_64.mjs): it takes the
# fork's own CI build and verifies it. Build from source to check that build,
# or to try a commit the fork's CI hasn't released. Expect different bytes than
# CI (toolchain versions), with the same behavior; run both test:boot variants.
#
# Needs: git, rustup with the wasm32-unknown-unknown target, clang (with the
# wasm32 target, i.e. any normal LLVM clang), make, Java (Closure Compiler),
# and optionally binaryen's wasm-opt (npm i -g binaryen) for a smaller, faster build.
#
#   scripts/build-v86_64.sh                 # pinned commit
#   V86_64_COMMIT=<sha> scripts/build-v86_64.sh
#   V86_64_REPO=<owner>/v86_64 V86_64_COMMIT=<sha> scripts/build-v86_64.sh   # another fork
set -euo pipefail
cd "$(dirname "$0")/.."
COMMIT="${V86_64_COMMIT:-c394574477b57eadfc859f593b4aecb08fa37cb6}"
REPO="${V86_64_REPO:-portlandhodl/v86_64}"
SRC=build/v86_64-src
OUT=vendor/v86_64

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
echo "vendor/v86_64 rebuilt from source at $COMMIT."
echo "Update vendor/v86_64/PROVENANCE.md (commit, \"built from source\", checksums) before committing."
(cd "$OUT" && sha256sum libv86.mjs v86.wasm v86-fallback.wasm)
