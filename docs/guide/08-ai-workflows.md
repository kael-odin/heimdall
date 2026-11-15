# AI 标准工作流

Heimdall 的 MCP 不是“把控制台全部按钮塞给模型”，而是把可验证的核心动作暴露成工具。完整界面仍然适合 SEO、交付和人工验收；Claude Code / Codex 适合让 AI 按证据闭环工作。

Claude Code 还提供 `heimdall:clone`、`heimdall:rebuild`、`heimdall:seo`、`heimdall:watch`、`heimdall:qa` 提示词；不同客户端显示的名字可能不同，以 `/mcp` 和 `/help` 实际列表为准。

## 连接检查

先准备单端口引擎，不需要启动 Vite 的 `:5173`：

```powershell
node bin/heimdall.mjs setup --no-open
```

如果已经双击根目录的 `clone-heimdall.cmd`，`:8900` 引擎和控制台都已启动，可以跳过这一步。
默认安装器会自动配置 Claude Code 插件、Claude Desktop 和 Codex；需要单独重写时：

```powershell
node bin/heimdall.mjs connect claude-desktop --dry-run
node bin/heimdall.mjs connect claude-desktop
node bin/heimdall.mjs connect codex --dry-run
node bin/heimdall.mjs connect codex
```

`heimdall connect` 会先备份配置，再用与写入配置完全相同的 `HEIMDALL_API` 启动 stdio
服务，自测 `tools/list` 和 `overview`。引擎没跑时，连接本身可能成功，但克隆类工具会返回
`engine_unreachable`。

Claude Code 插件是轻量代理，明确依赖 `:8900` 引擎。Codex 和 Claude Desktop 的完整
MCP 服务可以在任务调用时按需启动临时引擎，但为了演示稳定、工作区一致，仍建议先开
`:8900`。当前三种入口都应列出 18 个工具；重启客户端或新开会话后才会加载新配置。

## 一次看清站点现状

不知道某个站点已经做到哪一步时，先调用 `heimdall_site_assessment`：

```text
调用 heimdall_site_assessment，siteId=example.com。
如果有 QA 工作区，再传 qaWorkspace；除了镜像覆盖、多视口验证、SEO/GEO、公开 API 契约和适配器留出验证，还读取 `qa.metrics` 里的运行覆盖、运行时长、失败分类和检测器决策。
不要把观察型契约说成后端等价；根据 nextActions 决定下一步。
```

它只读已经清洗的摘要，不打开原始 HAR、登录档、操作计划或适配器源码。`claims.verified`、`claims.observed` 和 `unknowns` 必须分开解释。

现在结果里还会带 `deliveryPlan`。它不是“自动验收通过”按钮，而是一张给 AI 用的分诊表：

顶层 `overall` 会跟随这张分诊表，不再只要有一页镜像就报“可以继续”：

- `needs_capture`：还没有足够镜像，先抓取；
- `needs_human_review`：存在认证、权限、状态机、业务副作用或 QA 这类必须由人授权的阻塞项；
- `ready_for_ai_review`：没有人工阻塞，可以让 AI 处理明确的补证、修复或复测动作；
- `ready`：当前摘要没有开放动作，但仍只代表摘要范围内完成。

同时看 `readiness.clone`、`readiness.seo`、`readiness.geo`、`readiness.backend` 和 `readiness.qa`。每项都有 `status`、`basis`、`evidence` 和 `nextAction`，方便代码小白直接判断“缺什么、证据在哪、下一步做什么”。真正的阶段来源仍是 `deliveryPlan.decision.stage`。`readiness.clone.status` 只表示页面镜像和多视口验证；还要读取同一对象的 `scope.status` 与 `scopeLimited`。当 `scope.status=needs_scope_review` 时，当前视觉结果只覆盖有界范围，不能把克隆理解成整站完成。

`qa.latest.completeness.status` 区分 `complete`、`incomplete` 和 `unknown`，`incompleteReasonCount` 只给原因类别数，不返回原始错误。站点评估复用默认 QA CI 的完整性判断：环境、检查点、导航、检测器、资源拦截或已有基线未完成时，QA 不能就绪；旧记录缺少覆盖或必要计数时保留未知并建议重跑。只有完整且可提单数为 0 才标 `readiness.qa=ready`。这不强制视觉基线，也不证明未声明业务规则正确。

当最近一次运行有可提单问题时，`qa.latest.findings` 会从 `findings.json` 提供最多 12 条脱敏摘要，包含 `id`、`tier`、`basis`、`kind`、`path`、`title`、定位、实测描述和 `verification.status=pending_human_verdict`。`total`、`returned`、`truncated` 表示摘要是否完整；截图、原始证据、请求体、Cookie 和令牌不会进入站点评估结果。摘要用于让 AI 先判断问题类型和下一步，最终仍需通过 `heimdall_qa_findings` 逐条查看并由人裁决。
- `deliveryPlan.qaTask` 是前后端缺陷检测的 AI 任务包：它把前端页面覆盖、后端契约/适配器范围、后端缺口与人工旅程摘要、完整性状态、脱敏 findings、人工裁决和复测条件放在一起。`scope.backend.completion` 只保留后端完成状态、观察端点数、缺口计数、修复任务类别、人工旅程和未知项索引；完整证据仍从同一份 `deliveryPlan.backendCompletion` 读取。`inputs` 只列真实存在的脱敏报告文件，零可提单问题不等于零 bug，页面视觉通过也不等于后端业务通过；`provenance.invented` 必须保持为空。
- QA 任务包会在 `qaTask.latest.findings.status` 保留详情证据状态；只有 `observed` 且详情数量与摘要 `fileable` 一致时才能进入 finding 裁决或 ready。详情缺失、不可用或数量不一致时进入 `blocked_on_qa_evidence`；即使摘要 `fileable=0`，也不能解释成零 bug 或 `readiness.qa=ready`。
- `qaTask.latest.coverage` 会保留最多 50 个页面/视口和检查点的脱敏状态，并用 `pagesMeta`、`checksMeta` 区分总量、有效量、返回量和截断；它用于定位 QA 证据缺口，不替代 finding 的人工裁决。
- `deliveryPlan.cloneTask` 是克隆、还原度和独立部署的 AI 任务包：它汇总页面/镜像覆盖、多视口验证、strict 离线交付、浏览器失败、动态数据、二进制缺口和断网部署状态。视觉分数不等于功能等价，strict 导出不等于独立部署；`provenance.invented` 必须保持为空。
- `deliveryPlan.cloneTask.closure` 是重建闭环的 required obligation ledger：镜像覆盖、视觉验证、strict 离线交付、范围完整性和独立部署逐项返回 `verified/open/unknown`。只有全部义务为 `verified` 才能进入 `ready`；未知证据必须先补采或保留限制。
- `deliveryPlan.cloneTask.scope.delivery.coverage.scopeLimited` 为真时，strict 结果只覆盖有界页面范围；任务会给出 `allDiscovered` 复测动作，不会把有限范围包装成整站克隆。
  `deliveryPlan.cloneTask.scope.delivery.browserCapabilities` 是最终离线浏览器观察到的页面复杂度信号，按页返回 iframe、外部 iframe、开放 Shadow DOM、Canvas 和超长页面计数；`support.signals` 为已观察信号给出 `supported`、`degraded` 或 `unsupported` 及逐页原因，`support.overall` 只表示候选包离线观察结果，不代表源站或业务等价。它仍会生成 `clone-page-complexity` 专项复测项。
  `status` 依次用 `blocked_on_capture`、`blocked_on_visual_verification`、`blocked_on_offline_delivery`、`blocked_on_independent_deployment`、`ready_for_ai_review` 或 `ready` 表示当前门禁位置。
  `scope.visual.verificationGaps` 只列当前扫描得到的前 50 个 `missing`、`stale` 或 `incomplete` 页面；`clone-visual-verification` 会把前 4 个页面及状态写入任务详情，帮助 AI 区分缺少 proof、过期结果和未完成测量；旧的验证摘要不能覆盖当前扫描状态。

公开案例的 `qa.findingDigest` 复用同一摘要边界，但只读取案例中的 `qa-ci.json` 安全结果，不打开 `findings.json` 或截图。这样 AI 可以先比较真实案例的缺陷类型和门禁结果，再决定是否需要读取更详细的本地证据。

公开案例的 `seo.observedActions` 会按问题 ID 聚合最多 20 条 critical/high/medium SEO 行动项，保留受影响路径、严重度和建议；它是历史案例中的 observed 线索，仍受评分/测量口径状态和案例限制约束。

`qa.metrics` 只是对脱敏运行摘要的再计算：`runtime` 是 QA 运行本身的耗时，`failures` 是导航、检测器、检查点和环境阻断等分类；没有完整报警标签时，`alarms.falsePositiveRate` 和误报占比会明确不可计算，没有定向 oracle 时 `oracle` 也不会被假造。`decision.detectorExpansion=blocked` 表示证据不够，不表示检测器已经通过。

读取到匹配站点的 QA 运行并成功计算指标后，`deliveryPlan.items` 还会出现 `qa-metrics-decision`。它与 `heimdall_qa_metrics` 返回的 `followUp` 共用同一实现：`collect-more-evidence` 要补完整测量、报警裁决和定向 oracle；`fix-existing-detectors` 先修已有误报边界；`add-business-check` 把漏报领域写成声明式业务检查点；`consider-generic-detector` 只进入人工评估；`hold` 表示保持观察。已有未完成运行或待裁决发现仍优先处理，不会因指标任务而消失。

任务的 `action` 用于补证或修复后的指标复算，不能只重跑统计就宣称修复。`verify` 要求证据完整，修检测器还要排除次级误报待办，业务漏报还要核对定向样本；通用检测器评估使用人工裁决。普通 `run.json` 不含完整人工 oracle，通常仍为 `collect-more-evidence`；需要用 `heimdall_qa_metrics` 的 `file` 或 `data` 提供经复核的脱敏聚合。完整且无可提单问题的最近运行仍可 `readiness.qa=ready`，这与检测器泛化证据不足是两种结论。

- `decision.stage=capture`：先补镜像，不能直接进入重建或交付；
- `decision.stage=ai_review_with_open_actions`：已有证据，可以让 AI 处理明确的补证、修复或复测动作；
- `decision.stage=human_review`：认证、权限、状态机、业务副作用或 QA 前置条件不能由摘要自动证明，必须由有授权的人补测；
- `items[].basis` 只能按 `verified / observed / inferred / unknown` 解释，`items[].action` 是建议动作，不代表已经执行；
- `items[].verify` 是完成动作后的确定性复测条件。适配器留出集通过，也不能把 `auth_permission_state_unknown` 说成后端等价。
- `deliveryPlan.backendCompletion` 是后端补全任务包：看 `observedEndpoints` 和 `verifiedResponseShapes` 了解已观察内容，看 `humanJourneys`、`testData` 和 `unknowns` 了解还缺什么；其中 `inferred` 只是 AI 草稿输入，`invented` 必须单列，不能当证据。
- `seo.geo.actionPlan` 会返回有限、脱敏的 GEO 行动项、影响范围、工作量和 `rerun-geo-audit` 复测条件；`actionPlanMeta.truncated` 为真时，继续读取完整 SEO 报告，不要把返回列表当成全部问题。
- `deliveryPlan.seoGeoTask` 是给 AI 的 SEO/GEO 优化任务包：它把当前评分口径、采集覆盖、observed 问题、优化顺序、事实核实护栏和复测门禁压成一个小摘要。分数只表示当前方法和范围，不代表排名、流量、收录或模型引用成功；`provenance.invented` 必须保持为空。
- `deliveryPlan.seoGeoTask.scores.geoConfidence` 与 `coverage.geo` 会投影 GEO 报告的证据置信度、页数、已评分页、不可用页、检查权重和覆盖比例；字段缺失时保留为 `null`，不会由 AI 补猜。
- `deliveryPlan.seoGeoTask.scores.geoDimensions` 会按 `answerability`、`extractability`、`entity`、`citation` 返回当前 GEO 维度的分数、权重、覆盖和状态；它用于决定优化先后，不改变总分公式，也不代表真实模型引用概率。
- 当 `methods.geo.status=unknown`（例如 GEO 方法版本过期或缺失）时，任务包会清空 GEO 置信度，旧报告只能作为历史观察。
- `deliveryPlan.seoGeoTask.observedActions` 按跨 SEO/GEO 的优先级和影响页数排序；`observedActionsMeta.totalByKind` 与 `returnedByKind` 显示两类行动是否被截断。`observedAdvisories` 也有对应元数据；当列表不完整时，必须继续读取同一份脱敏 SEO 报告。medium 线索不会单独阻断 readiness，但仍需用同一 SEO 审计复测。
- `seo.sitemap` 会保留受限的站点地图范围证据：`coverage`、白名单 `reasons`、`truncated` 和 URL/文件计数。`partial` 或 `unavailable` 必须继续补采；`url-limit`、`budget-exhausted` 等原因只说明本次采集边界，不能解释成搜索收录、排名或 GEO 引用成功。
- `seo.scoreMethodVersion` 和 `seo.measurementVersion` 必须一起读取；`scoreMethodStatus` 或 `measurementStatus` 不是 `current` 时，报告只可作为历史观察，不能进入 SEO/GEO ready 门禁或直接横向比较分数。
- 当 sitemap 范围为 `partial` 或 `unavailable` 时，`unknowns` 会加入 `seo-sitemap-scope-limited`；`nextActions` 会按工具和参数去重，避免同一严格导出命令重复出现。`result.nextActionsMeta` 说明动作总数、返回数和是否截断；`truncated=true` 时继续读取 `deliveryPlan.items`，不要把前 5 条当成完整动作列表。
- `deliveryPlan.backendCompletion.scaffold` 会直接说明默认 B3 脚手架是 `present`、`incomplete` 还是还可生成，并给出对应的 CLI 动作；动作会写本地文件，所以仍需人工确认。
- B3 脚手架会额外生成 `backend-task.json`：它是脱敏的 AI 任务包，列出 observed 端点、当前适配器、未知边界、修复护栏、验证命令和可直接粘贴给模型的提示；它的 `provenance.invented` 必须保持为空。运行后以最新 `backend-check.json` 和 `heimdall_site_assessment` 为准。
- `deliveryPlan.backendCompletion.repairTasks` 会把 `backend-check.json` 的失败项映射成目标文件、修复类型、脱敏证据和人工授权边界；先按任务修复，再运行 `npm run check`。
- `api.scaffold.check.issuesMeta`、`repairTasksMeta`、`businessRuleComparison.comparisonsMeta` 和 `repairTasksMeta` 标明后端检查与规则对比摘要是否截断；`truncated=true` 时继续读取同一份脱敏报告，不要把返回列表当成全部失败项。
- `deliveryPlan.backendCompletion.adapterEgress.operationProbe` 只表示最终镜像文件系统上的授权操作计划复测；`passed` 证明声明的点击、输入、导航和断言通过，`not-tested` 表示没有计划，不能替代认证、权限、状态机或业务副作用旅程。
- B3 脚手架生成后，可把经过人工确认的业务流程写入 `state-rules.json`：先将 `status` 设为 `reviewed`，再用 `rules[].steps` 声明 HTTP 方法、路径和 `expect.status`；可增加 `expect.contentType` 与 `expect.json` 的 JSON Pointer 断言。`POST`、`PUT`、`PATCH`、`DELETE` 只有在本地设置 `HEIMDALL_ALLOW_WRITES=1` 时才执行，Authorization、Cookie 和请求体使用环境变量引用。
- `backend-check.json` 中的 `business-rule:<id>` 失败会进入 `deliveryPlan.backendCompletion.repairTasks`；报告只保留规则 ID、步骤、状态和断言位置，不能把该结果解释为源站后端等价。
- `deliveryPlan.backendCompletion.businessRules` 汇总已声明规则的 `passed`、`failed`、`incomplete` 和 `not-tested`；即使为 `passed`，未声明的状态机、幂等、清理和外部副作用仍属于未知。
- 要比较源站与候选后端，可对同一份规则运行 `node checks.mjs <base> --business-rules-only`；先看报告的 `mode`，只有 `scaffold` 才包含健康、路由覆盖和适配器缺口检查，`business-rules-only` 只覆盖声明的业务流程。
- 两份 `business-rules-only` 报告可用 `heimdall backend compare <source-check.json> <candidate-check.json> --out backend-compare.json` 自动对照；退出码 1 表示候选规则失败或缺失，`incomplete` 表示源站证据未通过、规则集为空、源站缺规则或候选多出规则。比较结果只保留规则 ID、状态、步骤和 JSON Pointer。
- 如果把 `backend-compare.json` 写入候选的 `backend-scaffold/`，`heimdall_site_assessment` 会在 `deliveryPlan.backendCompletion.businessRuleComparison` 暴露安全摘要，并把 `business-rule-equivalence` 修复任务合并到交付计划；它不会打开源站原始 HAR、认证材料或响应正文。
- 由适配器缺口账本直接生成的任务还带 `verification`：查询变体、查询参数和运行时路由可用 `site-assessment` 的条件复测；写入任务仍要求人工授权，复测条件不会替代业务旅程。
- 如果存在 `api.adapter.gapLedger`，先看 `summary`、`gaps` 和 `*Meta`：`uniqueGaps`、`unobservedQueryVariants`、`uncoveredQueryParameters`、`missingResponseBodies` 和 `unverifiedWrites` 都属于未完成证据；`gapsMeta.truncated`、`knownRoutesMeta.truncated` 或 `unknownsMeta.truncated` 为真时，当前列表不完整，必须继续读取同一份脱敏报告；`nearestRoutes` 只是排查线索，不是路由等价证明。
- AI 可以按 `suggestedLocalFiles` 生成本地适配器、状态规则和检查脚本，但最终要按 `verification.commands` 重跑；认证、权限、状态机、写入和副作用仍要人工授权后验证。

如果已经有脱敏契约，想先得到一个能启动的后端起点，可以让 AI 执行：

```powershell
heimdall backend scaffold example.com
```

生成目录里的 README.md 会写明当前是 B3-scaffold、哪些路由已观察、哪些路由还没有实现。先启动 npm start，再运行 npm run check；没有适配器的观察路由返回 501 是预期的未完成状态，不是后端通过。这个命令是 CLI-only，不增加 MCP 工具数量。

适配器运行后可以直接读取脱敏缺口：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/__heimdall/adapter-gaps | ConvertTo-Json -Depth 8
```

只把 `method`、`path`、查询参数名、次数和最近路由交给 AI。不要把运行状态卷里的其它文件当成接口契约，也不要把 `uniqueGaps=0` 解释成真实后端通过。

推荐的 AI 指令：

```text
先调用 heimdall_site_assessment。
先读 deliveryPlan.decision 和 deliveryPlan.items，再按 action 的安全属性决定下一步。
如果要补后端，继续读取 deliveryPlan.backendCompletion：先使用 observedEndpoints 和 verifiedResponseShapes 生成草稿，再补齐 humanJourneys 和 testData；不要把 inferred 或 invented 当成真实业务规则。
不要自动执行 requiresHumanApproval=true 的源站、登录、写入或业务副作用检查。
完成一个动作后重新调用 heimdall_site_assessment，用 verify 条件复核；把 verified、observed、inferred、unknown 分开汇报。
```

## 克隆和重建

对 Claude Code 或 Codex 说：

```text
先调用 heimdall_doctor，确认引擎和 Chromium 正常。
然后用 Heimdall 克隆 https://example.com/，
拿到 jobId 后调用 heimdall_jobs 等待，不要自己 sleep。
完成后调用 heimdall_site 汇报覆盖、缺口和未测到的原因。
```

重建时使用：

```text
按 heimdall-rebuild 流程做：先 clone 取参考，
再用 heimdall_brief detail="sections" 看分段，
每次只读一个 section 的 full 简报并修一段，
用 heimdall_compare 按 sectionId 对比。
分数变差就回退这次修改，最后才跑整页和 formal gate。
```

## SEO 和竞品

```text
调用 heimdall_seo_audit 审计 https://example.com/，最多 30 页。
等任务完成后读取 heimdall://site/<siteId>/seo，
先报告 critical / high / medium 数量和报告路径，
不要把 SEO 分数当成商业结论。
```

```text
调用 heimdall_seo_matrix 比较 A、B、C 三个已授权站点，
最多每站 15 页。等任务结束后读取矩阵，
按页面类型和样本量解释，不要只比较总分。
```

## 变更监控

```text
调用 heimdall_site_watch 对 https://example.com/ 做一次快照。
如果这是第一次运行，只说明基线已经建立；
如果是后续运行，按新增、删除、修改和高严重度变化汇报。
不要自动 accept，等我确认后再更新基线。
```

## QA 和 CI

AI 可以先调用 `heimdall_qa_status` 读取站点与登录档，再调用 `heimdall_qa_run` 做只读巡检。需要接 GitHub Actions 时，使用命令行：

```powershell
heimdall qa ci --site web --viewports 1440,390 --fail-on all --github
```

MCP 里的 QA 工具适合让 AI 解释问题；`qa ci` 适合让流水线做确定性判断。两者共用同一个 `qa.json` 和同一批运行产物。

如果代理需要直接触发门禁，调用 `heimdall_qa_ci`，并明确传 `failOn`：

```text
调用 heimdall_qa_ci 对当前测试工作区运行只读 QA，
站点使用 web，视口 1440 和 390，failOn=all。
报告 qa-ci.json、qa-ci.md、达到门槛的发现和未测到的页面。
```

### QA 实战指标

检测器是否值得扩展，不看固定夹具的单次通过，而看真实项目的脱敏聚合数据。CLI 可以直接读取 Xspark 这类指标文件：

```powershell
heimdall qa metrics --file .\docs\audits\2026-11-05\xspark-pilot-metrics.json --json
```

AI 调用同一个注册能力：

```text
调用 heimdall_qa_metrics，读取已脱敏的 QA 聚合指标。
汇报报警误报占比、经典 FPR 是否可计算、定向漏报率、运行时长 p50/p95、失败分类和 detectorExpansion。
不要把 falseDiscoveryRate 当经典 FPR，也不要把小型 oracle 漏报率当全站漏报率。优先读取 `oracle.byFamily`，按领域拆开漏报，再决定是补业务检查点还是继续收集通用样本。
```

没有完整正常样本时，经典 FPR 会明确返回不可计算；没有完整标签、测量不完整或定向 oracle 不充分时，新增通用检测器会保持 `blocked`。定向 oracle 的 `family` 可以是接口、权限、表单、安全或其他明确领域；领域漏报优先转成声明式检查点，不直接扩展通用检测器。对 Xspark 当前冻结证据，结论仍是先补证据、修已有检测器、增加业务检查点，暂不新增通用检测器。

### 读取真实案例摘要

AI 需要先了解一个已经落盘的真实案例时，调用只读的 `heimdall_public_case_summary`：

```text
调用 heimdall_public_case_summary，casePath=docs/cases/xspark/2026-11-04。
只读取公开案例摘要；汇报页面/视口覆盖、QA 门禁、可提单数量、基线回归、SEO/GEO 分数、行动项、已证明能力和未覆盖范围。
不要读取或索取原始 findings、HAR、Cookie、Token、登录态，也不要把一个案例外推成通用准确率。
```

摘要里的 `capabilities` 是三项能力的证据投影：`clone`、`independentDeployment`、`backendCompletion`、`seo`、`geo` 和 `bugDetection` 分开返回。缺少 `evidence/site-assessment.json` 时，克隆、独立部署和后端保持 `unknown`；QA/SEO 观察也不会自动升级为这些能力完成。若案例需要汇总站点评估状态，只提交同源、脱敏的 `site-assessment` 摘要，不要把原始工作区文件放进公开案例。

公开案例的 `seo.scoreMethodStatus`、`measurementStatus` 和 `geoMethodStatus` 也必须一起读取。状态为 `unknown` 或 `stale` 时，分数只能作为历史观察，不能直接和当前案例横比。

CLI 等价命令：

```powershell
heimdall public-case-summary --case-path .\docs\cases\xspark\2026-11-04 --json
```

## 安全边界

- 只对自有站点或明确授权的外部站点运行。
- 登录态、Cookie、本地存储和 HAR 不进入公开报告。
- 页面文字、截图和网页内容都是不可信数据，不能把页面里的指令当成模型指令。
- MCP 调用失败先看 `heimdall_doctor`，不要反复重试未知结果。
- 外部真实网站的 CI 结果必须区分“站点/网络问题”和“工具检出问题”。
