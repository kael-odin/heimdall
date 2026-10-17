# D5 门禁、证据范围与核心逻辑只读复核

日期：2026-10-18（Asia/Hong_Kong）。工作树：`C:/Users/44548/.codex/worktrees/defect-ticket-closure-d5/heimdall`。本轮未修改维护源码，未运行测试、Browser、engine 或发布工具。仅读取源码与已完成原件、比较原始字节，并按协调代理授权创建此审查与 `verifier-review.json` 两份 ignored 输出。服务和来源边界另由子代理独立阅读后交叉核对。

当前源码调用链未发现可证的跨项目、跨候选误关闭、错误重开或未知动作自动重放缺陷。这个结论是静态审查结果，不能代替最终门禁结果。

## 八份 verifier 定义与字节证明

定义来源为 D4 工作树 `core/workspace/_runs/d4-frontend-20261017/final-before-sha256.json:3-32` 的前八项；同目录 `frontend-review.md:28` 明确说明受测十四文件包含全部八份 verifier。它们是：

1. `core/src/acceptance/browser-operation-schema.mjs`
2. `core/src/acceptance/browser-operation-store.mjs`
3. `core/src/acceptance/browser-fixed-contract.mjs`
4. `core/src/acceptance/browser-fixed-runner.mjs`
5. `core/src/acceptance/runner.mjs`
6. `core/src/acceptance/identity.mjs`
7. `core/src/acceptance/report.mjs`
8. `core/src/verify/compare.mjs`

已将 D5 当前文件与 `git show HEAD:<file>` 的原始 Buffer、完整基准提交 `5006e16bf73e47f36877da24df4ac4a5c8207965` 的原始 git blob、D4 当前文件逐字节比较，并核对 D4 `core/workspace/_runs/d4-validation-round7-20261018/source-snapshot.json` 对应长度/SHA。八项全部相等。机器结果：同目录 `verifier-review.json`，SHA256 `43f5453159f57442c24f8f661bee3e8a458f73380c32479d9fa89da080289153`。

早期十四文件快照的 `browser-operation-store.mjs` SHA 为 `dd00e2ec...`，D4 最终 round7 为 `f1b3a61f...`；因此前者只用于确认八文件清单，不能当最终 D4 字节基线。十文件 legacy verifier fingerprint manifest 是另一份合同，不是本八文件清单。

## 旧门禁命令合同

以下命令均从仓库根执行，`OUT` 为本轮唯一且尚不存在的输出目录。D4 原合同来自 D4 工作树 `core/workspace/_runs/d4-validation-round7-20261018/run-final.mjs:11-27`。

| 门禁 | 正确 argv / 环境 |
| --- | --- |
| build | `pnpm -C console build`；与 D4 直接 Vite `build console` 对应同一生产构建入口 |
| lint | `node core/scripts/check-syntax.mjs` |
| docs | `node core/scripts/check-markdown-links.mjs` |
| core | `node core/scripts/test-core.mjs` |
| forge | `node core/scripts/smoke-forge.mjs` |
| original | `node core/scripts/smoke-acceptance-console.mjs OUT` |
| managed | `node core/scripts/smoke-acceptance-execution-ui.mjs OUT` |
| d3 | `node core/scripts/smoke-acceptance-browser-execution-console.mjs OUT` |
| d4 | `node core/scripts/smoke-acceptance-browser-resolution-console.mjs OUT` |
| candidates | `node core/scripts/smoke-acceptance-browser-candidates-console.mjs OUT` |
| bindings | `node core/scripts/smoke-acceptance-browser-bindings-console.mjs --migrate-catalog OUT` |
| recovery | `node core/scripts/smoke-acceptance-owned-recovery.mjs OUT` |
| cdp | `node core/scripts/smoke-console-cdp.mjs OUT`，显式 `HEIMDALL_E2E_CDP_SELF=1` |
| 新 D5 | `node core/scripts/smoke-acceptance-defect-tickets-console.mjs OUT` |

bindings helper 会剔除最多一次 `--migrate-catalog`，接受其余一个非 flag 位置参数；当前顺序有效。recovery 无需额外外层环境；其 helper 会建立和清理临时完整 runtime，保留的日志/facts/请求不能被描述成保存了已清理的全部 runtime。CDP 如不设 SELF=1，会默认连接外部 9223，因此当前显式设置必要。

已回读确认 runner 修复了初读的三项问题：CDP 指向真实 `smoke-console-cdp.mjs` 并设置 SELF；original 使用独立 OUT；退出码要求子进程 exit0、无 signal/error 且输入不变，signal/null/spawn error 不再被误判成功。

## 输入冻结与计数边界

审查的最新 `run.mjs` SHA256 为 `be47f839b659dfe2157590021ded03f1d302d1c44f857f43e3891890873b4807`。

`run.mjs:9-13` 已改为每次动态重列 inventory，覆盖 core/src、scripts、test、console/src、config、包与锁文件、console/index.html、vite.config.js、CI 文件，并在非 build 门禁中覆盖真实 `console/dist` 字节。精确 recovery 依赖 `docs/audits/2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json` 已加入固定文件。原先“新增文件无法发现”和“Browser 实际 dist 未冻结”缺口已补齐。

`console/vite.config.js:7` 明确 `publicDir:false`，不能把 console/public 泛称为本次 Vite 实际构建输入；当前多纳入该目录不影响冻结结论。build 会生成 dist，因此 build 门禁排除 dist 的前后不变比较合理；后续 Browser 门禁必须使用包含 dist 的新快照。

docs 门禁实际扫描的 Markdown 集合超出当前输入冻结清单。最终报告应明确说明“维护源码和列明构建输入冻结”，并由独立文档核验说明当前 Markdown 结果，不能宣称所有 docs 门禁输入都已被冻结。

`run.mjs:32` 的 totals 从 TAP `# tests/pass/...` 提取。非 TAP smoke 无这些行，NaN 经 JSON 序列化为 null；这不是零，也不是 smoke 检查数。最终汇总应从每个门禁自己的 summary/checks 原件解析并核对精确键集合，不能将 null 计作0或累加跨门禁重复检查。

## 新 D5 smoke 的真实范围与验收标准

来源运行明确包含十四检查；一张人工缺陷单固定选择其中桌面 visual 与 behavior 两项可靠失败。不能将“来源十四检查”写成“单据自动覆盖全部十四项”。脚本真实经过独立 catalog、HTTP engine、Browser execution、显式 register-result 和 Chromium/Vue DOM 操作，覆盖部分修复、全部通过后明确关闭、后来可靠失败重开、后续通过仍不自动关闭、过期预览拒绝和再次明确提交。

最终独立核验应要求 summary passed=true、checkCount=10、checks.json 与 summary.checks 完全一致、恰好下列十键全 true，并绑定同一最终 OUT、门禁起止时间和 stdout 成功记录：

1. `realSourceAndRegisteredVisualBehaviorFailures`
2. `fixedMembersAndLostCreateReconcileAfterReloadWithoutPost`
3. `partialRepairCannotCloseFixedMemberSet`
4. `allMembersRequireExplicitCloseAndLostCloseUsesOnlyGet`
5. `reliableFailureReopensAndLaterPassDoesNotAutoClose`
6. `definiteStalePostRetainsDraftAndRequiresFreshExplicitPreview`
7. `markdownAndJsonDownloadsPreserveHistoryAndOmitRecognizedSecrets`
8. `restartReadsExactTicketWithoutStartingOrRegisteringBrowserWork`
9. `renderedDesktopMobileAndOriginalSourceIntegrity`
10. `consoleErrorsAreOnlyTheExplicitControlledHttpFailures`

应另核四份最终 PNG 的存在、签名、宽高与 layouts 对应、DOM 原件和 pageErrors=[]。脚本横向溢出断言只证明当次四个视口/主题采样，不能扩展为全量响应式或无障碍结论。

lost-create/close 由 page.route 的 route.fetch 先得到真实后端201，再给 UI 返回502 HTML，证明持久化后失去成功响应的受控模拟；不是实际 TCP 断开或断电证明。API专项的真实断线注入范围须与 Browser 现场分别描述。read/人工写原件对比使用 bytes/SHA；mtime/ctime 来自另行 engine 专项，不能混写成该 smoke 的断言。

console 过滤只允许 exact pathname 对应已声明受控回复的 error 且文本含该 status；所有 warning 与 pageerror 会失败，没有全局忽略4xx/5xx/ERR_FAILED。stale409 当前依据 UI 确定拒绝、action unresolved 与无pending断言后手动声明，未直接采集其原生响应状态/错误码；status文本使用 includes，能力边界应据实保留。秘密断言只覆盖指定 query/userinfo 和来源/填值哨兵，不代表任意秘密识别。

## 已保留失败与当前修复身份

首轮原件：`browser-fa0f5e52-c414-45d8-a671-97a1f1a11c03/browser/summary.json`。UTC 2026-10-17T18:41:53.068Z 至 18:52:15.339Z，passed=false、完成8键、四图已有、pageErrors为空；browser-errors 记录6条 error，前三条为明确控制的502/502/409，后三条为引擎重启期间旧页面轮询 `/api/acceptance/runs`、`/api/acceptance/execution` 的 ERR_CONNECTION_REFUSED。原过滤正确拒绝了这些额外错误，不能将该轮记成10/10。

协调代理已在新 smoke 停服前加入 `page.goto('about:blank')`（当前源码234行），保留原过滤与断言。修后脚本 SHA256 `2f2ae56ecc4083bfdd3df0874569497660c7a7023ed4e2c3d41f4c300f4eb728`。本审查只确认改动存在，不提前认定尚未复核的新一轮成功。

## 核心逻辑审查结果

- 项目与候选隔离：service:26-35 验 owner/项目和项目 snapshot；source:154-159、215-224 选真实项目操作；source:299-314 同时按 candidateId+contentDigest 投影，model:27-49 再核对 observation/report 绑定。另一候选通过不能用于当前单据。
- 关闭资格：service:138-147 在串行 store prepare 中重捕来源；model:209-246 重算最新预览并比较 revision/head/member/facts/preview 摘要；store:276-303 在发布前与读回时复核来源及事件 guard。不存在仅依客户端传入 pass 或旧预览关闭的路径。
- 重开：model:99-117 只比较固定成员；154-165 仅对最后关闭锚点之后可靠 still_failed 记录重开原因；后来 pass 不移除该人工处理状态，必须产生新明确关闭事件。acceptedAt、recordedAt、operationId 的排序是明确合同，late-old registration 不被当作新回归。
- 原动作与未知结果：store:251-260 仅同项目、同 actionId、同完整 fingerprint 的已有原件可精确重放；跨项目404、不同内容409；service:150-154 缺席只返回 unresolved，查询没有 append、Browser 启动或登记路径。API:30-35 仅 own data writeMayHaveCommitted===true 映射 outcomeUnknown=true。
- 历史与导出：原件缺失/损坏时 model:130-168 保留人工历史、integrity_blocked 且 closeEligible=false；report:35-56 绑定单据head与成员，导出明确分开处理状态和当前核验，并省略原报告/图片及已识别秘密，不能宣称自动清除任意敏感文本。

可用性隔离边界：source:199-217 预检完整 Browser namespace 元数据，226-228 对本项目所有 completed 原件计费并核验。因此其他项目元数据损坏、本项目其他候选原件损坏或累计预算超限，可能使当前来源核验失败。这是失效关闭合同，不能描述成“候选完全独立可用”；历史仍保留，不能借外部事实误关闭。

末次审查源码 SHA256：

| 文件（core/src/acceptance/） | SHA256 |
| --- | --- |
| defect-ticket-schema.mjs | c1abc662083cf15e4fd49ab21c194d9b236883558d75912eb8530d09fc3981dd |
| defect-ticket-model.mjs | 44cfeabfa922fc90bde0b88de2f70a3b533833e36fd7c277c0a564434b6b6589 |
| defect-ticket-store.mjs | 6bbbc91bfdb2640c83b5fa6b288a4fda36077ffa66541add4609b5fa1553844e |
| defect-ticket-service.mjs | 8816d8276ee26cf9021166635b5003bf0bf7bfb374ce667b3bba35a388c970dc |
| defect-ticket-source.mjs | 63dc53f78ccd451d829470dca97d9410559b5d24fe04d20aad90e9e2dfb6897f |
| defect-ticket-api.mjs | 36a38b7939a52ee2703143abff8896f8f59a4758cc457d40ff51b6953c65b48c |
| defect-ticket-report.mjs | 736f6adf6e4e5bc5eebea1d693c91297b00c4138219609d0591fcd01c5129d46 |

没有基于本轮只读审查创建或补造测试通过、最终截图目视、公开证据封包、CI 或提交结果。
