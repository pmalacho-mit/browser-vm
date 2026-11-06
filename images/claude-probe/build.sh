#!/usr/bin/env bash
# Builds the issue #5 probe image (Dockerfile here) into build/guest-claude:
# Debian x86_64 + openvscode-server + the Claude Code extension. Needs Docker
# with linux/amd64 emulation. Then:
#   node --experimental-strip-types images/test/vscode-server-probe.mjs --image=build/guest-claude --browser
set -euo pipefail
cd "$(dirname "$0")"
OPENVSCODE_VERSION="${OPENVSCODE_VERSION:-1.109.5}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.318}"
OUT="${OUT:-$PWD/../../build/guest-claude}"
IMAGE="browser-vm-claude-probe"

mkdir -p downloads
ovs="downloads/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz"
vsix="downloads/claude-code-${CLAUDE_CODE_VERSION}-linux-x64.vsix"
[ -s "$ovs" ] || curl -fsSL -o "$ovs" "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz"
[ -s "$vsix" ] || curl -fsSL -o "$vsix" "https://open-vsx.org/api/Anthropic/claude-code/linux-x64/${CLAUDE_CODE_VERSION}/file/Anthropic.claude-code-${CLAUDE_CODE_VERSION}@linux-x64.vsix"
# The versions this was tried with; other versions skip the check.
case "$OPENVSCODE_VERSION/$CLAUDE_CODE_VERSION" in
  1.109.5/2.1.318) sha256sum -c --quiet <<SUMS
b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363  $ovs
697fe5b83b4da1b78ee55d95f4c38e3549096f5ab5be494f3c968dc10a1d20d4  $vsix
SUMS
  ;;
esac

docker build --platform linux/amd64 --build-context guest=../../runtime/guest --build-context base=../base \
  --build-arg "OPENVSCODE_VERSION=$OPENVSCODE_VERSION" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" -t "$IMAGE" .

rm -rf "$OUT" && mkdir -p "$OUT"
cid=$(docker create --platform linux/amd64 "$IMAGE" /bin/true)
trap 'docker rm -f "$cid" >/dev/null' EXIT
docker export "$cid" -o "$OUT/rootfs.tar"
tar -f "$OUT/rootfs.tar" --delete .dockerenv 2>/dev/null || true
ZSTD=""; python3 -c "import zstandard" 2>/dev/null && ZSTD="--zstd" || echo "note: 'pip install zstandard' to compress blobs"
python3 ../builder/fs2json.py $ZSTD --out "$OUT/fs.json" "$OUT/rootfs.tar"
mkdir -p "$OUT/rootfs"
python3 ../builder/copy-to-sha256.py $ZSTD "$OUT/rootfs.tar" "$OUT/rootfs"
rm "$OUT/rootfs.tar"
echo "probe image: $OUT ($(du -sh "$OUT" | cut -f1), $(ls "$OUT/rootfs" | wc -l) blobs)"
