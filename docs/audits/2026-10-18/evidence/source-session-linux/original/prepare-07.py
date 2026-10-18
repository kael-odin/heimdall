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
SOURCE = Path('/mnt/c/Users/44548/.codex/worktrees/ci-small-runner-concurrency/heimdall/core')
ASSET = Path('/mnt/c/Users/44548/.codex/worktrees/defect-ticket-closure-d5/heimdall/core/workspace/_runs/wsl-node22-preparation-20261018')
EVIDENCE = ROOT / 'preparation-evidence'
EVIDENCE.mkdir(exist_ok=False)
env = dict(os.environ)
env['PATH'] = str(ROOT / 'runtime/bin') + ':/usr/sbin:/usr/bin:/sbin:/bin'
env['PLAYWRIGHT_BROWSERS_PATH'] = str(ROOT / 'browsers')
for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    env.pop(key, None)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot() -> list[dict]:
    paths = sorted(path for path in (SOURCE / 'src').rglob('*') if path.is_file())
    paths += [SOURCE / 'test/source-operations.test.mjs']
    return [{'path': str(path.relative_to(SOURCE)).replace('\\', '/'),
             'source': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)} for path in paths]


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def command(label: str, argv: list[str], must_pass=True) -> dict:
    started = datetime.now(timezone.utc).isoformat()
    result = subprocess.run(argv, cwd=APP, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    completed = datetime.now(timezone.utc).isoformat()
    (EVIDENCE / f'{label}.stdout.log').write_bytes(result.stdout)
    (EVIDENCE / f'{label}.stderr.log').write_bytes(result.stderr)
    record = {'argv': argv, 'cwd': str(APP), 'startedAt': started, 'completedAt': completed,
              'exitCode': result.returncode, 'stdoutBytes': len(result.stdout), 'stderrBytes': len(result.stderr)}
    write_json(EVIDENCE / f'{label}.command.json', record)
    if must_pass and result.returncode:
        raise SystemExit(f'{label} failed: {result.returncode}: {result.stderr.decode(errors="replace")}')
    return record


before = snapshot()
assert not (APP / 'src').exists() and not (APP / 'test').exists()
shutil.copytree(SOURCE / 'src', APP / 'src', copy_function=shutil.copy2)
(APP / 'test').mkdir()
shutil.copy2(SOURCE / 'test/source-operations.test.mjs', APP / 'test/source-operations.test.mjs')
after = snapshot()
assert before == after, 'Source changed during copy'
copy_rows = []
for item in before:
    target = APP / item['path']
    row = dict(item, destination=str(target), destinationBytes=target.stat().st_size, destinationSha256=sha(target))
    assert row['destinationBytes'] == item['bytes'] and row['destinationSha256'] == item['sha256']
    copy_rows.append(row)
for name in ('package.json', 'pnpm-lock.yaml'):
    assert sha(SOURCE / name) == sha(APP / name)
test_text = (APP / 'test/source-operations.test.mjs').read_text(encoding='utf-8')
assert 'assert.equal(report.flows[0].passed, true, JSON.stringify(report.flows[0]))' in test_text
assert 'assertionTimeoutMs: 100' in test_text
write_json(EVIDENCE / 'source-copy-manifest.json', {
    'recordedAt': datetime.now(timezone.utc).isoformat(), 'sourceStableDuringCopy': before == after,
    'allCopiedBytesMatch': True, 'files': copy_rows,
    'packageJsonSha256': sha(APP / 'package.json'), 'pnpmLockSha256': sha(APP / 'pnpm-lock.yaml'),
})

records = []
records.append(command('npx-prerequisite', ['/bin/bash', '-c', 'command -v npx']))
records.append(command('node-version', [str(ROOT / 'runtime/bin/node'), '--version']))
records.append(command('pnpm-version', [str(ROOT / 'runtime/bin/node'), str(ROOT / 'tools/pnpm/bin/pnpm.mjs'), '--pm-on-fail=ignore', '--version']))
records.append(command('node-environment', [str(ROOT / 'runtime/bin/node'), '-e',
    'console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,versions:process.versions,availableParallelism:require("node:os").availableParallelism()},null,2))']))
records.append(command('playwright-version', [str(ROOT / 'runtime/bin/node'), 'node_modules/playwright/cli.js', '--version']))
records.append(command('system-deps-final', [str(ROOT / 'runtime/bin/node'), 'node_modules/playwright/cli.js', 'install-deps', '--dry-run', 'chromium']))
bins = [ROOT / 'browsers/chromium-1243/chrome-linux64/chrome',
        ROOT / 'browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
        ROOT / 'browsers/ffmpeg-1011/ffmpeg-linux']
binary_rows = []
for index, path in enumerate(bins):
    assert path.is_file()
    records.append(command(f'ldd-{index}', ['/usr/bin/ldd', str(path)]))
    assert b'not found' not in (EVIDENCE / f'ldd-{index}.stdout.log').read_bytes()
    binary_rows.append({'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)})

node_entry = ROOT / 'node-linux.sh'
node_entry.write_text('#!/bin/sh\nset -eu\ndiag_root=/root/heimdall-node22-diagnosis-20261018\n'
                      'export PATH="$diag_root/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n'
                      'export PLAYWRIGHT_BROWSERS_PATH="$diag_root/browsers"\n'
                      'cd "$diag_root/app-core"\nexec "$diag_root/runtime/bin/node" "$@"\n', encoding='utf-8')
node_entry.chmod(0o755)
pnpm_entry = ROOT / 'pnpm-linux.sh'
pnpm_entry.write_text('#!/bin/sh\nset -eu\ndiag_root=/root/heimdall-node22-diagnosis-20261018\n'
                      'export PATH="$diag_root/runtime/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n'
                      'export PLAYWRIGHT_BROWSERS_PATH="$diag_root/browsers"\n'
                      'cd "$diag_root/app-core"\nexec "$diag_root/runtime/bin/node" "$diag_root/tools/pnpm/bin/pnpm.mjs" --pm-on-fail=ignore "$@"\n', encoding='utf-8')
pnpm_entry.chmod(0o755)
write_json(EVIDENCE / 'preparation-summary.json', {
    'recordedAt': datetime.now(timezone.utc).isoformat(), 'ready': True, 'browserLaunched': False,
    'root': str(ROOT), 'appCore': str(APP), 'nodeEntry': str(node_entry), 'pnpmEntry': str(pnpm_entry),
    'nodeVersion': 'v22.23.3', 'pnpmFormalVersion': '11.7.0', 'playwrightVersion': '1.63.0',
    'initialAutoSwitchedPnpmVersion': '11.28.2', 'allSystemDependenciesAvailable': True,
    'allBinaryDependenciesResolved': True, 'copiedSourceFiles': len(copy_rows), 'binaries': binary_rows,
    'commands': records,
})
mirror = ASSET / 'linux-preparation-evidence'
shutil.copytree(EVIDENCE, mirror)
shutil.copytree(ROOT / 'logs', ASSET / 'linux-setup-logs')
shutil.copy2(node_entry, ASSET / node_entry.name)
shutil.copy2(pnpm_entry, ASSET / pnpm_entry.name)
print(json.dumps({'ready': True, 'browserLaunched': False, 'copiedSourceFiles': len(copy_rows),
                  'sourceCopyManifestSha256': sha(EVIDENCE / 'source-copy-manifest.json'),
                  'testSha256': sha(APP / 'test/source-operations.test.mjs'),
                  'nodeEntry': str(node_entry), 'summaryPath': str(mirror / 'preparation-summary.json')}, ensure_ascii=False))
