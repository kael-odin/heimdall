#!/usr/bin/env bash
set -euo pipefail
diag_root=/root/heimdall-node22-diagnosis-20261018
exec > >(tee "$diag_root/logs/prepare-06-system-deps.log") 2>&1
export PATH="$diag_root/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY="$HTTPS_PROXY"
export https_proxy="$HTTPS_PROXY"
export http_proxy="$HTTP_PROXY"
export NO_PROXY=127.0.0.1,localhost
export no_proxy="$NO_PROXY"
export DEBIAN_FRONTEND=noninteractive
cd "$diag_root/app-core"
node node_modules/playwright/cli.js install-deps chromium
printf 'STAGE_06_READY %s\n' "$diag_root"
