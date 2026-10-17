# D3 精确提交 CI 复核与 owner-loss 测试夹具修正

日期：2026-10-17。D3 精确 head 为 `e3cc0ee1fd9407f2f732b38350bd6514d5983935`，GitHub Actions run `39039535285`，attempt 1。本轮自身 CI 结论为 **failure**。本页同时记录后续测试夹具 hotfix 的本地验证；**hotfix 自身 CI 待推送后按新提交另行核验，当前不能宣称 CI 已修复通过**。

## e3cc0ee 自身 CI 实际结果

| 范围 | 原件结论 |
| --- | --- |
| `console (build)` job | success |
| `core (e2e smoke, local fixture)` job | success，包含 smoke 与三组 acceptance benchmark |
| `core (lint + test)` 的 lint、文档检查、Console 构建 | success |
| `core (lint + test)` 的完整 Core 测试 | 2461 total / 2454 pass / **0 fail / 3 cancelled** / 4 skipped；该步骤及 job 为 failure |
| 其后步骤 12–29 的 18 项 acceptance / Spec / managed / Browser console smokes | 全部 skipped，未执行；其中包含 D3 Browser single-operation execution smoke |
| 后续 Docker offline delivery | skipped，未执行；不计入上述 18 项 |

三个 cancelled 项出现在 `acceptance-browser-fixed-runner.test.mjs`：首项为 `owner loss actively closes pending navigation without waiting for its browser timeout`，其后 deadline 和输入拒绝用例被连带取消。原始错误为 `Promise resolution is still pending but the event loop has already resolved`，`failureType: cancelledByParent`。这里的 `fail=0` 不代表测试步骤或整轮 CI 成功。

原件来自 completed jobs API 和 run / failed-step 日志。捕获 metadata 的 `exitCode=0` 仅表示读取命令成功，不是工作流通过。[公开原件索引](evidence/acceptance-browser-d3-ci/INDEX.md)为每个文件列出 bytes 与 SHA-256；复制后已与本地捕获源文件逐字节哈希核对。

## hotfix 根因与范围

证据级别为 **Node 22 无浏览器复现 + 源码确认**。测试替身把挂起导航保留为 Promise，却没有真实 Playwright 驱动的 IPC 连接句柄。其唯一被引用的 owner-loss timer 在 30 ms 后结束，产品的 100 ms ownership monitor、deadline、heartbeat 均采用 `unref()`；Node 22 因而可在 monitor 执行前退出事件循环。

hotfix 只改变测试文件的 fake Browser：增加一个被引用的 `MessageChannel` 来模拟驱动连接，`browser.close()` 关闭两个 port 并拒绝待决导航，`t.after` 再作清理。产品 runner 和所有 `unref()` 保持原样；原错误码、`<1500 ms` 执行界限、关闭次数、仅 source 证据断言均未放宽，没有增加跳过或筛选规则。

产品 `core/src/acceptance/runner.mjs` SHA-256 仍为 `c0f249bd45b1f3b5e42383297b332fa57f126605b809e09eac7b781ee058cc57`。修后测试文件 SHA-256 为 `fa294e582f508c3e2b6166187e960e6335a1b9b9c2d1c8cf59627491552e8cf5`，见[源码哈希原件](evidence/acceptance-browser-d3-ci/hotfix/source-sha256.json)。

## 本地前后验证

| 输入 / 环境 | 范围 | 结果 |
| --- | --- | --- |
| 修前，Windows Node 25.2.1 | owner-loss 单项 | 1 pass；未复现，不能据此排除 Node 22 问题 |
| 修前，Windows Node 22.23.3 | owner-loss 单项 | 0 pass / 1 cancelled，exit 1；错误与 CI 一致 |
| 修前，WSL Ubuntu Linux Node 22.23.3 | import-only relocated 原测试的 owner-loss 单项 | 0 pass / 1 cancelled，exit 1；错误与 CI 一致 |
| 修后，Windows Node 22.23.3 | owner-loss 单项 | 1/1，0 cancelled / 0 skipped，exit 0 |
| 修后，Windows Node 22.23.3 | 完整专项文件 | **15/15**，0 cancelled / 0 skipped，exit 0 |
| 修后，WSL Ubuntu Linux Node 22.23.3 | 完整专项文件 | **15/15**，0 cancelled / 0 skipped，exit 0 |

两份修后完整专项均正常退出，引用通道未遗留阻止进程结束的句柄。Linux 修前重定位输入仅适配相对 import，测试逻辑来自精确 HEAD；公开包保留其 stdout / exit，不附 Node 安装包或重定位测试输入。`node --check` 与 `git diff --check` 通过。

本地专项所有 launch 均被 mock，没有启动 Chromium，也没有访问真实目标。上述结果证明此次夹具修正在两个 Node 22 平台有效；完整 Core、后续 18 项 smokes 以及 hotfix 自身 hosted CI 仍须按推送后的精确 head 另核。[本地交接原件](evidence/acceptance-browser-d3-ci/hotfix/review.md)保留验证命令、范围和限制。

原 D3 审计文档、证据与 ZIP 保持原样；本次新增目录没有嵌套旧包。


## 5d1de82 hotfix 自身 CI 最终复核（追加）

本节更新前文“hotfix 自身 CI 待核验”的状态，保留此前 `e3cc0ee` 失败结论与原件。hotfix 精确提交为 `5d1de82ac31fa48ef45ed0746591fbd0c710d264`，GitHub Actions run `39044519602`，attempt 1，最终 **success**。运行创建于 `2026-10-17T15:19:18Z`，于 `2026-10-17T15:47:37Z` 完成（UTC）。

[新增 CI 原件索引](evidence/acceptance-browser-d3-ci-5d1de82/INDEX.md)、[结构化索引](evidence/acceptance-browser-d3-ci-5d1de82/INDEX.json)与[交叉核验摘要](evidence/acceptance-browser-d3-ci-5d1de82/verified-summary.json)独立保存本次结果。完整 API 的 head SHA、attempt、工作流及 job 结论与逐步骤原始日志交叉一致；读取命令 exit 0 没有被当作 CI success 的替代依据。

| 范围 | 该提交自身 hosted CI 原件结论 |
| --- | --- |
| `console (build)` | success |
| `core (e2e smoke, local fixture)` | success，包含 smoke 与三组 acceptance benchmark |
| `core (lint + test)` | success；lint、文档检查、Console 构建均成功 |
| 完整 Core `pnpm test` | **2461 total / 2457 pass / 0 fail / 0 cancelled / 4 skipped / 0 todo**；`1213899.052199` ms |
| 步骤 12–29 的 18 组 acceptance / Spec / managed / Browser smokes | **18/18 success**，全部实际执行；包含 D3 单次批准执行 smoke |
| D3 Browser single-operation execution smoke | 原始成功事件为 **16 checks passed** |
| 显式 Docker offline delivery | **2 tests / 2 pass / 0 fail / 0 cancelled / 0 skipped**；`35799.419966` ms |

完整 Core 的四项跳过逐项保留于[Core 原始 stdout](evidence/acceptance-browser-d3-ci-5d1de82/core-test.stdout.log)：两项 Windows non-share-delete 平台专用用例在 Linux 跳过，另两项 Docker 用例在常规测试未启 Docker 环境时跳过。后续独立 `HEIMDALL_DOCKER_TEST=1` 步骤中，这两项 Docker 真实执行并全部通过，见[Docker stdout](evidence/acceptance-browser-d3-ci-5d1de82/docker.stdout.log)。条件性失败诊断上传步骤因工作流成功而 skipped，不属于上述四项测试跳过或 18 组 smokes。

本轮 runner 为 Ubuntu `24.04.5`、Node `22.23.3`。此前触发 cancelled 的 `owner loss actively closes pending navigation without waiting for its browser timeout` 在该精确提交日志中明确为 `ok`；整轮 cancelled 已为 0。测试夹具 hotfix 未扩充跳过，产品 runner 原 `unref()` 保持原样。[D3 Browser smoke stdout](evidence/acceptance-browser-d3-ci-5d1de82/browser-execution.stdout.log)保留实际启动与 16 项成功事件。

新增公开目录包含 83 份原件、3 份直接阅读副本及辅助索引，共 89 个文件。GitHub 原始 `run-logs.zip` 的 64 个文件成员均已通过 CRC 并与 `logs/` 展开原字节比较；`complete-stdout.log` 保留整轮 stdout。INDEX 为每个公开原件、副本和辅助文件记录 bytes 与 SHA-256，索引自身不自引用；复制后已逐项与 ignored 捕获源比较，未嵌套旧 D3 69 MB 证据包。

这次结论只适用于 `5d1de82ac31fa48ef45ed0746591fbd0c710d264` 的 hosted CI，不代替 D4 未提交改动或后续提交的自身 CI。此前 `e3cc0ee` 失败证据、D3 审计与原 ZIP 均保持原样。
