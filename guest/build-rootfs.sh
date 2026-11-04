#!/usr/bin/env bash
# Dockerfile  ->  docker export  ->  v86 9p filesystem image (fs.json + content-addressed blobs)
#
#   guest/build-rootfs.sh                       # default packages from the Dockerfile
#   PACKAGES="git python3" guest/build-rootfs.sh
#   BASE=my-local/alpine-x86 guest/build-rootfs.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/../build/guest}"
IMAGE=browser-linux-ide-guest

args=(--platform linux/386 -t "$IMAGE")
[ -n "${BASE:-}" ] && args+=(--build-arg "BASE=$BASE")
[ -n "${PACKAGES+set}" ] && args+=(--build-arg "PACKAGES=$PACKAGES")
docker build "${args[@]}" .

rm -rf "$OUT" && mkdir -p "$OUT"
cid=$(docker create --platform linux/386 "$IMAGE" /bin/true)
trap 'docker rm -f "$cid" >/dev/null' EXIT
docker export "$cid" -o "$OUT/rootfs.tar"
tar -f "$OUT/rootfs.tar" --delete .dockerenv 2>/dev/null || true

ZSTD=""; python3 -c "import zstandard" 2>/dev/null && ZSTD="--zstd" || \
  echo "note: 'pip install zstandard' to compress blobs (smaller downloads)"
python3 ../tools/fs2json.py $ZSTD --out "$OUT/fs.json" "$OUT/rootfs.tar"
mkdir -p "$OUT/rootfs"
python3 ../tools/copy-to-sha256.py $ZSTD "$OUT/rootfs.tar" "$OUT/rootfs"
rm "$OUT/rootfs.tar"
echo "guest image: $OUT  ($(du -sh "$OUT" | cut -f1), $(ls "$OUT/rootfs" | wc -l) blobs)"
