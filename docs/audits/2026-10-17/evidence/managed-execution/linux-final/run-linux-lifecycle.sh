#!/usr/bin/env bash
set -euo pipefail
repo=/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall
out="$repo/core/workspace/_runs/managed-execution-http-lifecycle-linux-20261017/final-fixture-20261017"
archive="$repo/core/workspace/_runs/managed-linux-final-20261017/node-v22.23.3-linux-x64.tar.xz"
expected=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
actual=$(sha256sum "$archive")
[[ "${actual%% *}" == "$expected" ]]
taskroot=$(mktemp -d /tmp/heimdall-http-final-20261017.XXXXXX)
tar -xJf "$archive" -C "$taskroot"
cp -R "$out/snapshot" "$taskroot/project"
node="$taskroot/node-v22.23.3-linux-x64/bin/node"
export TMPDIR=/tmp
{
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  uname -a
  "$node" -p 'JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,execPath:process.execPath})'
  printf 'source-filesystem: '
  findmnt -T "$taskroot/project" -n -o SOURCE,FSTYPE,TARGET
  printf 'fixture-filesystem: '
  findmnt -T "$TMPDIR" -n -o SOURCE,FSTYPE,TARGET
  printf 'archive-sha256: %s\n' "$expected"
} > "$out/environment.txt"
"$node" "$out/verify-linux-inputs.mjs" "$taskroot/project" "$out/snapshot-manifest.json" "$out/linux-input-verification-before.json"
cd "$taskroot/project/core"
set +e
"$node" --test --test-reporter=tap --test-name-pattern='POSIX SIGTERM' test/acceptance-execution-http-lifecycle.test.mjs > "$out/graceful-shutdown.tap" 2>&1
result=$?
set -e
printf '%s\n' "$result" > "$out/exit-code.txt"
"$node" "$out/verify-linux-inputs.mjs" "$taskroot/project" "$out/snapshot-manifest.json" "$out/linux-input-verification-after.json"
cat "$out/environment.txt"
tail -20 "$out/graceful-shutdown.tap"
exit "$result"
