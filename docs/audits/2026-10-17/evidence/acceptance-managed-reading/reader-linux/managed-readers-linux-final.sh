#!/usr/bin/env bash
set -euo pipefail
reader_source=/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall
reader_linux=$(mktemp -d /tmp/heimdall-readers-linux.XXXXXX)
tar -xJf "$reader_source/core/workspace/_runs/managed-linux-final-20261017/node-v22.23.3-linux-x64.tar.xz" -C "$reader_linux"
mkdir -p "$reader_linux/heimdall/core"
cp -a "$reader_source/core/src" "$reader_source/core/test" "$reader_source/core/package.json" "$reader_linux/heimdall/core/"
cd "$reader_linux/heimdall"
"$reader_linux/node-v22.23.3-linux-x64/bin/node" --test --test-reporter=tap core/test/acceptance-managed-run-reader.test.mjs core/test/acceptance-managed-dispatch-reader.test.mjs | tee "$reader_source/core/workspace/_runs/managed-readers-linux-final.tap"
