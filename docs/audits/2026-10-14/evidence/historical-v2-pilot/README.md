# 历史 `apify.com/ideas` v2 隔离重跑

日期：2026-10-14。对象是历史克隆 `core/workspace/apify.com/pages/ideas/clone/`，源站为 `https://apify.com/ideas`。引擎、工作区和所有新 `verify.json` 均使用独立的 `%TEMP%/heimdall-v2-pilot-20261014`；原历史文件只读。这里验证的是单页、匿名公开状态、三个视口的视觉差异，未验证交互或整个站点。

## 结果与口径

| 记录 | 综合分 | 说明 |
| --- | ---: | --- |
| 2026-10-09 旧 `verify.json` | 99.16%（A） | 旧比较器忽略仅出现在一侧的整段页面；无 `scoreVersion`。 |
| 旧计数按 v2 公式只读推算 | 72.96%（C） | 旧截图已删除，且历史克隆之后有更新；仅用于确定重跑优先级。 |
| 本次真实 v2，两次完整运行 | **79.81%（C）** | `final-run-1` 于 `2026-10-14T05:18:04.125Z`，`final-run-2` 于 `2026-10-14T05:24:08.566Z`。两次各视口分数、尺寸、截图 SHA256 完全相同。 |

| 视口 | 源图 / 克隆高度 | 覆盖率 | v2 分数 | 等级 |
| --- | ---: | ---: | ---: | --- |
| 375x812 | 13,926 / 8,310 px | 59.67% | 58.41% | D |
| 768x1024 | 8,006 / 5,198 px | 64.93% | 63.40% | D |
| 1440x900 | 5,710 / 5,710 px | 100% | 98.72% | A |

两次 `verify.json` 的 `scoreVersion=2`、`measured=true`，所有视口的 `settleTimedOut=false`。`sourceCapture.finalUrl` 均为 `https://apify.com/ideas`；`cloneCapture.finalUrl` 是隔离引擎 `127.0.0.1:8917` 的三个静态变体。综合分按手机 25%、平板 25%、桌面 50% 加权；最差视口为手机 D，不能只看桌面 A。

## 波动诊断与修复

修复前的连续单页重跑曾给出 98.57%（A）、82.04%（C）、82.04%（C）；当时桌面源图有时只有 3,838px，有时是 5,710px。独立源站诊断四次均为 HTTP 200、同一最终 URL、无页面错误，截图分别见 [3,838px](source-3838.png)、[5,710px](source-5710.png)，逐阶段高度与文本见 [source-diagnostic.json](source-diagnostic.json)。源站首批异步列表加载后、滚动到底还会触发第二批；旧脚本在首批加载前固定滚动范围，拍到了不同加载阶段。

`core/src/verify/verify.mjs` 现于滚动前、滚动后分别等待可观察的稳定状态：页面高度、文本量、图片数与同源非预取 fetch/XHR；每阶段至少观察 1 秒、最多 2.5 秒。超时仍保存截图与数值，但视口记录 `settleTimedOut=true`，整页不给等级、门禁失败。`--keep-screenshots` 可保留源图和克隆图用于复核。新增的受控异步列表与持续轮询测试覆盖正常稳定和超时两条路径。

证据索引：

| 文件 | 用途 |
| --- | --- |
| [final-run-1/verify.json](final-run-1/verify.json)、[final-run-2/verify.json](final-run-2/verify.json) | 两轮完整结果、采集时间、最终 URL、稳定状态和视口尺寸。 |
| `final-run-{1,2}/src-*.png`、`clone-*.png`、`diff-*.png` | 每轮三视口的真实源图、历史克隆图和差异热图。 |
| `pre-fix-run-{1,2,3}.json`、`post-fix-run-1.json` | 发现波动及修改后首次重跑的原始记录。 |
| `source-diagnostic.json`、`source-3838.png`、`source-5710.png` | 排除导航失败并定位异步列表阶段差异。 |

## 原件完整性

试验前后原工作区的三个关键文件 SHA256 均未变：

| 原件 | SHA256 |
| --- | --- |
| `core/workspace/apify.com/verify/ideas/verify.json` | `756650E4B5C1CB5E48154ACFEB7747A0F15C7A956AAFB369C7EF2220A7E11332` |
| `core/workspace/apify.com/pages/ideas/manifest.json` | `0E0DC86B01BAAB31FE592535B200BD9D7F1F2833D71912B1B4F1C7F0483DA075` |
| `core/workspace/apify.com/pages/ideas/clone/index.html` | `BC6DC1A04C801991799BDFBFF3638A816F9CDDC12F3A4A393CBBE784C4CBCC13` |

两轮手机源图的 SHA256 同为 `FC3D1C8D15DCAA995C8973FCA86EB3E93A0A065AFD6232465C5638892EAC41A9`；两轮手机克隆图同为 `8C7D8158BD2B91ABC6689C6DCB441CE49DB398B6A9998C2C80121F75937EB45C`。另两个视口的源图、克隆图和所有差异图也逐字节一致。

## 隔离复现

从仓库根目录运行下列 PowerShell。先备份同名临时目录（若已存在），再执行复制；`Copy-Item` 的来源均是历史工作区，不会修改它。源站动态内容可能变动，因此未来重跑应记录时间和截图哈希，不能假定结果永远相同。

```powershell
$pilot = Join-Path $env:TEMP 'heimdall-v2-pilot-20261014'
$idea = Join-Path $pilot 'workspace/apify.com/pages/ideas'
New-Item -ItemType Directory -Force -Path $idea, (Join-Path $pilot 'legacy') | Out-Null
Copy-Item -LiteralPath 'core/workspace/apify.com/pages/ideas/manifest.json' -Destination $idea
Copy-Item -LiteralPath 'core/workspace/apify.com/pages/ideas/clone' -Destination $idea -Recurse
Copy-Item -LiteralPath 'core/workspace/apify.com/verify/ideas/verify.json' -Destination (Join-Path $pilot 'legacy/verify.json')
$env:HEIMDALL_DATA_DIR = $pilot
node core/src/engine-server.mjs 8917
```

引擎保持运行，在另一 PowerShell 窗口中从仓库根目录执行：

```powershell
$pilot = Join-Path $env:TEMP 'heimdall-v2-pilot-20261014'
$env:HEIMDALL_DATA_DIR = $pilot
$env:HEIMDALL_PORT = '8917'
node core/src/verify/verify.mjs apify.com ideas --no-interactions --keep-screenshots
$LASTEXITCODE
Get-Content -LiteralPath (Join-Path $pilot 'workspace/apify.com/verify/ideas/verify.json') -Raw
```

本次只复制了 `ideas` 的 manifest 与 clone（255 个文件、3,426,529 字节）和旧验证 JSON。没有复制站点 atlas，也没有重爬或更新克隆；因此不能将本次 C 推广到历史 407 页。现存 62 份历史多视口验证仍是旧口径，须逐页隔离重跑后才可更新全站分布。
