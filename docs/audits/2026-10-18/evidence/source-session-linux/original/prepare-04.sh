#!/usr/bin/env bash
set -euo pipefail
diag_root=/root/heimdall-node22-diagnosis-20261018
exec > >(tee "$diag_root/logs/prepare-04.log") 2>&1
export PATH="$diag_root/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export NO_PROXY=127.0.0.1,localhost
export no_proxy="$NO_PROXY"
export PLAYWRIGHT_BROWSERS_PATH="$diag_root/browsers"
cd "$diag_root/app-core"
node "$diag_root/tools/pnpm/bin/pnpm.mjs" --pm-on-fail=ignore --version
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node "$diag_root/tools/pnpm/bin/pnpm.mjs" \
  --pm-on-fail=ignore install --frozen-lockfile --ignore-scripts --store-dir "$diag_root/pnpm-store"
sha256sum package.json pnpm-lock.yaml
node node_modules/playwright/cli.js install --dry-run chromium
node node_modules/playwright/cli.js install-deps --dry-run chromium
printf 'STAGE_04_READY %s\n' "$diag_root"
