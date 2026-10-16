#!/usr/bin/env bash
set -u
repo=/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall
out="$repo/core/workspace/_runs/managed-linux-final-20261017"
runtime=/tmp/heimdall-managed-linux-runtime-20261017
archive="$out/node-v22.23.3-linux-x64.tar.xz"
expected=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
actual=$(sha256sum "$archive")
if [[ "${actual%% *}" != "$expected" ]]; then
  printf 'Official archive checksum mismatch\n' >&2
  exit 2
fi
mkdir -p "$runtime"
tar -xJf "$archive" -C "$runtime"
node="$runtime/node-v22.23.3-linux-x64/bin/node"
export PATH="$runtime/node-v22.23.3-linux-x64/bin:$PATH"
export TMPDIR=/tmp
cd "$repo/core"
{
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  uname -a
  "$node" --version
  "$node" -p 'JSON.stringify({platform:process.platform,arch:process.arch,execPath:process.execPath,cwd:process.cwd(),node:process.versions.node})'
  printf 'source-filesystem: '
  stat -f -c %T "$PWD"
  printf 'temporary-fixture-filesystem: '
  stat -f -c %T "$TMPDIR"
  printf 'runtime-filesystem: '
  stat -f -c %T "$runtime"
  printf 'git-head: '
  git rev-parse HEAD
} > "$out/environment.txt"
files=(
 src/acceptance/constants.mjs
 src/acceptance/owner.mjs
 src/acceptance/store.mjs
 src/acceptance/managed-run-files.mjs
 src/acceptance/managed-run-store.mjs
 src/acceptance/managed-execution-schema.mjs
 src/acceptance/managed-evidence-schema.mjs
 test/acceptance-managed-run-store.test.mjs
 test/acceptance-managed-run-store-edges.test.mjs
 test/acceptance-managed-execution-schema.test.mjs
 test/acceptance-managed-evidence-schema.test.mjs
 test/acceptance-owner-capability.test.mjs
 test/acceptance-owner.test.mjs
 test/acceptance-managed-quarantine.test.mjs
)
sha256sum "${files[@]}" > "$out/sha256-before.txt"
"$node" --test --test-reporter=tap \
 test/acceptance-managed-run-store.test.mjs \
 test/acceptance-managed-run-store-edges.test.mjs \
 test/acceptance-managed-execution-schema.test.mjs \
 test/acceptance-managed-evidence-schema.test.mjs \
 test/acceptance-owner-capability.test.mjs \
 test/acceptance-owner.test.mjs \
 test/acceptance-managed-quarantine.test.mjs \
 > "$out/focused-tests.tap" 2>&1
exitCode=$?
printf '%s\n' "$exitCode" > "$out/exit-code.txt"
sha256sum "${files[@]}" > "$out/sha256-after.txt"
cat "$out/environment.txt"
tail -15 "$out/focused-tests.tap"
exit "$exitCode"