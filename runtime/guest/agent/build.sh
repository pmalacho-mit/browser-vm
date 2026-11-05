#!/usr/bin/env bash
# Builds the guest agent (runtime/guest/agent/main.go) for both VM architectures:
# static, no cgo, reproducible (-trimpath, -buildvcs=false, pinned toolchain).
# Output: build/agent/vm-agent-i686, build/agent/vm-agent-x86_64.
# Prebuilt copies ship in runtime/guest/prebuilt/; runtime/assets.mjs prefers build/.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../../build/agent
mkdir -p "$OUT"
for pair in i686:386 x86_64:amd64; do
  arch=${pair%%:*} goarch=${pair##*:}
  CGO_ENABLED=0 GOOS=linux GOARCH=$goarch GO386=sse2 \
    go build -trimpath -buildvcs=false -ldflags="-s -w" -o "$OUT/vm-agent-$arch" .
  echo "built build/agent/vm-agent-$arch ($(du -h "$OUT/vm-agent-$arch" | cut -f1))"
done
