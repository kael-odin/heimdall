from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
SOURCE_REPO = Path('C:/Users/44548/.codex/worktrees/ci-small-runner-concurrency/heimdall')
HEAD = '41c359a62ecbb67ac15f38c51c95fa983a7492d3'
PREP = ROOT / 'linux-preparation-evidence'
RUN = ROOT / 'source-operations-20261018T002410.230450Z'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    assert not path.exists(), f'Refusing to overwrite {path}'
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


manifest = json.loads((PREP / 'source-copy-manifest.json').read_bytes())
prep = json.loads((PREP / 'preparation-summary.json').read_bytes())
run = json.loads((RUN / 'summary.json').read_bytes())
assert prep['ready'] and run['passed']
tree = subprocess.run(['git', 'ls-tree', '-rz', HEAD, 'core/src', 'core/test/source-operations.test.mjs'],
    cwd=SOURCE_REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
entries = []
for raw in tree.split(b'\0'):
    if not raw:
        continue
    descriptor, path = raw.split(b'\t', 1)
    mode, kind, oid = descriptor.decode().split()
    assert kind == 'blob'
    entries.append((path.decode(), oid))
expected = {'core/' + item['path']: item for item in manifest['files']}
assert set(path for path, oid in entries) == set(expected)
blob_data = subprocess.run(['git', 'cat-file', '--batch'], cwd=SOURCE_REPO,
    input=('\n'.join(oid for path, oid in entries) + '\n').encode(),
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
offset = 0
rows = []
for path, oid in entries:
    newline = blob_data.index(b'\n', offset)
    actual_oid, kind, length = blob_data[offset:newline].decode().split()
    assert actual_oid == oid and kind == 'blob'
    length = int(length)
    content = blob_data[newline + 1:newline + 1 + length]
    offset = newline + 1 + length + 1
    digest = hashlib.sha256(content).hexdigest()
    row = expected[path]
    assert digest == row['sha256'] and length == row['bytes']
    current = SOURCE_REPO / path
    assert sha(current) == digest
    rows.append({'path': path, 'gitBlob': oid, 'bytes': length, 'sha256': digest,
                 'matchesLinuxCopy': True, 'matchesCurrentMaintenanceSource': True})
write_json(ROOT / 'published-source-match.json', {'head': HEAD, 'fileCount': len(rows),
    'allMatch': True, 'recordedAt': datetime.now(timezone.utc).isoformat(), 'files': rows})
for name, value in [('node-version.stdout.log', 'v22.23.3'), ('pnpm-version.stdout.log', '11.7.0'),
                    ('playwright-version.stdout.log', 'Version 1.63.0')]:
    assert (RUN / name).read_text(encoding='utf-8').strip() == value
for key in ('tests', 'pass'):
    assert run['stats'][key] == {'count': 1, 'value': 17}
for key in ('fail', 'cancelled', 'skipped', 'todo'):
    assert run['stats'][key] == {'count': 1, 'value': 0}
commands = run['command']
report = f'''# WSL Linux Node22 诊断环境与针对性复验

独立环境已准备并保留：Ubuntu-24.04 / Ubuntu 24.04.4 LTS / x86_64 / WSL2。默认账户 uid=0(root)，未要求密码，未开启 Docker Desktop。

## 环境和入口

| 项目 | 实测值 |
| --- | --- |
| Linux 独立根 | `/root/heimdall-node22-diagnosis-20261018` |
| 依赖和冻结源码副本 | `/root/heimdall-node22-diagnosis-20261018/app-core` |
| Node | v22.23.3；npm 10.9.9 |
| pnpm 正式安装/运行版本 | 11.7.0，来自现有 Windows npm 包的纯 JS 副本 |
| Playwright | 1.63.0，与 core/pnpm-lock.yaml 一致 |
| Chromium / headless shell | 153.0.8010.12，Playwright revision1243 |
| FFmpeg | Playwright revision1011，file 确认为静态 ELF |
| Browser 缓存 | `/root/heimdall-node22-diagnosis-20261018/browsers` |

Node 运行入口（自动设置 Linux Node PATH、PLAYWRIGHT_BROWSERS_PATH，并进入 app-core）：

```powershell
wsl.exe -d Ubuntu-24.04 --exec /root/heimdall-node22-diagnosis-20261018/node-linux.sh <Node参数>
```

pnpm 入口：

```powershell
wsl.exe -d Ubuntu-24.04 --exec /root/heimdall-node22-diagnosis-20261018/pnpm-linux.sh <pnpm参数>
```

这些入口保留在现场；本片针对性复验已完成，不需要重复运行。入口不持久修改系统 PATH，不设置运行时 HTTP 代理。

## 下载与依赖准备记录

1. 从 Node 官方版本目录通过 Windows Invoke-WebRequest 下载 `node-v22.23.3-linux-x64.tar.xz` 和同目录 `SHASUMS256.txt`。归档 SHA256 为 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`，Windows Get-FileHash 与 Linux sha256sum --check 均核对一致。Linux Node executable SHA256 为 `fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48`。
2. WSL 直接 TLS 下载等待超时；使用现有 `http://127.0.0.1:7897` 代理后 registry 连通，代理只用于下载/安装进程。初始 /tmp 准备路径未保留，正式环境改放 root home。prepare-01/02 的未完成记录与后续脚本均保留，没有替换原证据。
3. 只复制 core/package.json、core/pnpm-lock.yaml 到隔离目录，以 `--frozen-lockfile --ignore-scripts` 安装。首次使用 pnpm11.7.0 时，由项目 devEngines/lock 声明自动切换到11.28.2；该记录保留。随后显式追加 `--pm-on-fail=ignore`，正式安装输出 `Done ... using pnpm v11.7.0`。未改 package.json 或 lockfile。
4. 使用锁定版本的 `node node_modules/playwright/cli.js install chromium` 下载主 Chromium、headless shell 和 FFmpeg；安装 exit0。Windows 缓存为 Windows 二进制，未作为 Linux Browser 运行。
5. 先执行 `install-deps --dry-run chromium`，确认22项缺失/待升级依赖；执行官方 `install-deps chromium` 后 exit0（apt实际21项升级、16项新增、0移除），再 dry-run exit0。主 Chromium 与 headless shell 的 ldd 均 exit0 且无 not found。FFmpeg 为静态 ELF；首次统一 ldd 检查 exit1 `not a dynamic executable` 的原记录保留，随后用 file 静态分类，未将其误报为缺失库。
6. 安装过程没有启动 Browser。随后按根代理明确授权，复制冻结源码并只进行下面的一次整文件复验。

正式依赖安装命令：

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node /root/heimdall-node22-diagnosis-20261018/tools/pnpm/bin/pnpm.mjs --pm-on-fail=ignore install --frozen-lockfile --ignore-scripts --store-dir /root/heimdall-node22-diagnosis-20261018/pnpm-store
node node_modules/playwright/cli.js install chromium
node node_modules/playwright/cli.js install-deps chromium
```

完整实际脚本为 prepare-01.sh 至 prepare-06-system-deps.sh、prepare-07.py、prepare-08.py；完整 Linux 安装输出镜像在 linux-setup-logs，最终版本/动态库/复制清单镜像在 linux-preparation-evidence。辅助 `source-core-at-ci.tar` 来自旧精确CI head209cf，只用于曾准备的源归档，未解压到测试目录、未参与本次复验。

## 冻结副本与已发布提交对应

从本片工作树复制 core/src 和 source-operations.test.mjs，共 {len(rows)} 项。每项复制前后读取源字节并核对副本，均相同；整文件复验前后再次核对，均相同。安装的 package.json SHA256 为 `{manifest['packageJsonSha256']}`，pnpm-lock.yaml 为 `{manifest['pnpmLockSha256']}`。

测试文件 SHA256 为 `{run['testSha256']}`。该副本含新增的脱敏 JSON.stringify 断言消息，期望与 timeout 未调整。发布后，另通过 git ls-tree/cat-file 对 `{HEAD}` 的全部 {len(rows)} 个 blob 重新核对，均与 Linux 实际副本及当前维护盘字节相同；清单为 published-source-match.json。此核对只读 Git 对象，没有重复运行测试。

## 唯一一次 Linux 针对性整文件复验

实际 argv：

```json
{json.dumps(commands['argv'], ensure_ascii=False)}
```

- cwd：`{commands['cwd']}`。
- startedAt UTC：{commands['startedAt']}。
- completedAt UTC：{commands['completedAt']}。
- 实际退出码：0。
- 唯一原生 TAP 统计：17 total /17 pass /0 fail /0 cancelled /0 skipped /0 todo；suites0；duration_ms12801.680203；notOk=[]。
- 没有增加 CPU 负载，没有并行 Browser 任务，没有自动重试；测试后未扩跑 Core 或重复 source 文件。

原 stdout、stderr、版本、argv、时间、退出码、前后源清单和报告在 `{RUN.name}` 子目录。原 stdout SHA256 为 `{run['stdoutSha256']}`；stderr SHA256 为 `{run['stderrSha256']}`。

**证据范围仅为该单文件的 Linux 针对性复验，不能替代完整 CI，也不证明新精确 CI 的20项 smoke、D5 或 Docker已通过。** 后续完整CI由其它代理跟踪，本代理保留WSL现场与证据后待命。
'''
(ROOT / 'ENVIRONMENT.md').write_text(report, encoding='utf-8', newline='\n')
artifacts = []
for path in sorted(ROOT.rglob('*')):
    if path.is_file() and path.name != 'preparation-deliverables.json':
        artifacts.append({'path': str(path.relative_to(ROOT)).replace('\\', '/'),
                          'bytes': path.stat().st_size, 'sha256': sha(path)})
write_json(ROOT / 'preparation-deliverables.json', {'recordedAt': datetime.now(timezone.utc).isoformat(),
    'fileCount': len(artifacts), 'files': artifacts})
print(json.dumps({'report': str(ROOT / 'ENVIRONMENT.md'), 'reportSha256': sha(ROOT / 'ENVIRONMENT.md'),
    'publishedSourceMatch': str(ROOT / 'published-source-match.json'), 'matchedFiles': len(rows),
    'publishedSourceMatchSha256': sha(ROOT / 'published-source-match.json'),
    'deliverableManifestSha256': sha(ROOT / 'preparation-deliverables.json')}, ensure_ascii=False))
