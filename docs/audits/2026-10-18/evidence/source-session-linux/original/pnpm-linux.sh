#!/bin/sh
set -eu
diag_root=/root/heimdall-node22-diagnosis-20261018
export PATH="$diag_root/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PLAYWRIGHT_BROWSERS_PATH="$diag_root/browsers"
cd "$diag_root/app-core"
exec "$diag_root/runtime/bin/node" "$diag_root/tools/pnpm/bin/pnpm.mjs" --pm-on-fail=ignore "$@"
