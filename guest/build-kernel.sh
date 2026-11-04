#!/usr/bin/env bash
# Builds the guest kernel: Linux (i386) with virtio-9p, serial consoles etc.
# compiled in (see kernel.config). Output: build/kernel/bzImage (~1.5 MB).
#
# A prebuilt bzImage ships in guest/prebuilt/, so you only need this to change
# the kernel. On Linux it builds natively (needs gcc, make, flex, bison, bc);
# elsewhere it builds inside a Docker container.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${KERNEL_VERSION:-v6.18}"
SRC=build/linux-src
OUT=build/kernel
mkdir -p "$OUT"

build() {
  [ -d "$SRC" ] || git clone --depth 1 --branch "$VERSION" https://github.com/torvalds/linux "$SRC"
  make -C "$SRC" ARCH=i386 tinyconfig
  "$SRC"/scripts/kconfig/merge_config.sh -m -O "$SRC" "$SRC/.config" guest/kernel.config
  make -C "$SRC" ARCH=i386 olddefconfig
  make -C "$SRC" ARCH=i386 -j"$(nproc)" bzImage
  cp "$SRC/arch/x86/boot/bzImage" "$OUT/bzImage"
  echo "kernel: $OUT/bzImage ($(du -h "$OUT/bzImage" | cut -f1))"
}

if [ "${1:-}" = "--inside" ] || { [ "$(uname -s)" = Linux ] && command -v gcc flex bison bc lz4 >/dev/null; }; then
  build
else
  echo "building in Docker (native toolchain not found)"
  docker run --rm -v "$PWD":/w -w /w debian:bookworm bash -c \
    "apt-get update -qq && apt-get install -y -qq build-essential flex bison bc lz4 git python3 >/dev/null && guest/build-kernel.sh --inside"
fi
