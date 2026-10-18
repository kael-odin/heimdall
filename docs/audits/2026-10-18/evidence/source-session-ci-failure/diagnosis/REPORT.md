# 精确 CI 失败原件诊断：命名会话用例

记录时间：2026-10-17T23:58:30.360664+00:00。本报告只读取终态 API、完整日志、原核验结果和精确提交源码；未运行项目测试、Browser 或 engine，未修改维护源码、既有工具和原件。

## 精确身份与真实终态

- 仓库：kael-odin/heimdall；workflow：CI；event：push；branch：main。
- run：39078795034；attempt：1；head：`209cf405656628156952bb43f1188092b4089344`。
- run started_at：2026-10-17T23:22:50Z；API updated_at：2026-10-17T23:51:56Z。
- run 真实终态：completed / failure。

| Job | ID | 真实终态 | started_at UTC | completed_at UTC |
| --- | --- | --- | --- | --- |
| core (e2e smoke, local fixture) | 117531346584 | completed / success | 2026-10-17T23:22:52Z | 2026-10-17T23:25:20Z |
| console (build) | 117531346741 | completed / success | 2026-10-17T23:22:52Z | 2026-10-17T23:23:28Z |
| core (lint + test) | 117531346755 | completed / failure | 2026-10-17T23:22:52Z | 2026-10-17T23:51:55Z |

Core job 生命周期为 29 分 03 秒；失败步骤 `Run pnpm test` 为 2026-10-17T23:24:03Z 至 23:51:52Z，即 27 分 49 秒。本次依据原日志确认为测试断言失败，未达到 45 分钟门限。

## 唯一失败与源码位置

完整主 Core 原日志：`C:\Users\44548\.codex\worktrees\defect-ticket-closure-d5\heimdall\core\workspace\_runs\d5-ci-20261018\final-20261017T235300.096697Z\logs\core (lint + test)\11_Run pnpm test.txt`。

- 唯一 `not ok`：第 15505 行，`1975 - source capture separates named sessions per flow and fails closed on missing sessions`。
- 声明位置：`core/test/source-operations.test.mjs:169:1`。
- 实际失败断言：`:196:10`，`assert.equal(report.flows[0].passed, true)`。
- `failureType: testCodeFailure`；`code: ERR_ASSERTION`；`operator: strictEqual`；expected true，actual false；用例 duration_ms 为 1481.954009。
- 前置第 193–195 行断言检查 sessionUsed、admin sessionName、admin sessionUsed；执行到第 196 行时才失败。
- 精确提交源码第 189–190 行为 `settleMs: 50`、`assertionTimeoutMs: 100`。这些是定位线索，原 CI 未保存该 report 的完整内容，本报告不据此断言根因或判为偶发。

第 15504–15525 行原始字节摘录保存为 `core-test-failure.raw.txt`；完整源码原字节来自 `git show 209cf405656628156952bb43f1188092b4089344:core/test/source-operations.test.mjs`，保存为 `source-operations-at-ci.mjs`。

## 唯一原生统计与后续门禁

完整日志第 16090–16098 行的唯一 TAP 终结块为：2661 total / 2656 pass / 1 fail / 0 cancelled / 4 skipped / 0 todo；suites 0；duration_ms 1666825.100912。第 16100 行退出码为 1。第 16090–16100 行原始字节摘录保存为 `core-test-terminal.raw.txt`。

四项跳过与原合同一致：两项 Windows 文件句柄用例、两项普通主测试中的 Docker 用例。主测试中 Docker 两项在第 12709、12715 行均为 `# SKIP`。

API 的主 Core steps 12–31 共 20 项 acceptance smoke 全部 `skipped`，没有对应步骤日志；D5 位于 step31，未执行，因此没有 terminal summary、十项 true checks、四截图、pageErrors 或受控 HTTP console 统计。step33 Docker offline delivery 同样 `skipped`，没有 Docker 2/2 零 skip 通过证据。独立 e2e smoke job success 不能替代这些未执行门禁。

## 原采集和独立核验

- 原 final capture 实际 exit code：0；输出 captured:true；logEntries：45。该标记表示采集完成，不表示测试通过。
- final 目录：`C:\Users\44548\.codex\worktrees\defect-ticket-closure-d5\heimdall\core\workspace\_runs\d5-ci-20261018\final-20261017T235300.096697Z`。
- 原 verifier 实际 exit code：1；checks：251；identityMatches:true；captureComplete:false；executionAccepted:false；passed:false。
- verification 目录：`C:\Users\44548\.codex\worktrees\defect-ticket-closure-d5\heimdall\core\workspace\_runs\d5-ci-20261018\verification-20261017T235316.280542Z`。
- captureComplete:false 包含对被跳过步骤缺少日志的失败检查；不能据此生成这些步骤已执行的结果。
- 独立子代理只读复核与原件一致，确认唯一 not ok、单一 TAP 终结块、20 smoke 全跳过、D5 summary 不存在和 Docker 未执行。

原工具在监视开始与本次收尾的 SHA256 完全一致：

| 原工具 | bytes | SHA256 |
| --- | ---: | --- |
| capture-v2.py | 11710 | `f0727a28d924f6672988161257fcb243a5572f124b3eeb1819d139374a7b7950` |
| verify-ci.py | 26998 | `071aebb1ce4ba28aa2e615560cb2997444e0365a0a39eaa64dbfc77f4ab97be3` |

## 原件清单与后续条件

`original-manifest.json` 列出 final、verification 目录内每个文件及两个原工具的绝对路径、原字节长度与 SHA256。本报告生成前后再计算相同输入，结果写入 `integrity-check.json`；生成物清单写入 `deliverable-manifest.json`。

失败证据完整保留。本次不得报告 CI 通过，也不得用它放行 D6。后续修复和复现由根代理另行进行；本代理没有重跑 CI、项目测试或 Browser。
