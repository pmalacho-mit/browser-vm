#!/usr/bin/env bash
# Builds the in-browser TLS terminator (tls/main.go) to WebAssembly.
# A prebuilt copy ships in tls/prebuilt/; you only need this (and Go >= 1.22) to change it.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../build/tls
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o ../build/tls/tls.wasm .
echo "built build/tls/tls.wasm ($(du -h ../build/tls/tls.wasm | cut -f1))"
