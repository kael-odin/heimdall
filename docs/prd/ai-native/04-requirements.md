# 04 需求

上一篇：[03 架构](03-architecture.md) · 下一篇：[05 前端高精度重建](05-frontend-rebuild.md)

---

## 0. 约定

- **编号**：`E{n}-{nn}`，n 是 Epic，nn 是序号。编号一经评审通过不再复用。
- **优先级**：**P0** = 进入比赛 MVP 范围；**P1** = 加分项或赛后第一批；**P2** = 赛后。**P0 内部再分 Tier S（必保）与 Tier M（加厚，可按容量砍）**，逐条归属见 [10 §1.6](10-roadmap-risks.md)，砍的顺序见 [README §3](README.md)。
- **阶段**：Ph1 手眼（10-28 → 11-03）、Ph2 闭环与剧场（11-04 → 11-10）、Ph3 加固与彩排（11-11 → 11-17）、Ph4 赛后、Ph5 远期。
- **验收标准（AC）**：能被测试或演示直接证伪的一句话。带【假设 A-n】的数字是目标，Phase 0 实测后改写（[10 §3](10-roadmap-risks.md)）。
- **所有新代码遵守**：只加不改旧路径；不修改验收「指纹」冻结的 10 个文件；Windows 原生与 Linux CI 都要过。

| Epic | 主题 | 一句话 |
| --- | --- | --- |
| E1 | 能力注册表与控制面 | 能力定义一处，四个外壳由它生成；任务可排队、幂等、预算、审计 |
| E2 | MCP 服务器 v2 | 无状态、结构化、可读结果、长任务可轮询 |
| E3 | 代理级 CLI | `--json`、`--wait`、统一退出码、Windows 原生 |
| E4 | 技能与插件包 | 把「怎么闭环」教给代理；一条命令安装 |
| E5 | HTTP API v1 | 稳定契约 + OpenAPI |
| E6 | 证据引擎 | 简报、分段、对比、修复包、围栏 |
| E7 | 重建环（前端） | 工作区、门禁、收敛、镜像兜底 |
| E8 | 行为环（逻辑） | 行为规格、流程回放对照、旅程录制 |
| E9 | 契约与后端环 | HAR → 契约 → 适配器 / 服务；出处标注 |
| E10 | Autopilot | 内置驱动的闭环（赛后） |
| E11 | 傻瓜式体验 | doctor、连接 AI、AI 活动、示例站、人话 |
| E12 | 安全、治理与成本 | 秘密、围栏、作用域、预算、供应链 |
| E13 | 自动化与集成 | CI、webhook、工作流平台、审计—修复 |
| E14 | 质量、评测与可观测 | Bench、一致性测试、指标、探针 |

---

## E1 能力注册表与控制面

**目标**：同一能力只写一次；代理并发调用不炸；一切可审计、可限额。**不做**：重写 `engine-server.mjs`、改 `jobs.db` 表结构。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E1-01 | 注册表定义格式：`id / title / description / effects / scope / idempotent / longRunning / cost / input / output / artifacts / legacy / handler`（[03 §2](03-architecture.md)） | P0 | Ph1 | 核心 8 个能力均用该格式定义；JSON Schema 校验通过；重复 id 或工具名被拒绝 |
| E1-02 | 由注册表生成 MCP 工具清单（注解、`outputSchema`、确定性顺序） | P0 | Ph1 | 生成物与 `tools/list` 一致；注解与 `effects` 映射正确；两次生成字节一致 |
| E1-03 | 由注册表生成 CLI 子命令与 `heimdall --help --json` | P0 | Ph1 | 每个能力有对应命令；JSON 清单可解析并含参数 schema |
| E1-04 | 由注册表生成 `GET /api/v1/openapi.json`（OpenAPI 3.1）；Ph1 先用通用路由 `POST /api/v1/tools/{name}`，不逐能力生成路由 | P0 | Ph2 | OpenAPI 通过校验器；文档里的示例请求在 CI 里跑通 |
| E1-05 | CI 同步检查：重新生成并与已提交的生成物（附录 A 表、`openapi.json`、CLI 清单）diff | P0 | Ph2 | 手改任一生成物，CI 变红 |
| E1-06 | 统一结果信封：必有 `ok / result / error{code,message,hint} / summary / nextActions[] / evidence[]`，可选 `jobId / warnings / meta / trust / redactions`（字段见 [附录 C §1](appendix-c-schemas.md)） | P0 | Ph1 | 所有能力的输出通过同一 schema 校验 |
| E1-07 | 每个结果带 `nextActions`（机器可读：`{tool, args?, reason}`）和 `summary`（≤ 3 行人话）；错误同样 | P0 | Ph1 | 抽样 20 个调用，100% 带两者 |
| E1-08 | 任务门面：槽被占用时**排队**并返回位置，而不是 `409 busy`；底层槽不动 | P0 | Ph1 | 并发发起 3 个同类任务 → 1 个 running、2 个 queued，依次完成；底层槽计数无漂移 |
| E1-09 | 幂等键 | P0 | Ph2 | 同键同参重复调用返回同一 `jobId`；同键异参返回 `idempotency_conflict` |
| E1-10 | 统一进度事件与取消 | P0 | Ph1 | 事件含 `stage/pct/message`；取消后子进程树（含 Chromium）已清理 |
| E1-11 | `agent.db`（`node:sqlite`，降级为原子 JSON）存令牌、预算计数、幂等键、账本索引 | P0 | Ph2 | 删除 `agent.db` 不影响现有功能 |
| E1-12 | 令牌与作用域 `read / clone / build / admin`；哈希存储；控制台与 CLI 可创建 / 撤销 / 设过期与预算 | P0 | Ph2 | `read` 令牌调用 `clone` 能力 → `forbidden`，且无任何副作用 |
| E1-13 | 预算 `maxPages / maxWallMs / maxToolCalls / maxLlmUsd`，另有并发任务数与读取体积两个维度（默认值见 [08 §5](08-security-governance.md)）；用尽返回 `budget_exceeded` + `nextActions` | P0 | Ph2 | 设 2 页上限，第 3 页被拒并给出下一步 |
| E1-14 | 审计日志 JSONL（路径 `<数据根>/audit/agent-YYYYMMDD.jsonl`），参数只存哈希与脱敏摘要；写入失败：本机模式放行并告警，共享模式暂停写类能力 | P0 | Ph2 | 每次调用一行；不含令牌与任何秘密 |
| E1-15 | 兼容层：旧 13 个 MCP 工具名映射到新能力（`legacy`） | P1 | Ph3 | 旧 `mcp.test.mjs` 改指 legacy 入口后仍通过 |

---

## E2 MCP 服务器 v2

**目标**：升级到 2026-07-28 规范；代理不仅能「按按钮」，还能「看结果」。**不做**：自己再造 JSON-RPC 栈（用官方 SDK）；依赖已弃用的 Sampling / Roots / Logging。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E2-01 | 采用官方 TypeScript SDK v2（`@modelcontextprotocol/server`），**无状态** Streamable HTTP（`createMcpHandler`）+ stdio 入口；放 `packages/mcp/`，独立 `package.json`；实现用纯 ESM（无构建步骤，与仓库一致），核心 `core` 保持依赖精简；为插件分发另产出**自包含的单文件**入口 `plugin/server/heimdall-mcp.mjs`（含依赖，随版本提交），安装后不再需要 `npm install` | P0 | Ph1 | 官方 client 库能连；`server/discover` 返回版本与能力；仍用 2025 版握手的客户端也能连（legacy stateless）。Ph0 S3 已在 Windows 上用 2.4.0 验证：stdio（`serveStdio`）与无状态 HTTP（`createMcpHandler`）× 2025 握手 / 自动协商 / 钉死 2026-07-28 六种组合全通，结构化结果、图片、注解、资源、`server/discover` 都可用；`@modelcontextprotocol/node` 没有 2.4.0 版，`node:http` 需自写约 15 行的 fetch 桥接，桥前做 Host / Origin 校验 |
| E2-02 | 核心 8 工具：`overview / site / brief / artifact / compare / jobs / clone / doctor`，含 schema、注解、`outputSchema` 与 `structuredContent`，并附文本回退 | P0 | Ph1 | schema 校验通过；在 Claude Code 与 Claude Desktop 里被正确调用（Ph0 spike 先验证） |
| E2-03 | 图片内容：`artifact` / `compare` 可把裁剪图作为 image content 返回，同时给资源 URI。（shell 型代理 Ph1 直接读 `.heimdall/runs/` 下的 PNG，不依赖此项） | P0 | Ph2 | 客户端能读取图片；单图 ≤ 1.5 MB |
| E2-04 | 资源 `heimdall://…`：list / read / 模板；设置 `ttlMs`、`cacheScope` | P0 | Ph1 | `resources/list` 与 `read` 可用；模板参数可补全 |
| E2-05 | 提示词 prompts：`clone`、`rebuild`（MVP）；`add-behavior`、`mock-backend`、`regress`、`audit-fix`（后续） | P0 | Ph2 | `prompts/list` 返回；参数化填充后可直接执行 |
| E2-06 | 服务器不持有状态：连接或自起本机引擎，核对数据根一致（沿用 `handoff.mjs`） | P0 | Ph1 | 数据根不一致 → 拒绝并给出 hint；控制台能看到 MCP 发起的任务 |
| E2-07 | 长任务：返回 `jobId` + `nextActions`；`heimdall_jobs` 支持 `list / status / wait / cancel / events`（`wait` 单次 ≤ 60 秒，可重复调用） | P0 | Ph1 | 3 个 Tier-1 客户端都能完成「发起 → 等待 → 取结果」 |
| E2-08 | 请求内进度通知 `notifications/progress` | P1 | Ph2 | 支持进度的客户端显示进度 |
| E2-09 | 所有读工具有 token 预算参数与默认上限；超限必截断并说明如何取更多 | P0 | Ph1 | 构造超大输出，响应 ≤ 上限且带「取更多」提示 |
| E2-10 | 一致性测试（用官方 client SDK）：discover、list 稳定顺序、schema、注解、错误码、legacy 握手。测试放 `packages/mcp/test/`，由独立 CI job `ai (mcp)` 运行（[09 §5](09-quality-metrics.md)） | P0 | Ph2 | CI 必跑 |
| E2-11 | 非核心工具：`journey / spec / verify_backend / deliver / analyze / budget` | P1 | Ph3–4 | 按各 Epic 交付 |
| E2-12 | 保留旧 stdio 服务器为 `heimdall mcp --legacy` 一个版本，启动打弃用提示 | P1 | Ph2 | 旧测试仍过 |
| E2-13 | 协商 Tasks 扩展（`io.modelcontextprotocol/tasks`）：`jobId` 同时作为 `taskId`；失败回落到 E2-07 | P1 | Ph3 | 支持 Tasks 的客户端走轮询；否则自动回落 |
| E2-14 | MCP Apps：`ui://heimdall/compare`（前后对比滑块 + 门禁卡）、`ui://heimdall/atlas`；单文件打包；不支持时文本回退 | P2 | Ph4 | 在支持 Apps 的客户端里渲染；不支持的客户端不受影响 |
| E2-15 | MRTR（`input_required`）用于需要人确认或人操作的步骤（旅程录制、破坏性确认） | P1 | Ph3 | 客户端不支持时降级为「返回说明 + 人去控制台点」 |
| E2-16 | 远程模式：Streamable HTTP + OAuth 2.1（Client ID Metadata Documents），令牌作用域映射 | P2 | Ph4 | 团队服务器可被 claude.ai 连接器连接 |

---

## E3 代理级 CLI

**目标**：任何会跑命令的代理都能把 CLI 当 API 用。**不做**：改变旧命令的默认行为。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E3-01 | 全局 `--json`：stdout 只含 NDJSON 事件流与**最后一行**结果对象，日志走 stderr | P0 | Ph1 | `heimdall compare --json \| jq` 可解析；无混杂日志 |
| E3-02 | `--wait`（默认，阻塞到结束）/ `--no-wait`（立即返回 `jobId`）/ `--timeout` | P0 | Ph1 | 两种模式结果一致；超时返回 `timeout` 与 `jobId` |
| E3-03 | 统一退出码 `0 / 1 / 2 / 3 / 4 / 5 / 6 / 7`（成功、门禁未过或部分成功、用法错误、引擎或环境不可用、排队 / 忙 / 等待超时、无权限、预算用尽、内部错误），语义以 [附录 A §1.6](appendix-a-tools.md) 为准 | P0 | Ph1 | 文档化并有测试 |
| E3-04 | 新命令：`overview`、`brief`、`compare`、`jobs`、`doctor`、`connect`、`rebuild init / status` | P0 | Ph1 | 每条命令有 `--json` 输出与示例 |
| E3-05 | `heimdall --help --json`：机器可读的命令清单（参数 schema + 示例） | P0 | Ph1 | 代理读它即可发现所有命令 |
| E3-06 | 旧命令保持兼容 | P0 | Ph1 | 现有 CLI 测试全过 |
| E3-07 | 读类命令直接读工作区（不需要引擎）；任务类命令连接或自起引擎（核对数据根） | P0 | Ph1 | 无引擎时 `brief` 可用；`clone` 自起引擎并在结束后关闭 |
| E3-08 | Windows 原生（无 WSL）全部通过：路径含空格与中文、不依赖 bash | P0 | Ph1 | Windows 与 Linux CI 均过 |
| E3-09 | 根目录 `bin/heimdall.mjs` 与 `package.json` 的 `bin`；发布前用 `node bin/heimdall.mjs` | P1 | Ph2 | 本地一条命令可调用 |
| E3-10 | 遵守 `NO_COLOR`；`--quiet`、`--yes`；仅 TTY 下出现交互提示 | P1 | Ph2 | 非 TTY 下永不阻塞等待输入 |
| E3-11 | `heimdall setup`：一条命令完成 Node 检查 → 依赖 → Chromium（镜像源可配）→ 构建控制台 → 起引擎 → 打开浏览器 → 引导「连接 AI」（[07 §1.2](07-ux.md)） | P1 | Ph2 | 全新 Windows 机器一条命令走通；每步失败都有人话提示 |

---

## E4 技能与插件包

**目标**：把「怎么闭环」做成可安装的技能，而不是每次让用户贴长提示。**不做**：在技能里放可执行的不受限 `Bash(*)`。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E4-01 | 技能 `heimdall`（路由）：识别意图选剧本；工具 / 命令速查；中英触发词 | P0 | Ph1 | `description + when_to_use` ≤ 1,536 字符；`SKILL.md` ≤ 500 行 |
| E4-02 | 技能 `heimdall-rebuild`：重建环完整剧本（[附录 B](appendix-b-playbooks.md)） | P0 | Ph1 | 在夹具 F1 上，不加额外提示，Claude Code 能跑到门禁 |
| E4-03 | 技能 `heimdall-behavior`、`heimdall-backend`、`heimdall-regress`、`heimdall-audit-fix` | P1 | Ph3–4 | 按各 Epic 交付 |
| E4-04 | Claude Code 插件包，插件根为仓库内 `plugin/`：`.claude-plugin/plugin.json`、`skills/`、`agents/`（`heimdall-section-builder`、`heimdall-reviewer`）、`commands/`、`.mcp.json`、自包含的 MCP 单文件入口（[附录 B §1](appendix-b-playbooks.md)） | P0 | Ph1 | `/plugin install` 后技能、子代理、MCP 同时可用；插件目录自包含 |
| E4-05 | 市场清单：仓库根 `.claude-plugin/marketplace.json`，`source` 指向 `./plugin`（私有 git 仓库可用） | P0 | Ph1 | 全新机器 `/plugin marketplace add` → `install` 成功 |
| E4-06 | 剧本按模型能力分档：frontier（整页并行分段）/ standard（逐段）/ economy（更小分段 + 更多提示） | P0 | Ph2 | 技能内含分档规则；Bench 覆盖三档 |
| E4-07 | `pnpm skills:sync`：把工具集占位符展开为全名、把「不可信内容」指令块内联进每个技能与子代理、复制到 `.agents/skills/`（Codex / 通用路径），保持**单一来源**（`plugin/skills/`） | P1 | Ph2 | 两处内容一致，CI 检查 |
| E4-08 | MCPB 打包（`mcpb pack`）供 Claude Desktop 双击安装 | P1 | Ph3 | Windows 上安装成功并出现工具 |
| E4-09 | 技能 `allowed-tools` 最小权限：Heimdall 工具 + 项目内读写 + 受限命令（`heimdall *`、`pnpm *`），**不得** `Bash(*)` | P0 | Ph1 | 供应链审查清单通过（[08 §7](08-security-governance.md)） |
| E4-10 | 技能评测：触发率（应触发 / 不应触发各 10 句）+ 有无技能的 A/B | P0 | Ph2 | 触发 ≥ 90%，误触发 ≤ 10% |
| E4-11 | 仓库根 `AGENTS.md`（面向贡献者的代理）+ `CLAUDE.md` 引用：构建 / 测试命令、禁区（指纹冻结文件）、约定 | P1 | Ph2 | 新会话读完即知禁区 |

---

## E5 HTTP API v1

**目标**：稳定、语言无关的契约，MCP 与 CLI 的下层，也服务工作流平台与 CI。**不做**：改旧 `/api/*` 的行为。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E5-01 | `POST /api/v1/tools/{name}` 调用；`GET /api/v1/capabilities` | P0 | Ph1 | 输入输出遵循注册表 schema |
| E5-02 | `GET /api/v1/jobs/{id}`、`/jobs/{id}/events`（SSE，支持 `?after=seq` 续传）、`POST /jobs/{id}/cancel` | P0 | Ph1 | 断线重连后不丢事件 |
| E5-03 | `GET /api/v1/artifacts?uri=`：读取资源（文本 / 图片，支持 Range） | P0 | Ph1 | 受作用域与秘密名单约束 |
| E5-04 | 统一错误模型与状态码映射（400 / 401 / 403 / 404 / 409 / 422 / 429 / 5xx）和 `error.code` | P0 | Ph1 | 错误码表文档化 |
| E5-05 | 与旧 `/api/*` 并存；v1 通过任务门面调用旧机制 | P0 | Ph1 | 旧路由测试全过 |
| E5-06 | OpenAPI 3.1 静态文档页 `/api/v1/docs` | P1 | Ph2 | 可浏览、可下载 |
| E5-07 | 队列位置、限额响应头 | P1 | Ph3 | 客户端能据此退避 |

---

## E6 证据引擎

**目标**：把 GB 级原始产物压成代理能用的证据，并把视觉差异变成「编译器报错」。这是整个方案的**钥匙**。**不做**：向代理返回原始 HAR、会话、原始大文件。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E6-01 | **简报 Brief**：页面概览（类型、视口、分段数、令牌摘要、字体 / 资产索引、交互清单、接口摘要、门禁历史与缺口）；`detail: outline / sections / full` | P0 | Ph1 | 中位页 `outline` ≤ 1.5 万 token【假设 A-2】；含围栏 |
| E6-02 | 结构大纲算法（沿用 [01 §1.4](01-background.md) 探针：跳过脚本与样式、折叠重复兄弟、深度与节点上限）+ 各视口几何 | P0 | Ph1 | 对 415 页回归集，p90 大纲 ≤ 3 万 token（由探针复测） |
| E6-03 | **分段 SectionPlan**：按语义标签、视觉分隔、深度与几何生成稳定 ID；各视口边界框、DOM 锚点、参考裁剪图、依赖（共享组件） | P0 | Ph1 | 同页重复生成 ID 稳定；覆盖页面高度 ≥ 98%，重叠 ≤ 2% |
| E6-04 | 渐进披露：`brief(sectionId)` 返回该段子树大纲 + 命中的 CSS 规则（取自 CSSOM，含媒体查询）+ 计算样式摘要（去重签名）+ 每个元素三视口外接框 + 资产引用。Ph0 S2 补充必须给出的五类事实：①分段起点的亚像素偏移（取整后的外接框藏住了 0.1–0.6px 的偏移）；②来自分段外层、画在分段范围内的装饰（如 1px 边线）；③伪元素的计算样式（不只 `content`）；④哪些尺寸是写死的、哪些由内容撑开（770 vs 770.78）；⑤文字不截断，必须截断时显式标出，避免模型自己补写 | P0 | Ph1 | 单段默认 ≤ 2.5 万 token；超限截断并提示；Ph0 原型简报 1.4–2.5 万字符（约 4–7 千 token【估算】） |
| E6-17 | **参考度量工具**（Ph0 S2 新增）：`heimdall_measure`，对参考图给出逐行 / 逐列墨迹轮廓、细线位置与颜色、指定点取色、分段起点亚像素偏移估计。Ph0 所有达到 gold 的模型都先自己写脚本解码 PNG 量参考图，占去了大部分 token | P1 | Ph2 | 夹具上同一分段的花费比 Ph0 基线降 ≥ 30%，迭代数不增加 |
| E6-05 | 设计令牌摘要（沿用 `extractTokens`）、字体清单（本地文件）、断点清单 | P0 | Ph1 | 令牌数与 `tokens` 命令一致 |
| E6-06 | 交互与动效清单（来自 `motion.json` 与 DOM 中的可交互控件；只描述，不执行） | P1 | Ph2 | 清单项都能追溯到证据 |
| E6-07 | 接口摘要（来自清洗后 HAR）：方法 + 路径模板 + 状态 + MIME + 次数，不含正文 | P1 | Ph2 | 秘密扫描 0 命中 |
| E6-08 | 证据引用：结论字段带 `evidence:[{uri, sha256, bytes}]`，可通过 `artifact` 读取并校验哈希 | P0 | Ph1 | 随机抽 20 条引用，哈希全部一致 |
| E6-09 | **对比 `compare`**：输入候选 URL 或项目目录、视口集、分段子集；输出判定 + 修复包 + 趋势。`dir` 模式在 Ph1 由调用方（代理或人）启动 dev server，Heimdall 只访问 `devServer.url`；启停交给 Ph4 的 Autopilot | P0 | Ph1 | 夹具页三视口 ≤ 20 秒（本机）【A-6，Ph0 实测 9–12 秒】 |
| E6-10 | **修复包 FixPacket v1**：区域（边界框、面积占比、严重度）、原因分类（缺失内容 / 多出内容 / 位移 / 间距 / 尺寸 / 字形 / 颜色 / 图像缺失 / 未知）、裁剪图（参考 / 候选 / 差异）、建议顺序。算法按 Ph0 S1 原型：行对齐与双映射、±1px 容差找区域、接缝规则、按参考元素归并、级联与集中度排序（[05 §3.1](05-frontend-rebuild.md)） | P0 | Ph1 | 在注入已知缺陷的夹具上，前 3 条区域与注入缺陷重合 ≥ 80%【A-10，Ph0 实测严格口径 86%】；原因判对率作为指标上报，不设门槛（Ph0 约 77%）；没有区域通过筛选时也给残差摘要（零散噪声在哪、占多少），高度差 ≤ 1 行时注明是取整，`maxBlobPct` 另给相对页面面积的值（Ph0 S2 反馈：否则「最大块大于总损失」会误导模型） |
| E6-11 | **元素对应**（不依赖 DOM 结构相同）：几何 IoU + 文本相似 + 角色 / 标签 + 图像哈希，匈牙利匹配，输出置信度；低置信度只给区域不给元素 | P0 | Ph2 | 人工标注 100 对，正确率 ≥ 90%【假设 A-5】 |
| E6-16 | **修复包 FixPacket v2**：在 v1 上加对应元素（候选侧选择器、参考侧锚点、置信度）与属性差（参考值 vs 候选值，取自计算样式） | P0 | Ph2 | 注入缺陷夹具上，前 3 条的元素与属性与注入缺陷一致 ≥ 70%【假设 A-5】；消融臂 A3 用此版本 |
| E6-12 | 动态区域遮罩（多帧差集 + 动效档案），不计入像素分；遮罩占比过大标 `needs_review` | P1 | Ph2 | 遮罩占比写入报告 |
| E6-13 | 趋势与停滞 / 振荡检测 | P0 | Ph2 | 构造停滞序列，控制器按规则升级 |
| E6-14 | 无障碍对照：新增违规数 vs 参考 | P1 | Ph3 | 夹具上能检出注入的缺失 `alt` |
| E6-15 | **不可信内容围栏**：所有来自网页的字符串（文本、属性、`title`、`alt`、注释）输出时加围栏标记；清理控制字符与零宽字符；单字段长度上限；不可见文本（`display:none`、屏外、`aria-hidden`、`<template>`）与注释不进正文，只记数量；指令式文本告警；响应带 `trust` 块（随机 nonce 围栏，[08 §3.2](08-security-governance.md)） | P0 | Ph1 | 100 条提示注入样例全部被围栏，告警命中 ≥ 80% |

---

## E7 重建环（前端）

**目标**：把冻结的镜像变成可维护项目，并**证明**它对。**不做**：改变镜像产出路径；让模型改门禁。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E7-01 | `heimdall rebuild init <url\|siteId> --stack <profile>`：生成重建工作区（[03 §4.3](03-architecture.md)） | P0 | Ph1 | 全新目录一条命令生成；`pnpm dev` 能起；`AGENTS.md` 完整 |
| E7-02 | 技术栈配置：`html-css`、`vite-react-ts-tailwind`；锁版本；镜像源可配 | P0 | Ph1 | `pnpm install --frozen-lockfile` 成功；端口可配 |
| E7-03 | 技术栈配置：`vite-vue3-ts-tailwind`（P1）；`nextjs-app-router`、`astro`（P2） | P1 | Ph3–4 | 同 E7-02 |
| E7-04 | 门禁**只由确定性引擎评估**；模型提议的阈值、遮罩改动不接纳（需人改配置并重跑） | P0 | Ph2 | 篡改测试：代理改了 `gate` → 本次仍用冻结值并告警 |
| E7-05 | 保真旋钮 `faithful / balanced / idiomatic` 写入配置，体现在简报和技能 | P0 | Ph1 | 三档在夹具上产生可区分的策略与成本 |
| E7-06 | 门禁定义：视觉（三视口像素 + 最大连通块）、结构语义、关键元素样式、资产本地化、控制台错误与溢出；`bronze / silver / gold` 默认阈值（[05 §1](05-frontend-rebuild.md)） | P0 | Ph2 | 阈值可配；报告逐维列出；视觉含 Ph0 新增的「最大集中区域」维度（[05 §1.1](05-frontend-rebuild.md)） |
| E7-18 | **反作弊检查**：门禁检测并拒绝以参考截图充当内容——候选项目引用 `.heimdall/ref/` 下任何文件；候选页中占视口面积大的位图与参考裁剪的感知哈希过于相似；文本节点大量缺失（由 `structure` 维度兜底） | P0 | Ph2 | 把参考截图当整页背景贴上去的候选：`visual` 满分，但门禁整体不通过并指出原因 |
| E7-07 | **正式裁判**：用验收 Mirror 跑候选（基线 = 镜像的正式基线副本，目标 = dev server），取健康、结构、行为与首屏视觉；整页视觉由评估器给出（E7-20）；出报告与证据引用；失败项转修复包 | P0 | Ph2 | 夹具上端到端跑通；不修改指纹冻结文件 |
| E7-19 | **正式基线供给与体检**（Ph0 S4 新增）：`Gate` 封装每次运行起本机回环、随机端口、无令牌、不加 CSP sandbox 的只读静态服务供基线，运行结束即关；提交前对基线跑健康探针，不健康时生成去掉外部请求与断链引用的正式基线副本并记录改动；仍不健康则该维度 `blocked` 并写明原因 | P0 | Ph2 | thordata.com 与 apify.com 的镜像作基线时，正式视觉不再因基线健康而 `blocked`（Ph0 实测：现状 100% `blocked`）；令牌不出现在任何报告与证据里 |
| E7-20 | **评估器整页视觉**（Ph0 S4 新增）：整页像素、最大块、最大集中区域由评估器在灰度文字下按 4096px 分块拍整页给出，与快速裁判共用代码；`gate.json` 每一维写明真值来源（`acceptance` / `evaluator`） | P0 | Ph2 | 超出验收截图预算的页面（thordata.com 首页三视口全超）拿到整页视觉判定；同一对页面上评估器与快速裁判的分数一致 |
| E7-08 | **收敛控制器**（[03 §5.4](03-architecture.md)）：迭代上限、停滞、回退、振荡、预算、终态 | P0 | Ph2 | 单测覆盖各规则；终态枚举固定 |
| E7-09 | 门禁配置在一次运行内冻结，哈希写入账本 | P0 | Ph2 | 账本含配置哈希；运行中改配置不生效 |
| E7-10 | **Floor=Mirror 交付**：终态非 `passed` 时交付镜像 + 报告 + 残差清单；通过时交付重建项目 + 报告 + 镜像附件 | P0 | Ph2 | 故意让重建失败 → 交付物仍完整且标明状态 |
| E7-11 | 资产落地：`public/assets` 来自 CAS 原件（字体、图片、图标），提供资产索引与引用路径；门禁检查零外链 | P0 | Ph1 | 重建页断网加载零外联（夹具） |
| E7-12 | 共享组件优先：多页站的 header / footer / 导航先建并复用；简报给出共享候选（重复子树检测） | P1 | Ph2–3 | 夹具多页站共享组件只实现一次 |
| E7-13 | 整站模式：`rebuild init --all`、路由映射、`verify --all --resume` 对重建项目复验 | P1 | Ph3 | 夹具多页站全站复验 |
| E7-14 | **飞行记录器** `ledger.jsonl` + 回放（`rebuild replay <runId>` 把事件时间线重放到「AI 活动」视图，**明确标注回放**） | P0 | Ph2 | 回放视图显著标「回放」；与实录事件序列逐条一致 |
| E7-15 | 响应式推断：CSSOM 断点 + 三视口差异生成断点建议 | P1 | Ph3 | 夹具上建议与实际断点一致 |
| E7-16 | 动效保留：`motion.json` 动效清单 + 帧采样对照 | P2 | Ph4 | 夹具上能报告动效缺失 |
| E7-17 | 现有 `fixup`（镜像自身的 AI 校准）改为消费修复包，模型可选；保留「变差回滚、补丁硬规则」的守门。也是 Plan B（[10 §1.2](10-roadmap-risks.md)）的落点 | P1 | Ph3 | 在夹具上，镜像分数的提升不低于旧实现；守门测试仍过 |

---

## E8 行为环（逻辑）

**目标**：交互逻辑可补全、可验证。**不做**：对源站回放写操作；绕过登录或验证码。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E8-01 | 行为候选汇总：操作发现 + 静态 DOM 中的表单 / 展开控件 / 标签 / 分页 + 动效 → 行为规格草案（标 `observed` / `inferred`） | P1 | Ph3 | 夹具上召回全部预置交互 |
| E8-02 | 从行为规格生成 `operation-plan.json` 草案（人审后执行） | P1 | Ph3 | 草案通过现有 schema 校验 |
| E8-03 | **双侧回放**：同一流程在参考（镜像或源站只读）与候选上运行，比较可观察结果；差异进入修复包（类别 `behavior`） | P1 | Ph3 | 夹具上能检出注入的「菜单点击不展开」 |
| E8-04 | 扩展 `expect` 类型：`count`、`value`、`attribute`、`class` | P1 | Ph3 | 向后兼容；不动验收指纹文件 |
| E8-05 | **旅程录制器**：可见浏览器中由人操作，记录步骤、DOM 快照、清洗 HAR、截图；结束产出旅程制品（原始 HAR 为秘密级） | P2 | Ph4 | 录制一次搜索 + 翻页旅程并生成行为规格 |
| E8-06 | 表单校验行为：从旅程推断必填 / 格式 / 长度规则，标 `inferred` | P2 | Ph4 | 夹具表单规则召回 ≥ 90% |
| E8-07 | 状态机视图（组件状态与转移）可视化 | P2 | Ph5 | 控制台可看 |

---

## E9 契约与后端环

**目标**：把**被观察到**的后端行为变成可验证的契约和可运行的替身。**不做**：声称等价；对源站重放写请求；恢复未被观察的业务规则。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E9-01 | 「给 AI 看的 HAR」：复用 `live/har.mjs` 清洗规则；原始 HAR 不出库 | P1 | Ph3 | 向 HAR 植入 20 类假秘密，输出 0 命中 |
| E9-02 | 端点聚类与路径模板化；参数、响应 schema、分页、错误形状推断 | P1 | Ph3 | 夹具后端端点召回 ≥ 95%【假设 A-7】 |
| E9-03 | 契约草案输出：OpenAPI 3.1 + `observations.json`（样本数、方差、置信度）+ `fixtures/` + `unknowns.json` | P1 | Ph3 | 草案通过 OpenAPI 校验；未知项非空时必须列出 |
| E9-04 | **适配器生成（B2）**：基于契约 + 夹具生成 `runtime-adapter/index.mjs` + `manifest.json`，带状态（内存 / SQLite），遵循现有适配器协议 | P2 | Ph4 | 夹具上通过严格离线门禁 |
| E9-05 | **出处标注** `observed / inferred / invented`：数据模型与展示规范，适用于简报、行为规格、契约、适配器 | P0 | Ph2 | 每个生成条目带出处；`invented` 在报告中单列 |
| E9-06 | 服务脚手架（B3）：Node + SQLite（或 Python），测试，Dockerfile | P2 | Ph4 | 通过同一验证套件 |
| E9-07 | 后端验证：训练集重放、**留出集重放**（默认 20%）、属性 / 契约测试、与源站只读对照、覆盖矩阵 | P1 | Ph3 | 夹具上报告给出留出集等价度 |
| E9-08 | 所有者协作（B4）：导入所有者的 OpenAPI / DB schema / 源码目录，与推断结果 diff | P2 | Ph5 | 能列出推断与提供之间的差异 |
| E9-09 | 写操作策略：写请求只来自人录制的旅程；适配器里的写用夹具后端实现并标 `inferred` | P1 | Ph3 | 工具链里不存在对源站发写请求的代码路径（评审 + 测试） |
| E9-10 | 夹具后端（Bench F5 / F6）：已知隐藏后端，用于计算行为等价度 | P1 | Ph3 | 夹具可离线启动 |

---

## E10 Autopilot（赛后）

**目标**：控制台一个按钮跑完闭环。**不做**：MVP 内实现。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E10-01 | 控制台「AI 重建」：选目标、技术栈、保真档、预算 → 启动 | P2 | Ph4 | 一键启动并在「AI 活动」可见 |
| E10-02 | E1 引擎：Claude Agent SDK 封装（加载本仓库插件与 Heimdall MCP；仅 API Key；工具白名单；预算） | P2 | Ph4 | 夹具上端到端通过 |
| E10-03 | E2 引擎：原生编排；扩展 `llm.mjs`（工具调用、流式、结构化补丁）；模型分档与分解策略（弱模型走更细分段） | P2 | Ph5 | 用一个国产模型在夹具上跑通 Silver |
| E10-04 | 断点续跑（`state.json` + 账本）与可选人工检查点（每段 / 每页暂停） | P2 | Ph4 | 杀进程后可续 |
| E10-05 | 拒绝处理：`refusal` 停止原因 → 向用户说明并降级模型；默认启用服务端降级；不发送已移除的参数 | P1 | Ph4 | 模拟 `refusal` 事件，状态可恢复 |
| E10-06 | 沙箱：重建项目的 `install / build / run` 在受限目录与环境；可选 Docker | P2 | Ph4 | 无秘密环境变量；`--ignore-scripts` |
| E10-07 | 失败自愈：诊断捕获 / 验证失败类 → 提议站点配方补丁 → 复测 → 通过才保留（沿用 `fixup` 守门） | P2 | Ph5 | 对「渲染未收敛」类失败给出可验证补丁 |
| E10-08 | 子代理并行分段（E1 引擎）与冲突合并（按分段 ID 分文件） | P2 | Ph5 | 并行与串行结果门禁一致 |
| E10-09 | 外流预览与脱敏开关（`--no-images`、`--redact-text`） | P1 | Ph4 | 预览列出将发送的内容类别与大小 |

---

## E11 傻瓜式体验

**目标**：第一次成功不需要读文档。设计细节见 [07](07-ux.md)。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E11-01 | `heimdall doctor`：检查 Node、pnpm、Chromium、端口、数据根可写、令牌状态、LLM 配置（可选）、磁盘；每项 ✓/✗ + 修复命令；`--fix` 自动做安全修复（装 Chromium、起引擎） | P0 | Ph1 | 全新 Windows 机器按提示走通 |
| E11-02 | `heimdall connect <client>` 与控制台「连接 AI」：检测客户端；展示将写入的配置差异；确认后写入（先备份）；真实调用 `tools/list` + `overview` 自测。配置在 **Windows 原生**下正确（路径含空格、不依赖 WSL）。Ph1 先做 Claude Code、Claude Desktop；Ph2 补 Cursor、VS Code、Codex；`heimdall connect --remove <client>` 还原备份 | P0 | Ph1–2 | 5 个 Tier-1 客户端在 Windows 通过；失败给出人话原因 |
| E11-03 | 控制台「AI 活动」：实时工具调用流、任务、星图高亮当前页 / 分段、分数曲线、修复包前后对比滑块、预算表、**「停止代理」**（撤销令牌 + 取消任务） | P0 | Ph2 | 代理跑一次重建，视图更新延迟 ≤ 2 秒 |
| E11-04 | 控制台「提示词库」：8–10 张卡片，参数表单 → 可复制提示词 | P1 | Ph2 | 生成的提示词在 Claude Code 里直接可用 |
| E11-05 | 内置**离线示例站**：无网络、无真实站点也能「5 分钟体验」；首次启动向导指向它 | P0 | Ph2 | 断网环境走完重建 |
| E11-06 | 控制台任务卡显示 `summary` 与 `nextActions` 按钮（沿用审计提出的「人话错误卡片」） | P0 | Ph1 | 失败任务点按钮能执行下一步 |
| E11-07 | 错误码表：每个错误有 `code`、人话原因、修复命令；覆盖 `doctor` 全部检查项与常见失败 | P0 | Ph1 | 抽样 20 个错误均含 hint |
| E11-08 | 首次运行清单（控制台）：引擎 OK → Chromium OK → 连接 AI → 试示例站 | P1 | Ph3 | 新用户 10 分钟内完成 |
| E11-09 | 交付包「给下一个 AI 的说明」：重建项目与交接说明里生成 `AGENTS.md`（如何运行、结构、保真度、缺口、如何复验） | P1 | Ph3 | 新代理读它即可继续工作 |
| E11-10 | 一键安装脚本（PowerShell / bash）与 MCPB | P2 | Ph4 | 双击或一条命令装好 |
| E11-11 | 文案规范：中文为主；不出现内部里程碑黑话（D1–D6 一类）；术语表统一 | P0 | Ph1 | 文案走查通过 |

---

## E12 安全、治理与成本

**目标**：代理接入后，秘密不泄、页面内容不劫持、成本不失控。详见 [08](08-security-governance.md)。

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E12-01 | 默认代理档只暴露 `read / clone / build` 能力；破坏性能力需 `admin` 令牌 + 本机确认 | P0 | Ph2 | 代理档 `tools/list` 不含 destructive 工具 |
| E12-02 | **秘密隔离**：旅程原始录制命名为 `network.journey.har`（天然命中 `isSecretFile`），另加 `isSecretPath()` 按目录兜底；所有工具与资源输出过脱敏器（复用并导出 `har.mjs` 规则：令牌、cookie、`Authorization`、邮箱、JWT 等，补齐云密钥样式、私钥块、裸手机号 / 银行卡号等缺口，[08 §2.5](08-security-governance.md)） | P0 | Ph1 | 向工作区植入 20 类假秘密，任何工具输出 0 命中 |
| E12-03 | 令牌不入日志、不回显；日志脱敏 | P0 | Ph1 | 日志扫描 0 命中 |
| E12-04 | 成本护栏默认值（宽松但有限）与 `budget_exceeded` 体验 | P0 | Ph2 | 默认值文档化；用尽时有下一步 |
| E12-05 | 非本机模式的出站策略：强制令牌；默认禁私有、回环、链路本地、云元数据地址（**连接时解析校验**，防 DNS rebinding；重定向逐跳校验）；响应大小与时间上限。**任何非本机部署之前必须完成本条与 E12-06** | P1 | Ph3 | SSRF 测试集（[09 §3.5](09-quality-metrics.md)、[08 §4.2](08-security-governance.md)）全部被拦；本机模式行为不变 |
| E12-06 | `/px/` 代理不跟随跨 host 重定向、不透传 `set-cookie`（修审查指出的问题；远程模式前置） | P1 | Ph3 | 回归测试 |
| E12-07 | 技能 / 插件供应链：最小 `allowed-tools`、固定版本、发布前审查清单、不得有外联钩子 | P0 | Ph1 | 清单逐项签字 |
| E12-08 | 提示注入回归集（100 条）与自动化测试 | P1 | Ph3 | 进 CI |
| E12-09 | 使用说明（README + 技能顶部一句）；可选组织策略文件 `HEIMDALL_POLICY_FILE`（域名白 / 黑名单，**默认空 = 不限制**） | P1 | Ph3 | 默认行为与今天一致 |
| E12-10 | 写源站策略：默认只读（GET / HEAD / OPTIONS）；向源站的写请求只在人录制旅程时发生 | P0 | Ph1 | 评审 + 测试：代理可调用的工具链中无写源站路径 |
| E12-11 | 数据外流清单文档：哪些内容会进入模型上下文、如何关掉 | P1 | Ph2 | 文档与代码一致 |
| E12-12 | 登录态下采集的页面内容默认**不进**简报正文，需用户显式放行 | P1 | Ph2 | 用带会话的参考包生成简报：正文为空占位并说明如何放行 |

---

## E13 自动化与集成

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E13-01 | GitHub Action `heimdall-verify`：起 dev server → `compare --gate` → 上传报告 → PR 评论 | P1 | Ph4 | 示例仓库跑通 |
| E13-02 | 完成回调 webhook（HMAC 签名）；飞书 / 钉钉 / 企业微信 / Slack 格式 | P1 | Ph4 | 四种格式各一个测试 |
| E13-03 | 变更监控 → 增量克隆 → 代理出补丁 → PR | P2 | Ph5 | 夹具上闭环 |
| E13-04 | 工作流平台示例（Dify / Coze / n8n）与 OpenAPI 导入说明 | P1 | Ph4 | 示例流可导入运行 |
| E13-05 | `compare --gate` 退出码用于 CI；`--md` 输出可直接作 PR 评论的摘要 | P1 | Ph3 | 示例 CI 配置 |
| E13-06 | 审计—修复—复测剧本（S7）：`analyze seo` 输出结构化问题 → 技能 `heimdall-audit-fix` → 复测 diff | P1 | Ph3 | 夹具上修掉 3 类问题且复测通过 |
| E13-07 | 定时任务文档（计划任务 / cron） | P2 | Ph5 | 文档 |

---

## E14 质量、评测与可观测

| ID | 需求 | 优先级 | 阶段 | 验收标准 |
| --- | --- | --- | --- | --- |
| E14-01 | **Heimdall-Bench v0**：夹具 F1–F3 + 自有站 1 页；`pnpm bench:ai`（手动触发，记录成本） | P0 | Ph2 | 出一份结果表 |
| E14-02 | 消融实验臂 A0–A3（无 Heimdall / 简报 / 标量分数 / 修复包） | P0 | Ph2 | 同一模型四臂结果并列 |
| E14-03 | 单测：注册表校验、围栏、脱敏、元素对应、修复包生成、收敛控制器 | P0 | Ph1 | 进 `pnpm test` |
| E14-04 | 指标采集：每次运行记录 token、花费、迭代、耗时、终态；汇总页 | P0 | Ph2 | 汇总页可看 |
| E14-05 | 客户端兼容手测清单与结果页 | P1 | Ph3 | Tier-1 / Tier-2 结果公开 |
| E14-06 | **`heimdall probe`**：`sizes`（产物体量）、`outline`（大纲压缩）、`har`（第一方端点）；入库，复现 [01 §1.4](01-background.md) 的数字 | P0 | Ph1 | 同一批页面复跑数字一致 |
| E14-07 | 技能评测接入（`claude plugin eval`）与触发率回归 | P1 | Ph3 | 进 CI 或夜间 |
| E14-08 | Bench F4–F6 与留出集后端评测 | P1 | Ph3 | 出结果表 |
| E14-09 | 演示彩排清单、回放兜底联动（E7-14） | P0 | Ph3 | 彩排 ≥ 3 次，最后 3 次均一次通过（不触发降级） |
| E14-10 | 窄 Windows CI job `ai (windows)`：只跑 CLI 契约、`connect` 配置生成、MCP 连通子集、路径含空格与中文用例（[09 §3.8](09-quality-metrics.md)） | P1 | Ph2 | 推送 `main` 时运行并通过 |
| E14-11 | 提示注入红队观察：在 F1 的 A3 臂里植入 3 条注入文本，用审计日志统计代理「被劫持」次数（[09 §3.4](09-quality-metrics.md)）；不作门禁 | P1 | Ph3 | 次数写入护栏指标 |
| E14-12 | 趋势哨兵：以 F1 × Sonnet 5.5 × A3 × n = 1 的固定小集，在大改后回归；北极星下降超过 20% 或任一护栏非零即开缺陷单（需 Owner 批准花费） | P2 | Ph3 | 手动触发可用 |
| E14-13 | **Suite F 夹具 F1–F3 与缺陷注入集**：本地小型服务（随机端口、`?inject=<id>`），每类原因至少两个注入实例、合计不少于 48 个，注入清单只给评分器读（[09 §1.2–1.3](09-quality-metrics.md)）。它同时是示例站（E11-05）、CI 与演示的共同底座 | P0 | Ph1–2 | 夹具离线可启动；注入清单与实际缺陷一一对应；不依赖外网 |
| E14-14 | 元素对应标注集：100 对（重建页上的候选元素 ↔ 参考锚点），用于 A-5 的人工标注 | P0 | Ph2 | 标注集入库（夹具派生，不含第三方内容）；对应正确率可复算 |

---

## 附：按阶段的 P0 清单

用于拆任务。完整验收见上表。

| 阶段 | P0 需求 |
| --- | --- |
| **Ph1 手眼**（先打通最薄的一条竖线：`brief → compare → 技能`，再加厚） | E1-01 ~ E1-03、E1-06 ~ E1-08、E1-10 · E2-01、E2-02、E2-04、E2-06、E2-07、E2-09 · E3-01 ~ E3-08 · E4-01、E4-02、E4-04、E4-05、E4-09 · E5-01 ~ E5-03、E5-05 · E6-01 ~ E6-05、E6-08、E6-09、E6-10、E6-15 · E7-01、E7-02、E7-05、E7-11 · E11-01、E11-02（Claude Code、Desktop）、E11-06、E11-07、E11-11 · E12-02、E12-03、E12-07、E12-10 · E14-03、E14-06 |
| **Ph2 闭环与剧场** | E1-04、E1-05、E1-09、E1-11 ~ E1-14 · E2-03、E2-05、E2-10 · E4-06、E4-10 · E6-11、E6-13、E6-16、E6-17 · E7-04、E7-06 ~ E7-10、E7-14、E7-18 ~ E7-20 · E9-05 · E11-02（其余客户端）、E11-03、E11-05 · E12-01、E12-04 · E14-01、E14-02、E14-04、E14-13（F2–F3）、E14-14 |
| **Ph3 加固与彩排** | E14-09 · 其余为 P1（行为环 lite、契约草案、Vue、整站）按时间择取 |

**吞吐假设**：审查报告记录该仓库 13 个活跃日提交 225 次、核心源码约 4 万行、测试约 2,800 个（2026-10-22 口径）——说明 1 名主开发配 AI 编码助手的产出很高。但提交数不等于完成度；Ph1 的 P0 仍然很满，所以排序是「先薄竖线、后加厚」。容量核对（P0 约 35 个工作日 vs 窗口约 21 个）与分层砍法见 [10 §1.6](10-roadmap-risks.md)，砍的顺序见 [README §3](README.md)。
