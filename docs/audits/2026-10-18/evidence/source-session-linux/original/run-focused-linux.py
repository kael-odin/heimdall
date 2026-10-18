from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

ROOT = Path('/root/heimdall-node22-diagnosis-20261018')
APP = ROOT / 'app-core'
ASSET = Path('/mnt/c/Users/44548/.codex/worktrees/defect-ticket-closure-d5/heimdall/core/workspace/_runs/wsl-node22-preparation-20261018')
manifest_path = ROOT / 'preparation-evidence/source-copy-manifest.json'
manifest = json.loads(manifest_path.read_bytes())
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
OUT = ROOT / 'runs' / ('source-operations-' + stamp)
OUT.mkdir(parents=True, exist_ok=False)
env = dict(os.environ)
env['PATH'] = str(ROOT / 'runtime/bin') + ':/usr/sbin:/usr/bin:/sbin:/bin'
env['PLAYWRIGHT_BROWSERS_PATH'] = str(ROOT / 'browsers')
for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    env.pop(key, None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def snapshot():
    rows = []
    for item in manifest['files']:
        source = Path(item['source'])
        copy = Path(item['destination'])
        row = {'path': item['path'], 'sourceSha256': sha(source), 'sourceBytes': source.stat().st_size,
               'copySha256': sha(copy), 'copyBytes': copy.stat().st_size}
        assert row['sourceSha256'] == row['copySha256'] == item['sha256']
        assert row['sourceBytes'] == row['copyBytes'] == item['bytes']
        rows.append(row)
    return rows


before = snapshot()
write_json(OUT / 'inputs-before.json', before)
for label, argv in (
    ('node-version', [str(ROOT / 'runtime/bin/node'), '--version']),
    ('pnpm-version', [str(ROOT / 'runtime/bin/node'), str(ROOT / 'tools/pnpm/bin/pnpm.mjs'), '--pm-on-fail=ignore', '--version']),
    ('playwright-version', [str(ROOT / 'runtime/bin/node'), 'node_modules/playwright/cli.js', '--version']),
):
    result = subprocess.run(argv, cwd=APP, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    (OUT / (label + '.stdout.log')).write_bytes(result.stdout)
    (OUT / (label + '.stderr.log')).write_bytes(result.stderr)
argv = [str(ROOT / 'runtime/bin/node'), '--test', '--test-reporter=tap', 'test/source-operations.test.mjs']
started = datetime.now(timezone.utc).isoformat()
begin = time.monotonic()
command = {'argv': argv, 'cwd': str(APP), 'startedAt': started,
           'environment': {'PATH': env['PATH'], 'PLAYWRIGHT_BROWSERS_PATH': env['PLAYWRIGHT_BROWSERS_PATH']},
           'cpuAffinity': sorted(os.sched_getaffinity(0)), 'cpuLoadAdded': False,
           'parallelBrowserTasksStarted': 0, 'automaticRetries': 0,
           'label': 'targeted Linux single-file verification; does not replace full CI'}
write_json(OUT / 'command-start.json', command)
print(json.dumps({'running': True, 'directory': str(OUT), 'argv': argv, 'startedAt': started}), flush=True)
with (OUT / 'stdout.log').open('wb') as stdout, (OUT / 'stderr.log').open('wb') as stderr:
    completed = subprocess.run(argv, cwd=APP, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
command.update({'completedAt': datetime.now(timezone.utc).isoformat(),
                'durationSeconds': time.monotonic() - begin, 'exitCode': completed.returncode})
write_json(OUT / 'command-result.json', command)
after = snapshot()
write_json(OUT / 'inputs-after.json', after)
assert after == before
stdout_text = (OUT / 'stdout.log').read_text(encoding='utf-8')
stats = {}
for key in ('tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'):
    matches = re.findall(r'^# ' + key + r' (\d+(?:\.\d+)?)\s*$', stdout_text, re.MULTILINE)
    stats[key] = {'count': len(matches), 'value': float(matches[0]) if key == 'duration_ms' and matches else int(matches[0]) if matches else None}
not_ok = re.findall(r'^not ok .+$', stdout_text, re.MULTILINE)
passed = completed.returncode == 0 and all(value['count'] == 1 for value in stats.values()) and stats['tests']['value'] == 17 and stats['pass']['value'] == 17 and not not_ok and all(stats[key]['value'] == 0 for key in ('fail', 'cancelled', 'skipped', 'todo'))
summary = {'label': command['label'], 'passed': passed, 'nodeVersion': 'v22.23.3', 'pnpmVersion': '11.7.0',
           'playwrightVersion': '1.63.0', 'command': command, 'stats': stats, 'notOk': not_ok,
           'sourceFilesUnchanged': before == after, 'sourceFileCount': len(before),
           'testSha256': sha(APP / 'test/source-operations.test.mjs'), 'stdoutSha256': sha(OUT / 'stdout.log'),
           'stderrSha256': sha(OUT / 'stderr.log')}
write_json(OUT / 'summary.json', summary)
report = f'''# Linux 针对性整文件复验

本次只在独立 WSL Ubuntu 24.04.4 x64 环境，使用 Node22.23.3 / pnpm11.7.0 / Playwright1.63.0，对冻结副本 `test/source-operations.test.mjs` 进行一次完整文件复验。此结果不能替代完整 CI。

- startedAt UTC：{command['startedAt']}
- completedAt UTC：{command['completedAt']}
- durationSeconds：{command['durationSeconds']}
- 实际退出码：{command['exitCode']}
- argv：`{json.dumps(argv, ensure_ascii=False)}`
- cwd：`{APP}`
- Node test 的唯一原生统计：`{json.dumps(stats, ensure_ascii=False)}`
- 原 not ok：`{json.dumps(not_ok, ensure_ascii=False)}`
- 通过该针对性要求：{str(passed).lower()}
- 不增加 CPU 负载；不启动并行 Browser 任务；不自动重试。
- 源和隔离副本共 {len(before)} 项，运行前后 SHA256 与字节全一致。
- 测试文件 SHA256：`{summary['testSha256']}`。
- stdout 原字节 SHA256：`{summary['stdoutSha256']}`；stderr 原字节 SHA256：`{summary['stderrSha256']}`。

完整 stdout、stderr、版本、精确 argv/时间/退出码和前后输入清单均与本报告同目录。若有失败，原输出完整保留，未修改期望、timeout 或核验口径。
'''
(OUT / 'REPORT.md').write_text(report, encoding='utf-8')
files = [{'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path)} for path in sorted(OUT.iterdir()) if path.is_file()]
write_json(OUT / 'manifest.json', {'files': files})
mirror = ASSET / OUT.name
shutil.copytree(OUT, mirror)
print(json.dumps({'directory': str(OUT), 'mirrorDirectory': str(mirror), 'exitCode': completed.returncode,
    'passed': passed, 'stats': stats, 'notOk': not_ok, 'sourceFilesUnchanged': True,
    'reportSha256': sha(OUT / 'REPORT.md'), 'manifestSha256': sha(OUT / 'manifest.json')}, ensure_ascii=False), flush=True)
if completed.returncode:
    print('ORIGINAL_STDOUT_BEGIN', flush=True)
    print(stdout_text, flush=True)
    print('ORIGINAL_STDOUT_END', flush=True)
raise SystemExit(0 if passed else 1)
