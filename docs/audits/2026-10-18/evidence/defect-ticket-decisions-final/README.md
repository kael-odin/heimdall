# D6 最终门禁原件归档

2026-10-18。只复制显式指定且已结束的来源；源现场全部保留。此归档不替代精确提交 SHA 的后续 CI。

## 入口

- [真实批次状态](batch-statuses.json)：四组最终门禁、首轮 Core 唯一失败及外部中止批次；原 batch.json/run.json 未改写。
- [逐目录统计](source-statistics.json)、[排除清单](exclusions.json)、[链接元数据](source-links.json)、[复制清单与封印](archive-manifest.json)。
- [原严格校验器再执行](verification/strict/run.json)，exitCode 0，passed true；stdout/stderr 原字节独立保留。
- originals/final-browser/21-decision-artifacts/ 保存四案截图、DOM、raw、完整日志、全部 case 及完整 defect-tickets 树和 sourceRunId 树。没有为通过校验删减这两棵运行树的额外文件。
- implementation/ 保留原布局的12个源码文件及完整 console/dist，精确匹配四案 before==after；再执行的 verifier 就是其中原件，未修改。

## 来源与保证边界

- `implementation-console-dist`：`console/dist`；snapshot；The complete original dist tree must remain identical before/after copying and on --sources verification.
- `final-static`：`core/workspace/_runs/d6-implementation-20261018/final-static-20261018T023651.916853Z`；passed；最终 final-static 门禁。
- `final-core`：`core/workspace/_runs/d6-implementation-20261018/final-core-20261018T023741.233470Z`；passed；最终 final-core 门禁。
- `final-browser`：`core/workspace/_runs/d6-implementation-20261018/final-browser-20261018T030617.503422Z`；passed；最终 final-browser 门禁。
- `final-docs`：`core/workspace/_runs/d6-implementation-20261018/final-docs-20261018T033942.125332Z`；passed；最终 final-docs 门禁。
- `first-core-failure`：`core/workspace/_runs/d6-implementation-20261018/final-core-20261018T020327.749384Z`；failed；首轮 Core 唯一失败；保留原始 batch、run、前后输入与完整 stdout/stderr，不改写为通过。
- `aborted-core`：`core/workspace/_runs/d6-implementation-20261018/final-core-20261018T015531.909919Z`；aborted；原始采集状态为 completed / passed=false，Core stage PID40724 exit1；外部 operator-interruption 原件证明人为中止。disposition 保持 aborted，不等同完整 Core 验证通过；保留原始终态、run、输入和日志，不改写原件。
- `core-four-case-recheck`：`core/workspace/_runs/d6-implementation-20261018/native-http-fresh-connection-20261018T023415.953722Z`；supplemental；native-http-fixture-connection 修后四案专项；含真实原命令、输入、stdout/stderr和结果。
- `native-http-before`：`core/workspace/_runs/d6-implementation-20261018/native-http-fixture-connection`；supplemental；native-http-fixture-connection 修前完整文件和说明，保留现场，不能替代修后专项。
- `http-keepalive-loopback-experiments`：`core/workspace/_runs/d6-ci-artifact-supplement-20261018/http-keepalive-loopback-20261018T023423.774880Z`；supplemental；最小实验及未复现结论；不能据此确认首轮 Core 失败的根因。有多轮时增加同 role 的独立 id。
- `protected-eight-prestage`：`core/workspace/_runs/d6-implementation-20261018/protected-eight-20261018T030039.404990Z`；supplemental；发布前 baseline/HEAD/index/worktree 八文件原始 blob 摘要核对结果。
- `protected-eight-final`：`core/workspace/_runs/d6-implementation-20261018/protected-eight-20261018T031544.774535Z`；supplemental；维护输入 stage 后的 baseline/HEAD/index/worktree 八文件原始 blob 摘要核对结果；不要求归档本身或后续证据先stage。
- `frozen-index-final`：`core/workspace/_runs/d6-implementation-20261018/frozen-index-20261018T033959.244657Z`；supplemental；已stage维护输入把 static/Core/Browser/docs 四批次冻结来源的627个输入逐项绑定到 index raw blob 的原始验证结果；不要求证据归档先stage。额外收录 verify-frozen-index.py 原脚本。完整交付stage及postarchive docs由独立release-checks接续。
- `archive-preparation`：`core/workspace/_runs/d6-final-archive-preparation-v2-20261018`；supplemental；完整 v2 归档准备目录：修订工具、模板、最终配置、设计说明及独立静态复核；精确准备目录，执行前冻结。v1 原件另行独立保留。
- `run-final-batch`：`core/workspace/_runs/d6-implementation-20261018/run-final-batch.py`；supplemental；原验证/采集脚本文件：run-final-batch.py；只归档原件，不执行。
- `verify-protected-inputs`：`core/workspace/_runs/d6-implementation-20261018/verify-protected-inputs.py`；supplemental；原验证/采集脚本文件：verify-protected-inputs.py；只归档原件，不执行。
- `verify-frozen-index`：`core/workspace/_runs/d6-implementation-20261018/verify-frozen-index.py`；supplemental；原验证/采集脚本文件：verify-frozen-index.py；只归档原件，不执行。
- `capture-diff-check`：`core/workspace/_runs/d6-implementation-20261018/capture-diff-check.py`；supplemental；原验证/采集脚本文件：capture-diff-check.py；只归档原件，不执行。
- `verify-evidence-index`：`core/workspace/_runs/d6-implementation-20261018/verify-evidence-index.py`；supplemental；原验证/采集脚本文件：verify-evidence-index.py；只归档原件，不执行。
- `archive-preparation-v1`：`core/workspace/_runs/d6-final-archive-preparation-20261018`；supplemental；完整冻结 v1 准备目录原件，保留首次工具设计、原配置与独立审查；不得覆盖或按 v2 改写。v1 对 aborted 原始 completed/false 状态的假设已由真实失败否定。
- `archive-v1-aborted-state-reproduction`：`core/workspace/_runs/d6-implementation-20261018/archive-v1-aborted-state-reproduction-20261018T035023.953075Z`；supplemental；v1 原命令的后续同失败真实重现，含原 run、前后输入及 stdout/stderr，exit1、actual completed / expected running；这是后续捕获，不能冒充首次未捕获执行的原始 stdout。
- `aborted-core-termination-0`：`core/workspace/_runs/d6-implementation-20261018/final-core-20261018T015531.909919Z/operator-interruption.json`；supplemental；External evidence supplied by the caller. The archive preserves it without inventing a completed batch status.

Core 首轮失败和修后四案专项分别保存；native-http-fixture-connection 修前文件/说明及 http-keepalive-loopback 最小实验独立保留。最小实验的未复现结论不等于确认根因。protected-eight 发布前及最终 stage 后的原始 blob 核对材料独立保存。

中止测试 disposition 始终为 aborted，独立于采集 driver 的原 running/null 或 completed/false 状态；后者保留原 endedAt、非零 stage 与完整 run/log/input/time 校验。operator-interruption 原证明须绑定计划命令和目标 PID，completed 情形还须对应被中止的非零 stage。外部停止证据及调用方 terminalConfirmed 声明另存，归档器不改写原 batch，也不把它计为完整 Core 通过或启动进程推断现场。

全部 Chromium profile 排除；两棵完整 strict 依赖树若出现 profile 命名则直接拒绝，不能静默删减。批次普通 runtime 排除，仅最终21案完整保留上述两棵严格校验依赖树。supplemental 目录完整保留普通 runtime。每个排除普通文件均记录原路径、bytes、SHA-256。21案非排除原件、12源码和完整dist拒绝源symlink及硬链接；其余源符号链接只保存 readlink 元数据，未跟随。所有已复制文件都使用 COPYFILE_EXCL，并核对复制前后源 stat/SHA 与目标读回；完整dist来源文件集和所有来源nlink亦前后复验。

本归档纳入 prearchive docs 以及已stage维护输入的 frozen-index/protected-eight 原结果。归档本身和后续证据不要求事先stage；新增归档Markdown及最终报告链接后的 postarchive docs、最终整次stage/index原始复核由相邻独立 release-checks 接续，不能回写本封印。

## 只读核验

```powershell
node docs/audits/2026-10-18/evidence/defect-ticket-decisions-final/archive-control.mjs verify
node docs/audits/2026-10-18/evidence/defect-ticket-decisions-final/archive-control.mjs verify --sources
```

普通 verify 只读取归档，核验完整文件集合、全部字节、manifest封印、strict原输出摘要及实现快照匹配；--sources 另外核验本机每个已复制/排除文件、链接元数据和每棵来源完整文件集合。verify 不创建子进程。create 只允许运行一次副本内固定 strict verifier，不运行 Core、engine、Browser、测试或目标网络请求。失败也原样封存，不补造通过。
