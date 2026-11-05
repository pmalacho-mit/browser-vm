#!/usr/bin/env bash
# Builds the in-browser TLS terminator (runtime/tls/main.go) to WebAssembly.
# A prebuilt copy ships in runtime/tls/prebuilt/; you only need this (and Go >= 1.22) to change it.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../build/tls   # the repo's build/ cache; runtime/assets.mjs prefers it over prebuilt/
mkdir -p "$OUT"
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$OUT/tls.wasm" .
echo "built build/tls/tls.wasm ($(du -h "$OUT/tls.wasm" | cut -f1))"
