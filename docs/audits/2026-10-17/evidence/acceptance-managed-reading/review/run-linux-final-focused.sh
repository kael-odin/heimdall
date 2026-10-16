#!/usr/bin/env bash
set -u
repo=/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall
out="$repo/core/workspace/_runs/managed-consumers-review-20261017"
node=/tmp/heimdall-managed-linux-runtime-20261017/node-v22.23.3-linux-x64/bin/node
archive="$repo/core/workspace/_runs/managed-linux-final-20261017/node-v22.23.3-linux-x64.tar.xz"
expected=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
actual=$(sha256sum "$archive")
if [[ "${actual%% *}" != "$expected" ]]; then printf '%s\n' 'archive SHA mismatch'; exit 2; fi
mkdir -p /tmp/heimdall-managed-linux-runtime-20261017
tar -xJf "$archive" -C /tmp/heimdall-managed-linux-runtime-20261017
export TMPDIR=/tmp
export PATH="/tmp/heimdall-managed-linux-runtime-20261017/node-v22.23.3-linux-x64/bin:$PATH"
cd "$repo/core"
files=(src/acceptance/managed-snapshot-schema.mjs src/acceptance/managed-run-reader.mjs src/acceptance/managed-dispatch-reader.mjs src/acceptance/store.mjs src/acceptance/run-view.mjs src/acceptance/catalog.mjs src/acceptance/cli.mjs src/engine-server.mjs src/acceptance/managed-run-schema.mjs src/acceptance/managed-run-store.mjs src/acceptance/managed-spec-plan.mjs test/acceptance-managed-snapshot-schema.test.mjs test/acceptance-managed-run-reader.test.mjs test/acceptance-managed-batch-edges.test.mjs test/acceptance-managed-consumers.test.mjs test/acceptance-managed-quarantine.test.mjs test/acceptance-run-view.test.mjs test/acceptance-managed-catalog.test.mjs test/acceptance-catalog.test.mjs test/acceptance-managed-spec-plan.test.mjs)
{
  date -u +%FT%TZ
  "$node" --version
  "$node" -p 'JSON.stringify({platform:process.platform,cwd:process.cwd(),execPath:process.execPath,tmpdir:require("node:os").tmpdir()})'
  printf 'source filesystem: '; stat -f -c %T "$PWD"
  printf 'fixture filesystem: '; stat -f -c %T "$TMPDIR"
  findmnt -n -o TARGET,FSTYPE,SOURCE -T "$PWD"
  findmnt -n -o TARGET,FSTYPE,SOURCE -T "$TMPDIR"
} > "$out/linux-final-environment.txt"
sha256sum "${files[@]}" > "$out/linux-final-sha-before.txt"
"$node" --test --test-reporter=tap test/acceptance-managed-snapshot-schema.test.mjs test/acceptance-managed-run-reader.test.mjs test/acceptance-managed-batch-edges.test.mjs test/acceptance-managed-consumers.test.mjs test/acceptance-managed-quarantine.test.mjs test/acceptance-run-view.test.mjs test/acceptance-managed-catalog.test.mjs test/acceptance-catalog.test.mjs test/acceptance-managed-spec-plan.test.mjs > "$out/linux-final-focused-tests.tap" 2>&1
exitCode=$?
printf '%s\n' "$exitCode" > "$out/linux-final-exit-code.txt"
sha256sum "${files[@]}" > "$out/linux-final-sha-after.txt"
cat "$out/linux-final-environment.txt"
tail -12 "$out/linux-final-focused-tests.tap"
exit "$exitCode"
