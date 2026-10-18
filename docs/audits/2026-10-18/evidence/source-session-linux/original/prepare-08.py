from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone

ROOT = Path('/root/heimdall-node22-diagnosis-20261018')
APP = ROOT / 'app-core'
EVIDENCE = ROOT / 'preparation-evidence'
ASSET = Path('/mnt/c/Users/44548/.codex/worktrees/defect-ticket-closure-d5/heimdall/core/workspace/_runs/wsl-node22-preparation-20261018')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    assert not path.exists(), f'Refusing to overwrite {path}'
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


before = {str(path): sha(path) for path in EVIDENCE.iterdir() if path.is_file()}
manifest = json.loads((EVIDENCE / 'source-copy-manifest.json').read_bytes())
for item in manifest['files']:
    assert sha(Path(item['source'])) == item['sha256']
    assert sha(Path(item['destination'])) == item['destinationSha256'] == item['sha256']
for index in (0, 1):
    assert json.loads((EVIDENCE / f'ldd-{index}.command.json').read_bytes())['exitCode'] == 0
    assert b'not found' not in (EVIDENCE / f'ldd-{index}.stdout.log').read_bytes()
assert json.loads((EVIDENCE / 'system-deps-final.command.json').read_bytes())['exitCode'] == 0
ffmpeg = ROOT / 'browsers/ffmpeg-1011/ffmpeg-linux'
argv = ['/usr/bin/file', str(ffmpeg)]
started = datetime.now(timezone.utc).isoformat()
result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
assert b'statically linked' in result.stdout or b'static-pie linked' in result.stdout
(EVIDENCE / 'file-ffmpeg.stdout.log').write_bytes(result.stdout)
(EVIDENCE / 'file-ffmpeg.stderr.log').write_bytes(result.stderr)
write_json(EVIDENCE / 'file-ffmpeg.command.json', {'argv': argv, 'startedAt': started,
    'completedAt': datetime.now(timezone.utc).isoformat(), 'exitCode': result.returncode})
node_entry = ROOT / 'node-linux.sh'
assert not node_entry.exists()
node_entry.write_text('#!/bin/sh\nset -eu\ndiag_root=/root/heimdall-node22-diagnosis-20261018\n'
    'export PATH="$diag_root/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n'
    'export PLAYWRIGHT_BROWSERS_PATH="$diag_root/browsers"\n'
    'cd "$diag_root/app-core"\nexec "$diag_root/runtime/bin/node" "$@"\n', encoding='utf-8')
node_entry.chmod(0o755)
pnpm_entry = ROOT / 'pnpm-linux.sh'
assert not pnpm_entry.exists()
pnpm_entry.write_text('#!/bin/sh\nset -eu\ndiag_root=/root/heimdall-node22-diagnosis-20261018\n'
    'export PATH="$diag_root/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n'
    'export PLAYWRIGHT_BROWSERS_PATH="$diag_root/browsers"\n'
    'cd "$diag_root/app-core"\nexec "$diag_root/runtime/bin/node" "$diag_root/tools/pnpm/bin/pnpm.mjs" --pm-on-fail=ignore "$@"\n', encoding='utf-8')
pnpm_entry.chmod(0o755)
bins = [ROOT / 'browsers/chromium-1243/chrome-linux64/chrome',
        ROOT / 'browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', ffmpeg]
binary_rows = [{'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)} for path in bins]
for path, digest in before.items():
    assert sha(Path(path)) == digest
write_json(EVIDENCE / 'preparation-summary.json', {
    'recordedAt': datetime.now(timezone.utc).isoformat(), 'ready': True, 'browserLaunched': False,
    'root': str(ROOT), 'appCore': str(APP), 'nodeEntry': str(node_entry), 'pnpmEntry': str(pnpm_entry),
    'nodeVersion': 'v22.23.3', 'pnpmFormalVersion': '11.7.0', 'playwrightVersion': '1.63.0',
    'initialAutoSwitchedPnpmVersion': '11.28.2', 'allSystemDependenciesAvailable': True,
    'chromiumDynamicLibrariesResolved': True, 'ffmpegStaticElf': True,
    'priorPreparationEvidenceUnchanged': True, 'copiedSourceFiles': len(manifest['files']), 'binaries': binary_rows,
    'preparationStage07Exit': 1,
    'preparationStage07ExitReason': 'ffmpeg is statically linked; original ldd exit 1 preserved and classified with file; no Browser launch',
})
shutil.copytree(EVIDENCE, ASSET / 'linux-preparation-evidence')
shutil.copytree(ROOT / 'logs', ASSET / 'linux-setup-logs')
shutil.copy2(node_entry, ASSET / node_entry.name)
shutil.copy2(pnpm_entry, ASSET / pnpm_entry.name)
print(json.dumps({'ready': True, 'browserLaunched': False, 'copiedSourceFiles': len(manifest['files']),
    'sourceCopyManifestSha256': sha(EVIDENCE / 'source-copy-manifest.json'),
    'testSha256': sha(APP / 'test/source-operations.test.mjs'),
    'nodeEntry': str(node_entry), 'summaryPath': str(ASSET / 'linux-preparation-evidence/preparation-summary.json')}, ensure_ascii=False))
