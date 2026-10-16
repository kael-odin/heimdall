#!/usr/bin/env bash
set -euo pipefail
recovery_artifact=/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall/core/workspace/_runs/owned-recovery-20261017
recovery_frozen="$recovery_artifact/review-frozen"
recovery_dependencies="$recovery_artifact/review-frozen-dependencies"
recovery_linux=$(mktemp -d /tmp/heimdall-owned-engine-review.XXXXXX)
test -f "$recovery_dependencies/verified.json"
mkdir "$recovery_linux/heimdall"
cp -a "$recovery_frozen/payload/." "$recovery_linux/heimdall/"
cd "$recovery_linux/heimdall"
sha256sum --check --quiet "$recovery_frozen/pins.sha256"
cp -a "$recovery_dependencies/payload/." .
sha256sum --check --quiet "$recovery_dependencies/pins.sha256"
printf '%s  %s\n' df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de "$recovery_frozen/runtime/node-v22.23.3-linux-x64.tar.xz" | sha256sum --check --quiet
tar -xJf "$recovery_frozen/runtime/node-v22.23.3-linux-x64.tar.xz" -C "$recovery_linux"
recovery_node="$recovery_linux/node-v22.23.3-linux-x64/bin/node"
{
  printf 'utc='; date -u +%FT%TZ
  printf 'workspace=%s\n' "$recovery_linux/heimdall"
  printf 'code_pin_check=pass\ndependency_pin_check=pass\n'
  printf 'scope=7 previously failed engine cases only\n'
} > "$recovery_artifact/review-engine-linux-retry-environment.txt"
"$recovery_node" --test --test-reporter=tap \
  '--test-name-pattern=real HTTP managed consumers|engine keeps catalog readable|engine rejects invalid reserved|owned engine startup|failed startup keeps|a live owner rejects|an existing prepared run directory' \
  core/test/acceptance-managed-consumers.test.mjs \
  core/test/acceptance-managed-quarantine.test.mjs \
  core/test/acceptance-owned-recovery-engine.test.mjs \
  | tee "$recovery_artifact/review-engine-linux-retry.tap"
sha256sum --check --quiet "$recovery_frozen/pins.sha256"
sha256sum --check --quiet "$recovery_dependencies/pins.sha256"
