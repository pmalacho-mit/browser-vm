#!/usr/bin/env bash
# Builds the guest kernel: Linux with virtio-9p, serial consoles etc. compiled
# in (see kernel.config + kernel-$VM_ARCH.config).
#
#   guest/build-kernel.sh                  # VM_ARCH=i686 (default) → build/kernel/bzImage
#   VM_ARCH=x86_64 guest/build-kernel.sh   # 64-bit → build/kernel-x86_64/bzImage
#
# Prebuilt kernels ship in guest/prebuilt/ (i686) and guest/prebuilt/x86_64/,
# so you only need this to change the kernel. On Linux it builds natively
# (needs gcc, make, flex, bison, bc, lz4); elsewhere inside a Docker container.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${KERNEL_VERSION:-v6.18}"
VM_ARCH="${VM_ARCH:-i686}"
case "$VM_ARCH" in
  i686)   KARCH=i386;   OUT=build/kernel ;;
  x86_64) KARCH=x86_64; OUT=build/kernel-x86_64 ;;
  *) echo "VM_ARCH must be i686 or x86_64 (got $VM_ARCH)" >&2; exit 1 ;;
esac
SRC=build/linux-src
OBJ="$PWD/build/kernel-obj-$VM_ARCH"   # out-of-tree, so both architectures can coexist
mkdir -p "$OUT" "$OBJ"

build() {
  [ -d "$SRC" ] || git clone --depth 1 --branch "$VERSION" https://github.com/torvalds/linux "$SRC"
  make -C "$SRC" O="$OBJ" ARCH="$KARCH" tinyconfig
  "$SRC"/scripts/kconfig/merge_config.sh -m -O "$OBJ" "$OBJ/.config" guest/kernel.config "guest/kernel-$VM_ARCH.config"
  make -C "$SRC" O="$OBJ" ARCH="$KARCH" olddefconfig
  make -C "$SRC" O="$OBJ" ARCH="$KARCH" -j"$(nproc)" bzImage
  cp "$OBJ/arch/x86/boot/bzImage" "$OUT/bzImage"
  echo "kernel ($VM_ARCH): $OUT/bzImage ($(du -h "$OUT/bzImage" | cut -f1))"
}

if [ "${1:-}" = "--inside" ] || { [ "$(uname -s)" = Linux ] && command -v gcc flex bison bc lz4 >/dev/null; }; then
  build
else
  echo "building in Docker (native toolchain not found)"
  docker run --rm -e VM_ARCH="$VM_ARCH" -e KERNEL_VERSION="$VERSION" -v "$PWD":/w -w /w debian:bookworm bash -c \
    "apt-get update -qq && apt-get install -y -qq build-essential flex bison bc lz4 git python3 >/dev/null && guest/build-kernel.sh --inside"
fi
