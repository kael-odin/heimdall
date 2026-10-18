# D6 人工动作决定：精确提交 CI 失败核验

本次 CI 没有通过。本文固定记录提交 `06e4303871d485a14b66d24318db80595a3db774` 的运行 `39096514869`、attempt `1`：主 Core 与控制台构建成功，独立 D6 四案 smoke 失败，原验证器拒绝执行接受。后续本地修改或其他提交的结果不能替代本次结论。

## 1. 精确身份与最终状态

所有时间均为 2026-10-18 UTC。

| 身份项 | 本次原件值 |
| --- | --- |
| 仓库 | `kael-odin/heimdall` |
| HEAD | `06e4303871d485a14b66d24318db80595a3db774` |
| Run / attempt | `39096514869` / `1` |
| Workflow ID / path | `378229882` / `.github/workflows/ci.yml` |
| Workflow / branch / event | `CI` / `main` / `push` |
| Run started_at | `04:16:23Z` |
| Run updated_at（终态） | `04:59:05Z` |
| Run status / conclusion | `completed` / `failure` |

GitHub 原运行地址：`https://github.com/kael-odin/heimdall/actions/runs/39096514869/attempts/1`。

| Job | ID | 开始 / 结束 | 终态 |
| --- | --- | --- | --- |
| core (lint + test) | `117583998979` | `04:16:25Z` / `04:59:04Z` | completed / success |
| console (build) | `117583999052` | `04:16:26Z` / `04:16:57Z` | completed / success |
| core (e2e smoke, local fixture) | `117583999059` | `04:16:25Z` / `04:17:54Z` | completed / failure |

身份与 job 原件见 [run.json](evidence/defect-ticket-decision-ci/canonical-final/run.json)、[jobs.json](evidence/defect-ticket-decision-ci/canonical-final/jobs.json) 和 [workflow-identity.json](evidence/defect-ticket-decision-ci/canonical-final/workflow-identity.json)。

## 2. Core 与 Docker 的真实统计

下表来自本次原始 Node TAP 日志及原验证器解析，不是当前工作区重跑的结果。

| 检查 | tests | pass | fail | skipped | cancelled / todo |
| --- | ---: | ---: | ---: | ---: | ---: |
| 主 Core `pnpm test` | 2751 | 2747 | 0 | 4 | 0 / 0 |
| 独立 Docker offline delivery | 2 | 2 | 0 | 0 | 0 / 0 |

主 Core 的四项 skip 包括两个 Windows 文件共享行为用例，以及默认主测试中不启用的两个 Docker 用例。后两个 Docker 用例随后在独立步骤真实运行，两个都通过；不能把主测试中的四项 skip 改写为零。

主 Core 原有的 20 项串行验收 smoke 均成功；这不代表独立 job 中的 D6 动作决定四案成功。Docker 检查涵盖无外联网络的 SSR、SPA、data SPA 交付，以及 adapter volume 在容器重建后的写入持久性。

精确统计、20 项步骤状态与原始日志相对路径保留在 [verified-summary.json](evidence/defect-ticket-decision-ci/canonical-verification/verified-summary.json) 及 [原验证器报告](evidence/defect-ticket-decision-ci/canonical-verification/REPORT.md)。原验证器报告保留其冻结的 D5 标题，报告内 run、attempt、HEAD 均是本次 D6 身份，没有改写原文件。

## 3. 独立 D6 smoke 失败正文

失败步骤是 `Manual defect ticket decisions (four real UI races)`，step 9，开始于 `04:17:21Z`，结束于 `04:17:50Z`。原 artifact `12124333500`（`manual-defect-ticket-decisions-1`）中的 [failure.json 原字节副本](evidence/defect-ticket-decision-ci/early-diagnosis/artifact-failure.json) 记录：

```text
response.json: Protocol error (Network.getResponseBody): No data found for resource with given identifier
Response body is not available for a response that was navigated away from. Read response.body() before triggering any navigation.
    at runCase (/home/runner/work/heimdall/heimdall/core/scripts/smoke-acceptance-defect-ticket-decisions-console.mjs:262:107)
    at async file:///home/runner/work/heimdall/heimdall/core/scripts/smoke-acceptance-defect-ticket-decisions-console.mjs:369:84
```

[原 summary 副本](evidence/defect-ticket-decision-ci/early-diagnosis/artifact-summary.json) 为 `passed:false`、`caseCount:1`；第一案 A / create / intendedWinner rejected 的 `completed:false`。这一案只完成原请求绑定、受控 502 正常完成、保留原确认等早期断言，不能按四案通过或完整竞态验收交付。

原 smoke 失败后，独立 job 的证据验证步骤、`pnpm smoke`、三个 benchmark 及 setup-node post 步骤均被 GitHub 标记 skipped。证据上传步骤仍成功，原失败和跳过状态均保留。

## 4. 响应体失败的证据边界

同一原 ZIP 的五份浏览器/网络原件绑定到唯一 action GET：

- 动作号：`da-24c57ccf-074d-4577-8ded-3da4e45c6640`。
- Playwright 映射请求：`ui-64b76888-e4b6-4802-b56b-d834bfb71a15`。
- CDP requestId：`3387.25`。

| UTC 时刻 | 已记录事实 |
| --- | --- |
| `04:17:45.650Z` | relay 收到该 action GET |
| `04:17:45.667Z` | CDP request |
| `04:17:45.679Z` | HTTP 200 response；`Transfer-Encoding: chunked`，没有 content-length |
| `04:17:45.683Z` | CDP failed：`net::ERR_ABORTED`、`canceled:true`；Playwright 同时 requestfailed |

该 GET 没有 loadingFinished / requestfinished，browser-requests 记录 `finished:false`，全局即时 `response.body()` 也已产生相同 Network.getResponseBody readFailure。因此，不能仅把局部 `.json()` 提前就宣称根因已解决；全局即时读取在原脚本中已存在。

失败 DOM 对同一动作显示“服务端尚未给出此动作的完整原件。未查到记录不代表确定未提交，原确认继续保留。”和“原动作结果待核对 1”。这证明 UI 保留了原人工确认并进入未知原件状态。浏览器响应体证据采集失败不能直接等同于产品查询失败。

精确 HEAD 静态核对未发现该 Response 与 body 消费之间显式 reload / goto；唯一 goto 早于四案。relay 原件只有最初的页面 GET，但 CDP 记录器仅采集 API，未专门记录 Page navigation。因此，错误文字中的 navigation 提示不能当作已经证实的导航根因，也不能据现有材料绝对排除导航。现有证据只确认收到响应后发生浏览器取消，尚未证实取消来源及具体机制。

relay 在 `04:17:45.868Z` 的 `original-upstream-error: socket hang up` 属于被保留的原 POST，不能直接归因给 action GET。原浏览器为 Chrome `153.0.8010.12`、V8 `15.3.76.4`、Protocol `1.3`；WebKit revision 为 `971a7443b0c9b0a9b2860529b33331b76077ec62`。Chromium 日志只有启动期系统总线相关诊断，没有解释上述取消的直接日志。

对应原字节、逐项 SHA 与更细边界见 [early diagnosis](evidence/defect-ticket-decision-ci/early-diagnosis/diagnosis-boundaries.md) 及 [来源清单](evidence/defect-ticket-decision-ci/sources.json)。本文没有把当前 fixture 候选或本地结果写成“本次 CI 已修复”。

## 5. canonical 采集与原验证器结果

冻结工具的真实 canonical 入口为 `core/workspace/_runs/d5-ci-20261018/`。本次没有修改工具字节、timeout、验证参数合同或原结果。

| 过程 | 实际输出 |
| --- | --- |
| final capture | exit `0`，`captured:true`；3 jobs，65 log entries |
| 原 verifier | exit `1`；329 checks，14 failed（9 execution、5 capture） |
| identityMatches | `true` |
| executionAccepted / passed | `false` / `false` |
| captureComplete（原 verifier 字段） | `false` |
| 两次外包装 changedInputs | 均为 `[]` |
| 两次外包装 stderr | 均为空 |
| accepted supplement | 未运行 |

原 capture 的下载/展开完成与原 verifier 的 `captureComplete` 是两个不同结论。原 verifier 要求相应步骤的独立日志；本次五个被跳过的测试/验证步骤没有独立日志，因此这五项 capture 检查仍失败。没有补造日志、改写 skipped、放宽规则或将其当作通过。

完整失败项见 [verification-checks.json](evidence/defect-ticket-decision-ci/canonical-verification/verification-checks.json) 和 [verified-summary.json](evidence/defect-ticket-decision-ci/canonical-verification/verified-summary.json)。外包装的 argv、cwd、开始/结束时间、exit、stdout/stderr SHA 和前后维护输入 SHA 原件见 [capture run.json](evidence/defect-ticket-decision-ci/command-runs/capture/run.json) 及 [verification run.json](evidence/defect-ticket-decision-ci/command-runs/verification/run.json)。

真实 canonical 输出位置：

```text
C:\Users\44548\.codex\worktrees\ci-small-runner-concurrency\heimdall\core\workspace\_runs\d5-ci-20261018\final-20261018T050110.462854Z
C:\Users\44548\.codex\worktrees\ci-small-runner-concurrency\heimdall\core\workspace\_runs\d5-ci-20261018\verification-20261018T050131.631986Z
```

原验证器命令保留如下；重跑会建立新 verification 目录，不应覆盖本次原件：

```powershell
python core/workspace/_runs/d5-ci-20261018/verify-ci.py --source C:\Users\44548\.codex\worktrees\ci-small-runner-concurrency\heimdall\core\workspace\_runs\d5-ci-20261018\final-20261018T050110.462854Z --head 06e4303871d485a14b66d24318db80595a3db774 --run 39096514869 --attempt 1
```

采集工具 SHA256：`f0727a28d924f6672988161257fcb243a5572f124b3eeb1819d139374a7b7950`。原 verifier SHA256：`071aebb1ce4ba28aa2e615560cb2997444e0365a0a39eaa64dbfc77f4ab97be3`。执行前后均重新核对为原值。

## 6. 仓库归档范围与校验

[evidence/defect-ticket-decision-ci](evidence/defect-ticket-decision-ci/) 是选择性的原字节副本，共 143 个文件、2,053,667 bytes，低于授权的 10 MiB。141 个来源文件共 1,961,846 bytes，另含来源清单和复制校验结果。

- `canonical-final/`：身份、捕获/命令元数据、全部已捕获逐步日志。
- `canonical-verification/`：原验证器四份输出，保持其失败结论。
- `command-runs/`：final capture 与原 verify 的外包装原件。
- `early-diagnosis/`：artifact 身份/下载元数据，失败/summary，限定网络、DOM、relay、browser version 原字节与提取 manifest。

[sources.json](evidence/defect-ticket-decision-ci/sources.json) 为每份原件列出原来源绝对/仓库路径、归档路径、bytes、SHA256，并列出六份省略大件及原因。省略 canonical ZIP、总 stdout、三个聚合 job 日志和含旧 dist/runtime/profile 的 artifact ZIP，合计 6,222,185 bytes；没有删除或改动原目录中的这些文件。小型 capture/runtime JSON 仅是命令元数据，不包含运行时二进制或浏览器 profile。

复制时先检查冻结预览中的来源 SHA，再逐件核对副本字节、SHA 及来源未变；[copy-verification.json](evidence/defect-ticket-decision-ci/copy-verification.json) 的 `allBytesAndSha256Match` 与 `originalSourcesUnchanged` 均为 `true`。来源清单自身 SHA256 为 `39599fe0ac5e17009675789ccd0135d39dbc97c008ead21326f7eab91477f11a`。

这个选择性副本保留审阅所需材料，不冒充原 canonical 完整捕获，也不声称可用此精简目录替代原 source 路径重跑原 verifier。原完整 canonical 目录和 ZIP 留在上节路径，独立证据封印与既有文档索引均未修改。
