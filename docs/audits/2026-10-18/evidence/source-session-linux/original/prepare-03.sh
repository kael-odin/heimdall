#!/usr/bin/env bash
set -euo pipefail
diag_root=/root/heimdall-node22-diagnosis-20261018
asset_root=/mnt/c/Users/44548/.codex/worktrees/defect-ticket-closure-d5/heimdall/core/workspace/_runs/wsl-node22-preparation-20261018
if [ -e "$diag_root" ]; then
  printf 'Refusing to replace existing directory: %s\n' "$diag_root" >&2
  exit 2
fi
mkdir -p "$diag_root"/{downloads,runtime,tools,logs,app-core,browsers}
exec > >(tee "$diag_root/logs/prepare-03.log") 2>&1
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export NO_PROXY=127.0.0.1,localhost
export no_proxy="$NO_PROXY"
export npm_config_fetch_timeout=30000
date -u --iso-8601=seconds
id
uname -a
cat /etc/os-release

cp "$asset_root/node-v22.23.3-linux-x64.tar.xz" "$diag_root/downloads/"
cp "$asset_root/SHASUMS256.txt" "$diag_root/downloads/"
(
  cd "$diag_root/downloads"
  grep '  node-v22.23.3-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check
)
tar -xJf "$diag_root/downloads/node-v22.23.3-linux-x64.tar.xz" -C "$diag_root/runtime" --strip-components=1
export PATH="$diag_root/runtime/bin:$PATH"
node --version
npm --version
sha256sum "$diag_root/runtime/bin/node"
cp -a /mnt/c/Users/44548/AppData/Roaming/npm/node_modules/pnpm "$diag_root/tools/pnpm"
node "$diag_root/tools/pnpm/bin/pnpm.mjs" --version

repo=/mnt/c/Users/44548/.codex/worktrees/ci-small-runner-concurrency/heimdall
cp "$repo/core/package.json" "$diag_root/app-core/package.json"
cp "$repo/core/pnpm-lock.yaml" "$diag_root/app-core/pnpm-lock.yaml"
sha256sum "$diag_root/app-core/package.json" "$diag_root/app-core/pnpm-lock.yaml"
(
  cd "$diag_root/app-core"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node "$diag_root/tools/pnpm/bin/pnpm.mjs" \
    install --frozen-lockfile --ignore-scripts --store-dir "$diag_root/pnpm-store"
)
node -e 'const p = require(process.argv[1]); console.log(JSON.stringify({name:p.name,version:p.version}));' \
  "$diag_root/app-core/node_modules/playwright/package.json"
printf 'STAGE_03_READY %s\n' "$diag_root"
