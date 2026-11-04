#!/usr/bin/env bash
# Runs once when the dev container is created.
set -euo pipefail
cd "$(dirname "$0")/.."

# Behind an intercepting proxy (e.g. desolate), the proxy CA's env vars live in
# a profile script that non-login shells don't read. Pick them up if present.
for f in /etc/profile.d/*ca*.sh; do [ -f "$f" ] && . "$f"; done

echo "== system packages (kernel build + rootfs tools)"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends \
  build-essential flex bison bc lz4 python3 python3-pip \
  >/dev/null
# zstandard compresses the guest image's blobs (optional, but halves downloads)
sudo apt-get install -y -qq python3-zstandard >/dev/null 2>&1 \
  || pip3 install --quiet --break-system-packages zstandard

echo "== npm dependencies"
npm ci --no-audit --no-fund

echo "== headless Chromium for browser tests (Playwright)"
npx --yes playwright@1 install --with-deps chromium >/dev/null

echo "== first build"
npm run build

cat <<'EOF'

Ready. Common commands:
  npm start            serve dist/ on :8080, then open http://localhost:8080 (not 127.0.0.1)
  npm run test:boot    boot the VM headlessly in Node (consoles, 9p, network)
  npm run test:gate    unit tests for the network gate and vault
  npm run profile:boot boot timeline + snapshot size/restore time
  npm run tls          rebuild tls/prebuilt → build/tls/tls.wasm (Go)
  npm run kernel       rebuild the guest kernel (first run clones Linux, ~2 GB)
  npm run guest        rebuild the guest image from guest/Dockerfile (Docker)
Rebuild the site (npm run build) after any of the last three.
EOF
