#!/usr/bin/env bash
set -euo pipefail

diag_root=/tmp/heimdall-node22-diagnosis-20261018
if [ -e "$diag_root" ]; then
  printf 'Refusing to replace existing directory: %s\n' "$diag_root" >&2
  exit 2
fi
mkdir -p "$diag_root"/{downloads,runtime,tools,logs,app-core,browsers}
exec > >(tee "$diag_root/logs/prepare-01.log") 2>&1
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
printf 'Prepared at: '
date -u --iso-8601=seconds
id
uname -a
cat /etc/os-release
dpkg --print-architecture
df -h /tmp

node_version=v22.23.3
node_archive=node-${node_version}-linux-x64.tar.xz
node_url=https://nodejs.org/download/release/${node_version}
curl --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 180 \
  "$node_url/$node_archive" -o "$diag_root/downloads/$node_archive"
curl --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 60 \
  "$node_url/SHASUMS256.txt" -o "$diag_root/downloads/SHASUMS256.txt"
(
  cd "$diag_root/downloads"
  grep "  $node_archive\$" SHASUMS256.txt | sha256sum --check
)
tar -xJf "$diag_root/downloads/$node_archive" -C "$diag_root/runtime" --strip-components=1
export PATH="$diag_root/runtime/bin:$PATH"
node --version
npm --version
sha256sum "$diag_root/runtime/bin/node"

npm install --prefix "$diag_root/tools" --cache "$diag_root/npm-cache" \
  --ignore-scripts --no-audit --fund=false pnpm@11.28.2
"$diag_root/tools/node_modules/.bin/pnpm" --version

repo=/mnt/c/Users/44548/.codex/worktrees/ci-small-runner-concurrency/heimdall
cp "$repo/core/package.json" "$diag_root/app-core/package.json"
cp "$repo/core/pnpm-lock.yaml" "$diag_root/app-core/pnpm-lock.yaml"
sha256sum "$diag_root/app-core/package.json" "$diag_root/app-core/pnpm-lock.yaml"
(
  cd "$diag_root/app-core"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "$diag_root/tools/node_modules/.bin/pnpm" \
    install --frozen-lockfile --ignore-scripts --store-dir "$diag_root/pnpm-store"
)
node -e 'const p = require(process.argv[1]); console.log(JSON.stringify({name:p.name,version:p.version}));' \
  "$diag_root/app-core/node_modules/playwright/package.json"
printf 'STAGE_01_READY %s\n' "$diag_root"
