#!/usr/bin/env bash
# The base image: Dockerfile  ->  docker export  ->  v86 9p filesystem image
# (fs.json + content-addressed blobs) in build/guest (images/index.mjs prefers it
# over prebuilt/).
#
#   npm run image                                # default packages from the Dockerfile
#   PACKAGES="git python3" images/base/build.sh
#   BASE=my-local/alpine-x86 images/base/build.sh
#   VM_ARCH=x86_64 images/base/build.sh         # 64-bit image → build/guest-x86_64 (npm run image:x86_64)
set -euo pipefail
cd "$(dirname "$0")"
VM_ARCH="${VM_ARCH:-i686}"
case "$VM_ARCH" in
  i686)   PLATFORM=linux/386;   OUT="${OUT:-$PWD/../../build/guest}" ;;
  x86_64) PLATFORM=linux/amd64; OUT="${OUT:-$PWD/../../build/guest-x86_64}"; BASE="${BASE:-alpine:3.22}" ;;
  *) echo "VM_ARCH must be i686 or x86_64 (got $VM_ARCH)" >&2; exit 1 ;;
esac
IMAGE="browser-linux-ide-guest-$VM_ARCH"

# The runtime's guest half (vm-init, the shell agent) comes in as a second build context.
args=(--platform "$PLATFORM" --build-arg "PLATFORM=$PLATFORM" --build-context guest=../../runtime/guest -t "$IMAGE")
[ -n "${BASE:-}" ] && args+=(--build-arg "BASE=$BASE")
[ -n "${PACKAGES+set}" ] && args+=(--build-arg "PACKAGES=$PACKAGES")
docker build "${args[@]}" .

rm -rf "$OUT" && mkdir -p "$OUT"
cid=$(docker create --platform "$PLATFORM" "$IMAGE" /bin/true)
trap 'docker rm -f "$cid" >/dev/null' EXIT
docker export "$cid" -o "$OUT/rootfs.tar"
tar -f "$OUT/rootfs.tar" --delete .dockerenv 2>/dev/null || true

ZSTD=""; python3 -c "import zstandard" 2>/dev/null && ZSTD="--zstd" || \
  echo "note: 'pip install zstandard' to compress blobs (smaller downloads)"
python3 ../builder/fs2json.py $ZSTD --out "$OUT/fs.json" "$OUT/rootfs.tar"
mkdir -p "$OUT/rootfs"
python3 ../builder/copy-to-sha256.py $ZSTD "$OUT/rootfs.tar" "$OUT/rootfs"
rm "$OUT/rootfs.tar"
echo "base image: $OUT  ($(du -sh "$OUT" | cut -f1), $(ls "$OUT/rootfs" | wc -l) blobs)"
