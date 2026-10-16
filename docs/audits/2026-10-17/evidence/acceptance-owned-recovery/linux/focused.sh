#!/usr/bin/env bash
set -euo pipefail
recovery_artifact=/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall/core/workspace/_runs/owned-recovery-20261017
recovery_frozen="$recovery_artifact/review-frozen"
test -f "$recovery_frozen/verified.json"
recovery_linux=$(mktemp -d /tmp/heimdall-owned-recovery-review.XXXXXX)
mkdir "$recovery_linux/heimdall"
cp -a "$recovery_frozen/payload/." "$recovery_linux/heimdall/"
cd "$recovery_linux/heimdall"
sha256sum --check --quiet "$recovery_frozen/pins.sha256"
printf '%s  %s\n' df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de "$recovery_frozen/runtime/node-v22.23.3-linux-x64.tar.xz" | sha256sum --check --quiet
tar -xJf "$recovery_frozen/runtime/node-v22.23.3-linux-x64.tar.xz" -C "$recovery_linux"
recovery_node="$recovery_linux/node-v22.23.3-linux-x64/bin/node"
{
  printf 'utc='; date -u +%FT%TZ
  printf 'workspace=%s\n' "$recovery_linux/heimdall"
  printf 'filesystem='; stat -f -c %T .
  printf 'node='; "$recovery_node" --version
  printf 'input_files='; wc -l < "$recovery_frozen/pins.sha256"
  printf 'pin_check=pass\n'
} > "$recovery_artifact/review-focused-linux-environment.txt"
"$recovery_node" --test --test-reporter=tap \
  core/test/acceptance-owned-recovery.test.mjs \
  core/test/acceptance-owned-recovery-engine.test.mjs \
  core/test/acceptance-managed-run-store.test.mjs \
  core/test/acceptance-managed-run-store-edges.test.mjs \
  core/test/acceptance-managed-quarantine.test.mjs \
  core/test/acceptance-managed-consumers.test.mjs \
  core/test/acceptance-model.test.mjs \
  core/test/acceptance-managed-run-reader.test.mjs \
  core/test/acceptance-managed-dispatch-reader.test.mjs \
  core/test/acceptance-managed-batch-edges.test.mjs \
  core/test/acceptance-managed-snapshot-schema.test.mjs \
  core/test/acceptance-owner.test.mjs \
  core/test/acceptance-owner-capability.test.mjs \
  core/test/acceptance-managed-run-files.test.mjs \
  | tee "$recovery_artifact/review-focused-linux.tap"
