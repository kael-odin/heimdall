from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
TOOLS = REPO / 'core/workspace/_runs/d5-ci-20261018'
FINAL = TOOLS / 'final-20261017T235300.096697Z'
VERIFY = TOOLS / 'verification-20261017T235316.280542Z'
HEAD = '209cf405656628156952bb43f1188092b4089344'
RUN = 39078795034
EXPECTED_TOOLS = {
    'capture-v2.py': 'f0727a28d924f6672988161257fcb243a5572f124b3eeb1819d139374a7b7950',
    'verify-ci.py': '071aebb1ce4ba28aa2e615560cb2997444e0365a0a39eaa64dbfc77f4ab97be3',
}


def digest(path: Path) -> dict:
    raw = path.read_bytes()
    return {'path': str(path.resolve()), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def inputs() -> list[dict]:
    paths = sorted(FINAL.rglob('*')) + sorted(VERIFY.rglob('*'))
    paths += [TOOLS / name for name in EXPECTED_TOOLS]
    return [digest(path) for path in paths if path.is_file()]


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


if (ROOT / 'REPORT.md').exists():
    raise SystemExit('Refusing to overwrite an existing report')
before = inputs()
for name, expected in EXPECTED_TOOLS.items():
    actual = digest(TOOLS / name)['sha256']
    if actual != expected:
        raise SystemExit(f'Original tool changed: {name}: {actual}')

run = json.loads((FINAL / 'run.json').read_bytes())
jobs = json.loads((FINAL / 'jobs.json').read_bytes())['jobs']
verified = json.loads((VERIFY / 'verified-summary.json').read_bytes())
assert run['id'] == RUN and run['run_attempt'] == 1 and run['head_sha'] == HEAD
assert run['status'] == 'completed' and run['conclusion'] == 'failure'
core = next(job for job in jobs if job['id'] == 117531346755)
test_step = next(step for step in core['steps'] if step['name'] == 'Run pnpm test')
smokes = [step for step in core['steps'] if 12 <= step['number'] <= 31]
docker = next(step for step in core['steps'] if step['number'] == 33)
assert len(smokes) == 20 and all(step['conclusion'] == 'skipped' for step in smokes)
assert docker['conclusion'] == 'skipped'
log = FINAL / 'logs/core (lint + test)/11_Run pnpm test.txt'
raw_lines = log.read_bytes().splitlines(keepends=True)
not_ok = [(index + 1, line) for index, line in enumerate(raw_lines) if b' not ok ' in line]
assert len(not_ok) == 1 and not_ok[0][0] == 15505
assert len([line for line in raw_lines if b'# tests 2661' in line]) == 1
(ROOT / 'core-test-failure.raw.txt').write_bytes(b''.join(raw_lines[15503:15525]))
(ROOT / 'core-test-terminal.raw.txt').write_bytes(b''.join(raw_lines[16089:16100]))

source = subprocess.run(
    ['git', 'show', f'{HEAD}:core/test/source-operations.test.mjs'],
    cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
).stdout
(ROOT / 'source-operations-at-ci.mjs').write_bytes(source)
source_lines = source.decode('utf-8').splitlines()
assert "assert.equal(report.flows[0].passed, true);" in source_lines[195]
stats = verified['coreTest']['stats']
assert stats == {'tests': 2661, 'suites': 0, 'pass': 2656, 'fail': 1, 'cancelled': 0,
                 'skipped': 4, 'todo': 0, 'duration_ms': 1666825.100912}
recorded = datetime.now(timezone.utc).isoformat()
write_json(ROOT / 'original-manifest.json', {
    'recordedAt': recorded, 'runId': RUN, 'attempt': 1, 'headSha': HEAD,
    'sourceDirectories': [str(FINAL), str(VERIFY)],
    'fileCount': len(before), 'bytes': sum(item['bytes'] for item in before), 'files': before,
})

job_rows = '\n'.join(
    f"| {job['name']} | {job['id']} | {job['status']} / {job['conclusion']} | {job['started_at']} | {job['completed_at']} |"
    for job in jobs
)
tool_rows = '\n'.join(
    f"| {name} | {digest(TOOLS / name)['bytes']} | `{expected}` |"
    for name, expected in EXPECTED_TOOLS.items()
)
report = f'''# 精确 CI 失败原件诊断：命名会话用例

记录时间：{recorded}。本报告只读取终态 API、完整日志、原核验结果和精确提交源码；未运行项目测试、Browser 或 engine，未修改维护源码、既有工具和原件。

## 精确身份与真实终态

- 仓库：kael-odin/heimdall；workflow：CI；event：push；branch：main。
- run：{RUN}；attempt：1；head：`{HEAD}`。
- run started_at：2026-10-17T23:22:50Z；API updated_at：2026-10-17T23:51:56Z。
- run 真实终态：completed / failure。

| Job | ID | 真实终态 | started_at UTC | completed_at UTC |
| --- | --- | --- | --- | --- |
{job_rows}

Core job 生命周期为 29 分 03 秒；失败步骤 `Run pnpm test` 为 2026-10-17T23:24:03Z 至 23:51:52Z，即 27 分 49 秒。本次依据原日志确认为测试断言失败，未达到 45 分钟门限。

## 唯一失败与源码位置

完整主 Core 原日志：`{log}`。

- 唯一 `not ok`：第 15505 行，`1975 - source capture separates named sessions per flow and fails closed on missing sessions`。
- 声明位置：`core/test/source-operations.test.mjs:169:1`。
- 实际失败断言：`:196:10`，`assert.equal(report.flows[0].passed, true)`。
- `failureType: testCodeFailure`；`code: ERR_ASSERTION`；`operator: strictEqual`；expected true，actual false；用例 duration_ms 为 1481.954009。
- 前置第 193–195 行断言检查 sessionUsed、admin sessionName、admin sessionUsed；执行到第 196 行时才失败。
- 精确提交源码第 189–190 行为 `settleMs: 50`、`assertionTimeoutMs: 100`。这些是定位线索，原 CI 未保存该 report 的完整内容，本报告不据此断言根因或判为偶发。

第 15504–15525 行原始字节摘录保存为 `core-test-failure.raw.txt`；完整源码原字节来自 `git show {HEAD}:core/test/source-operations.test.mjs`，保存为 `source-operations-at-ci.mjs`。

## 唯一原生统计与后续门禁

完整日志第 16090–16098 行的唯一 TAP 终结块为：2661 total / 2656 pass / 1 fail / 0 cancelled / 4 skipped / 0 todo；suites 0；duration_ms 1666825.100912。第 16100 行退出码为 1。第 16090–16100 行原始字节摘录保存为 `core-test-terminal.raw.txt`。

四项跳过与原合同一致：两项 Windows 文件句柄用例、两项普通主测试中的 Docker 用例。主测试中 Docker 两项在第 12709、12715 行均为 `# SKIP`。

API 的主 Core steps 12–31 共 20 项 acceptance smoke 全部 `skipped`，没有对应步骤日志；D5 位于 step31，未执行，因此没有 terminal summary、十项 true checks、四截图、pageErrors 或受控 HTTP console 统计。step33 Docker offline delivery 同样 `skipped`，没有 Docker 2/2 零 skip 通过证据。独立 e2e smoke job success 不能替代这些未执行门禁。

## 原采集和独立核验

- 原 final capture 实际 exit code：0；输出 captured:true；logEntries：45。该标记表示采集完成，不表示测试通过。
- final 目录：`{FINAL}`。
- 原 verifier 实际 exit code：1；checks：251；identityMatches:true；captureComplete:false；executionAccepted:false；passed:false。
- verification 目录：`{VERIFY}`。
- captureComplete:false 包含对被跳过步骤缺少日志的失败检查；不能据此生成这些步骤已执行的结果。
- 独立子代理只读复核与原件一致，确认唯一 not ok、单一 TAP 终结块、20 smoke 全跳过、D5 summary 不存在和 Docker 未执行。

原工具在监视开始与本次收尾的 SHA256 完全一致：

| 原工具 | bytes | SHA256 |
| --- | ---: | --- |
{tool_rows}

## 原件清单与后续条件

`original-manifest.json` 列出 final、verification 目录内每个文件及两个原工具的绝对路径、原字节长度与 SHA256。本报告生成前后再计算相同输入，结果写入 `integrity-check.json`；生成物清单写入 `deliverable-manifest.json`。

失败证据完整保留。本次不得报告 CI 通过，也不得用它放行 D6。后续修复和复现由根代理另行进行；本代理没有重跑 CI、项目测试或 Browser。
'''
(ROOT / 'REPORT.md').write_text(report, encoding='utf-8', newline='\n')
after = inputs()
assert after == before, 'Original evidence bytes changed during report generation'
write_json(ROOT / 'integrity-check.json', {
    'recordedAt': datetime.now(timezone.utc).isoformat(), 'unchanged': after == before,
    'fileCount': len(before), 'bytes': sum(item['bytes'] for item in before),
    'originalManifestSha256': digest(ROOT / 'original-manifest.json')['sha256'],
    'toolHashesMatchInitial': True,
})
artifacts = [digest(path) for path in sorted(ROOT.iterdir()) if path.is_file() and path.name != 'deliverable-manifest.json']
write_json(ROOT / 'deliverable-manifest.json', {'recordedAt': datetime.now(timezone.utc).isoformat(), 'files': artifacts})
print(json.dumps({'directory': str(ROOT), 'originalFileCount': len(before),
                  'originalBytes': sum(item['bytes'] for item in before), 'unchanged': after == before,
                  'artifacts': [digest(ROOT / name) for name in ('REPORT.md', 'original-manifest.json',
                                'integrity-check.json', 'deliverable-manifest.json')]}, ensure_ascii=False))
