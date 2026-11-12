# Heimdall 当前状态（STATUS）

> 更新：2026-11-12 · **本页是“当前为真”的唯一入口**。历史接手记录与逐日审计已归档，见文末。

## 一句话

给它一个网址，交回一张全站星图、一份**可核验**的复刻（原件资产 + 三视口实测还原度 + 缺口清单），以及一个能让 AI 代理闭环重建、由确定性门禁裁决的裁判。

## 现在的主线

**AI 原生接入（Bifröst）**：Heimdall 当眼睛、尺子和裁判，外部 AI 代理当手。三条闭环里，当前只保一条：

1. **重建环（比赛 MVP）**：简报 → 分段 → 代理写代码 → 修复包 → 门禁；失败交付镜像兜底（Floor=Mirror）。
2. 行为环、契约环：只做夹具演示或赛后。

原「克隆 + 还原度 + SEO + 验收」能力全部保留，作为重建环的取证层与裁判层。验收子系统不再扩功能，只作为正式门禁被调用。

## 现在能跑什么

```bash
# 幂等安装 / 启动 / 可选的 AI 客户端配置
node bin/heimdall.mjs setup

# 单页克隆（不需要先起引擎）
node core/src/cli.mjs forge https://example.com home

# 全流程：控制台 + 引擎（幂等）
node bin/heimdall.mjs setup --no-connect

# 一条命令跑完侦察→克隆→验证→资产→交付
node core/src/cli.mjs handoff https://example.org --max-pages 40

# AI 重建竖线（夹具 F1）
heimdall clone http://127.0.0.1:5090/
heimdall rebuild init <siteId> --page home
heimdall brief --project . --detail sections
heimdall compare --project .
heimdall gate report --project . --level gold
heimdall rebuild deliver --project .
```

## 怎么验（2026-11-03 起）

仓库已经公开；`CI` 与 `Docs` 已重新启用，本地和 Hosted Node 22 都按同一套确定性门禁收口：

```bash
pnpm -C core lint          # 语法 + JSON，710 个文件
pnpm -C core check:docs    # 文档链接
pnpm -C core check:frozen  # 验收指纹冻结文件（14 个源文件的字节哈希）
pnpm -C core test:full     # 全量（含真浏览器、验收存储与控制台 E2E），约 28 分钟
pnpm -C core test:acceptance  # 只跑验收套件
pnpm -C console build
pnpm acceptance:demo:smoke # D7 全链路真实 UI
pnpm -C packages/mcp test  # MCP 协议测试
pnpm run audit             # core / console / MCP 三套依赖审计
pnpm check                 # 本地总门禁
```

2026-11-04 Hosted Node 22 两分片合计：全量 **3,014 / 3,018 通过，0 失败，4 跳过**。
`lint` 711 文件、文档 698 个目标 / 140 个文件、冻结验收 14 个文件均通过。
验收基准 18/18、13 个已知 BUG 全检出且 13/13 定位到注入源码；QA 基准 21/21、0 误报。
Console 最大生产 chunk 为 477.84 kB，无超过 500 kB 的警告；三套官方 registry 审计均无已知漏洞。
Node 22 的权威结果由 Hosted CI 的两份真实分片共同组成；2026-11-05 本机完整
`pnpm check` 通过，快速集为 **1,210 / 1,210**，lint 718 文件，文档 701 个目标 /
141 个文件，D7 真实浏览器验收 `accepted:true`。新增安装测试后仍以精确提交的
Hosted CI 结果为最终依据。

## 已知边界（不藏）

- 只碰公开页面或操作者本人有权访问的页面；不绕过登录、验证码、访问控制。
- 交互镜像依赖 `*.localhost` 解析；被代理接管 DNS 的环境里打不开，静态镜像不受影响。
- WebGL、运行时画布、视频、滚动编排：只做降级或明确标不支持。
- 大站（>500 页）受并发与页数上限约束；当前并发 2。
- 后端只能克隆“被观察到的行为”，不声称业务等价。
- 固定夹具成绩很强，但尚未取得获授权、持续可复现的外部项目数据集；不能把 18/18 或 21/21
  直接外推成“任意真实网站都能通过”。
- 验收目录默认 Schema3，Browser 链需要 Schema4；演示前先显式维护：
  `node core/src/acceptance/catalog-maintenance-cli.mjs --create --target-schema 4`。
- 引擎启动时若验收目录锁被其他引擎占用，会打印锁文件路径；确认没有其他引擎后，删除该锁文件再启动，不要删除其他验收数据。

## 文档地图

| 想知道什么 | 读哪里 |
| --- | --- |
| 项目价值、启动、产物 | [README](../README.md) |
| 控制台与 CLI 操作 | [USAGE](../USAGE.md) |
| 产品定义与验收等级 | [PRD](../PRD.md) |
| 边界、风险、演示日清单 | [RISKS](../RISKS.md) |
| 5 分钟演示脚本 | [DEMO-SCRIPT](../DEMO-SCRIPT.md) |
| 当前架构（对着代码维护） | [docs/guide/01-architecture.md](guide/01-architecture.md) |
| AI 接入层方案与路线 | [docs/prd/ai-native/](prd/ai-native/README.md) |
| 接入 Claude Code / Desktop 与 A-3 手测 | [docs/guide/06-ai-integration.md](guide/06-ai-integration.md) |
| 验收工作台各专题 | [docs/competition/](competition/acceptance-workbench.md) |
| 无参照物检测的固定基准 | [qa-detection-benchmark](competition/qa-detection-benchmark.md) |
| 待办与长期维护 | [docs/ROADMAP.md](ROADMAP.md) |
| 审计与实施记录 | [docs/audits/README.md](audits/README.md)（证据已外部归档） |

## 2026-11-03 审查修复收口

- D7 真实 UI 全链路通过：采集、来源归属、候选、已知 BUG、两项人工成员、部分修复禁关、
  完全修复后明确关闭、Markdown 下载；最终结果 `accepted:true`，普通控制台错误为 0。
  同源验收响应在页面 `fetch` 时保留 canonical 字节，不再依赖导航后仍能通过 CDP 回读。
- 取消整站克隆会级联取消仍在运行的页面 forge；`/px/` 只允许有限同源跳转并剥离 Cookie；
  克隆渲染资产按目录与 MIME 开放只读 CORS。
- 恢复 MCP 干净安装、插件产物检查、Windows `pnpm` 参数白名单、原子写文件与 POSIX 目录
  `fsync`、Console WebGL 星图拆包，并把依赖审计接进总门禁与 CI。
- 开源治理补齐 MIT、SECURITY、CONTRIBUTING、CHANGELOG、Dependabot，pnpm 固定到
  `11.28.10`。当前结论仍是“可认真试用和内部验收”，不是“任意站点开箱即成熟产品”。

## 2026-11-05 一键安装与 AI 接入收口

- 新增 `heimdall setup`：按需检查 Node/pnpm、安装三套缺失依赖、Chromium、构建控制台和
  MCP、复用或启动 `:8900` 单端口引擎、打开 UI，并配置检测到的 Claude Code / Claude
  Desktop / Codex。
- `clone-heimdall.cmd` 已改为真正的首次安装器 + 启动器。双击后打开
  `http://127.0.0.1:8900`，不再依赖 `:5173`；重复双击只复用已就绪部分。
- `doctor` 扩充为 13 项，增加依赖、控制台、MCP 和客户端检查；`doctor --fix` 与
  `setup --no-connect --no-open` 共用安全修复实现。
- `connect` 的自测现在使用与实际写入配置完全相同的 `HEIMDALL_API`；dry-run 不启动
  MCP，已有配置也会先备份再改，失败仍回滚。
- 本机实测识别到 Claude Code 插件 `0.2.2`、Claude Desktop 与 Codex；三者均通过
  `doctor`，完整 MCP 客户端各拉起 18 个工具。
- Hosted 精确提交 `1dff01cb14d3878f102fc964485b0b8eaa05bf76`：
  [CI `42016376206`](https://github.com/kael-odin/heimdall/actions/runs/42016376206)
  8 / 8 job 成功，Docs `42016376116` 成功。

## 2026-10-30 仓库瘦身

- **文档**：450 份 / 558MB → 88 份 / 4.8MB。逐日审计报告与 536MB 证据移出工作树，索引见 [docs/audits/README.md](audits/README.md)，原件在外部归档与 git 历史。
- **测试**：默认 `pnpm test` 改为快速集（142 个文件 / 1,140 条 / 约 4–5 分钟）；`pnpm test:full` 保留全量；`pnpm test:acceptance` 只跑验收。
- **工程**：新增 `pnpm check` 一键门禁；根目录空锁文件删除并忽略；Node 固定 22（Docker 同步）；`graphify-out/`、`core/spikes/` 不再出现在 `git status`。

## 2026-10-30 修复包：候选侧数值

- 修复包的每个区域新增 `element.cand`（候选元素矩形 + 计算样式）、`element.styleDiff`（`prop / ref / cand / delta`）与 `element.boxDiff`；区域还会补扫 `element.diffs`，把字号、颜色这类落在更小子元素上的差异带出来。
- `packet.txt` 打印「候选样式 / 样式差」，例如 `fontSize 参考 52px / 候选 46px（−6）`；匹配依据与置信度写在 `match` 里，匹配不到时仍只给参考值，不猜。
- F1 夹具验证：字号、背景色、间距三类注入缺陷都能在修复包里给出候选值与带符号差值。

## 2026-10-31 A-3：Claude Code 插件闭环

- Claude Code 插件 `plugin:heimdall:heimdall` 已安装并连通；当前能力注册表有 18 个工具；本阶段新增 QA CI、SEO 审计、SEO 矩阵、站点变更监控和站点评估。
- 本会话用 MCP 工具完成 F1 重建：6/6 分段 `pass-candidate`，整页 375 99.89% / 768 99.91% / 1440 100%，正式门禁 `passed silver`（验收视觉 3/3、结构 3/3、健康 12/12）。
- 交付包：`agent/deliver/home-20261030T173510Z-cbc82f/`（状态 passed）。
- Claude Desktop 界面 `heimdall_doctor` 9/9 通过（2026-10-31，操作者贴回结果）；配置与 stdio 也已验证。

## 2026-11-04 MCP 扩展与 QA CI

- `heimdall connect` 新增 Codex TOML 目标；Claude Desktop 的检测不再要求配置文件预先存在。
- MCP 新增 `heimdall_seo_audit`、`heimdall_seo_matrix`、`heimdall_site_watch`，并支持读取 SEO、监控和矩阵证据资源。
- 新增 `heimdall qa ci`：保留人工 QA 报告，同时输出机器可读门禁文件、GitHub Actions 注解和步骤摘要。
- 新增可复制的 GitHub Actions QA 模板和 Claude Code / Codex 标准工作流文档。

## 2026-11-12 公开案例摘要

- 新增只读 `heimdall_public_case_summary`，CLI、MCP、HTTP 共用同一能力定义。
- 它只读 `docs/cases/<case>/manifest.json` 和三份脱敏证据摘要，返回页面/视口覆盖、QA 门禁、基线回归、SEO 结果、已证明能力、未覆盖范围和一致性问题。
- Xspark 公开案例已加入 MCP 回归：5 个页面、10 次页面/视口检查、QA 门禁 `passed`、0 条可提单发现、SEO `90.8 / A`。
- 这仍是单个公开案例摘要，不代表任意站点的通用准确率；原始 findings、HAR、会话和 Token 不进入工具输出。

## 2026-11-11 GEO 行动计划

- SEO JSON 和 HTML 报告继续保留原有 GEO 分数与 `recommendations` 兼容字段，同时新增 `geo.actionPlan[]`。
- 每项 GEO 待办带优先级、严重度、影响页数、检查权重、脱敏证据、预计改动面和固定复测方式，Agent 摘要会显示前三项。
- 已用仓库内 Xspark 官网脱敏 SEO 证据做离线回归；这不是重新访问官网，也不改变 Xspark 原历史报告和检测器决策。

## 2026-11-11 B1 契约增强

- 显式使用 `--include-api-har` 或 `--include-api-bodies` 时，清洗 HAR 会为 API 请求保留请求体 Schema 和鉴权形态摘要；默认模式仍不扩大隐私范围。
- `api-contract.json` 与 `health.apiContract` 现在能告诉 AI 哪些端点观察到请求 Schema、出现过哪类鉴权，以及哪些结论仍未知。
- 请求值、认证值、响应示例、刷新规则、权限、状态机和真实副作用仍不会进入契约；当前仍是观察型 B1，不是后端替代。

## 2026-11-11 B2 最小验证环

- `heimdall probe adapter --site S --include-api-bodies` 会按端点做确定性训练/留出拆分：样本数至少 3 的端点保留至少 1 条留出样本，重复请求不算独立样本。
- 观察回放适配器只从训练集生成；适配器目录仍只含 `manifest.json` 和 `index.mjs`，验证结果写在上级的 `adapter-report.json`，不会破坏可部署适配器的两文件约束。
- `adapter-report.json` 对留出请求核对状态码、MIME、脱敏 JSON 形状和训练集中稳定字段，并单列未观察路径、未覆盖参数、样本不足和留出集为空。通过阈值为留出等价度至少 90%；没有留出样本时是 `not-validated`，不是通过。
- 该环只证明观察数据上的有限泛化，不证明认证、权限、状态机、业务规则、持久化或真实副作用。Xspark 试点目前只有脱敏 QA 聚合证据，没有可作为 API 留出样本的公开 HAR，因此不把 Xspark 的 38/71、2/4 统计硬塞进 B2 API 结论。

## 2026-11-11 站点评估包

- 新增只读 `heimdall_site_assessment`：一次返回镜像页数、多视口验证、SEO/GEO 摘要、公开 API 契约、适配器留出验证、可选 QA 最近运行、证据分类和下一步。
- 它只读取清洗后的公开报告与 manifest，不读取原始 HAR、登录档、操作计划或适配器源码；`verified`、`observed`、`inferred`、`unknown` 分开输出。
- 评估结果新增 `deliveryPlan`：按页面/资产、视觉验证、SEO/GEO、API 契约、B2 适配器、QA 检查点和认证/权限/状态未知项分组，给出 `capture`、`ai_review_with_open_actions`、`human_review` 或 `ready` 阶段；动作和复测条件都带安全属性，不把建议动作冒充已执行。
- 该能力是 AI 的导航层，不替代克隆、SEO、QA 或后端实现；没有镜像时总体状态仍是 `needs_capture`，适配器通过也只表示观察样本的有限验证。
- 修正站点评估的总体状态：`overall` 现在跟随 `deliveryPlan.decision.stage`，区分 `needs_capture`、`needs_human_review`、`ready_for_ai_review` 和 `ready`；新增 `readiness` 摘要，按 clone/SEO/GEO/backend/QA 给出状态、证据和下一步，避免“有一页镜像就看起来已经准备好”的误导。

## 2026-11-12 后端补全任务包

- `deliveryPlan.backendCompletion` 现在把 B1/B2 之间的下一步压成一个只读任务包：已观察端点、响应形状证据、认证/权限/状态/副作用未知项、需要人工授权的业务旅程、建议生成的本地文件、测试数据和验证命令。
- 端点和响应形状只来自清洗后的 `api-contract.json`；适配器留出验证通过时只标记回放证据，仍不声称真实后端等价。
- `inferred` 是 AI 可以据此起草的内容，`invented` 单独计数且当前为空；没有观察型契约时任务包明确为 `blocked_on_observation`，不会自动发明业务 API。
- MCP 提示词已要求 AI 同时读取 `deliveryPlan.backendCompletion`，继续沿用 `requiresHumanApproval` 和确定性复测边界；本轮没有新增独立 MCP 工具。

## 2026-11-12 适配器缺口账本

- 生成的观察回放适配器现在携带脱敏路由元数据；它能区分已声明路由、未覆盖查询参数和未观察查询变体，但不会保存查询值或请求体。
- 运行包含适配器的包时，未声明请求会按 `method + pathname + query parameter names` 聚合写入包外 `HEIMDALL_RUNTIME_DATA_DIR/adapter-gap-ledger.json`；重复请求只增加 `count`。
- `/__heimdall/adapter-gaps` 返回账本，`/__heimdall/health` 返回摘要；账本会给出最近似已知路由，并把缺响应体、未验证写入、认证/权限未知保留为未决项。
- `adapter-report.json.gapLedger` 记录训练/留出阶段的离线缺口；`heimdall_site_assessment` 读取它或同级 `adapter-gap-ledger.json`，把缺口变成 `api-adapter-gap-ledger` 待办。它仍不证明真实后端业务等价。

## 2026-11-12 B3 最小服务脚手架

- 新增 CLI-only 命令 heimdall backend scaffold <siteId> [--out D] [--force]；它不进入能力注册表，因此 MCP 工具仍保持 18 个。
- 生成物包括 package.json、server.mjs、checks.mjs、脱敏 api-contract.json、state-rules.json、Dockerfile 和人话 README；有合法 B2 适配器时只复制 runtime-adapter/manifest.json 与 index.mjs。
- 生成服务提供 GET /__heimdall/health、GET /__heimdall/contract 和 GET /__heimdall/adapter-gaps。没有适配器的已观察路由返回 501，避免把空壳误报成完成；适配器仍只是观察样本回放。
- `checks.mjs` 不再只看服务能否启动：会逐条检查观察路由覆盖、已观察状态码、MIME 和有限 JSON 字段结构，并读取运行时缺口账本；结果落盘为脚手架目录内的脱敏 `backend-check.json`。
- `backend-check.json` 的失败项现在附带 `repairTask`，并汇总为 `repairTasks`；任务区分路由缺失、响应契约、查询参数缺口和写入验证，不携带请求值。
- `heimdall_site_assessment` 会读取 `backend-check.json` 的安全摘要，把未运行、失败、未完成和通过分开返回，并把脱敏修复任务交给 `deliveryPlan.backendCompletion.repairTasks`；这仍不证明认证、权限、状态机或真实副作用。
- state-rules.json 的认证、权限、状态机、持久化和副作用规则默认留空，invented 数量为 0；AI 或开发者必须在授权旅程后补规则，再用 npm run check 和既有验证套件复测。
- `heimdall_site_assessment` 现在会识别默认 `backend-scaffold` 是否已完整生成，并把缺失或半成品转成一个带人工确认边界的下一步动作，避免 AI 只看到抽象的建议文件。

## 2026-11-12 QA 实战指标总线

- 新增只读能力 `heimdall_qa_metrics`，CLI 别名为 `heimdall qa metrics`；它可读取脱敏聚合 JSON、单个 `run.json` 或 QA 工作区运行摘要。
- 结果统一给出复核报警、误报占比、经典 FPR 可用性、定向 oracle 漏报率、运行时长 p50/p95、失败分类和覆盖量；百分比从分子分母重算，不信任输入里的旧百分比。
- 经典 FPR 只有在正常样本穷举且有 TN 时才计算；没有这个条件就明确显示不可计算。Xspark 现有证据仍为误报占已复核报警 `38/71 = 53.52%`，定向漏报 `2/4 = 50%`，不是全站 FPR 或全站漏报率。
- `detectorExpansion` 复用冻结的保守决策规则，并自动暴露给 CLI、MCP 和 HTTP；当前 Xspark 离线重算仍是 `blocked`，下一步是补完整证据、压已有规则误报和增加业务检查点。

## 2026-10-31 产品打磨

- `rebuild init` 不再固定抢 5199：不传 `--port` 时自动找空闲端口；显式传了而端口被占用则直接报错，不偷偷换。
- `compare` 的摘要第一屏直接给「首要差异」，例如 `fontSize 参考 52px / 候选 46px（-6）`，代理不必先翻修复包全文。
- AI 活动页新增「最近一次修复包」：显示最近一次**有差异**的区域与样式差；最新一次是干净收尾时，会同时标出「最新一次无差异」。
- `styleDiff` 兼容旧参考索引：缺逐边值时从 `padding/margin/border/gap` 简写推导，避免把「没记录」误报成 0。

## 2026-11-01 无参照物检测：QA 从“跑不通”扩到“跑得通但不对”

- `qa run` 默认在每个页面跑 23 个页面内检测器，分六类：无障碍（`alt`、可访问名、表单标签、重复 `id`、标题层级、`lang`、`iframe title`、`tabindex`）、布局（文字裁切、图片拉伸、点击目标过小）、内容（占位/调试文案、模板变量、乱码、无效值）、安全（混合内容、`_blank` 缺 `noopener`、http 表单、疑似密钥）、性能（LCP、CLS、过大图片）、可用性（白屏）。发现走同一套指纹、证据门槛、裁决记忆与 `bugs.md`。
- `qa run --explore` 显式开启有界交互探索：每页最多 6 个控件、60 秒预算，找“点击无反应 / 点出异常 / 点出 404”；跳过破坏性文案、表单提交、外链、下载，HTTP 请求按站点策略处理。方法和文案过滤不能保证操作没有副作用。默认关闭，因为它会改变页面状态。
- `qa baseline` 把一次运行登记为基线，之后每次运行对同站同页同视口截图做比对，低于阈值生成 `regression` 发现（附基线截图、本次截图、差异图）；`--no-baseline` 关闭。
- 固定注入基准 `node core/scripts/benchmark-qa.mjs`：21 个缺陷案例 + 3 个健康案例，最近一次 21/21 检出、0 误报，单页静态检测约 2.1 秒、含交互段约 11 秒。夹具与口径见[基准说明](competition/qa-detection-benchmark.md)。
- Xspark 真实试点已把失败分类、测量完整性和检测器扩展判断机器化：历史 20 次运行仍为冻结分母，补充复测存在不完整证据，当前先补证据、修现有规则和增加业务检查点，通用检测器扩展暂时阻断。详见 [试点报告](audits/2026-11-05/xspark-pilot.md)。
- 2026-11-12 IANA 公开站点试点：真实 Chromium 完成 8 页、24 视口视觉验证；原候选包的严格离线交付仍被 2 个动态第三方脚本、2 个未解析资源、223 个未捕获链接引用和 8 页未执行浏览器离线探针阻断。详见 [试点记录](audits/2026-11-12/iana-public-pilot.md)。
- 2026-11-12 修正 strict 诊断流程：即使已有静态阻断，也会继续执行 HTTP 和浏览器离线探针；只有探针自身失败才跳过后续探针。静态阻断仍原样保留，不能靠新增诊断证据发布；IANA 试点尚未按此修正重新跑，不改变其未通过结论。
- IANA 试点复盘后修复了健康扫描对 `&quot;` / `&amp;` 等 HTML 实体编码 CSS 引用的归一化；用原候选包离线复扫，8 页保持不变，`image001.png` 假缺口消失，未解析资源降为 1 条。剩余 Google CSE 运行时脚本和未捕获页面仍阻断 strict，历史试点报告保留原始证据，不把这次复扫写成“已通过”。
- 验收子系统未改动：`FROZEN-VERIFIER.sha256` 的 14 个文件字节不变。

## 历史归档

- 逐日审计报告与证据：`docs/audits/README.md` 索引，原始文件在 `D:/Github-Star/heimdall-evidence-archive/2026-10-30/` 与 git 历史。
- 截至 2026-10-13 的开发记录、旧路线图、旧使用说明：`docs/archive/`。
