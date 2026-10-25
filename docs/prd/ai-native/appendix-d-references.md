# 附录 D 参考资料与术语

返回：[PRD 入口](README.md)

证据口径同入口页。**来源类型**一列说明我拿到了什么：「读取原文」= 抓取并阅读了页面；「仅见检索摘要」= 只看到搜索结果里的摘要，没读到原文，引用时请当作二手信息；「二手」= 第三方文章转述。

---

## 1. 外部参考资料

访问日期均为 2026-10-24（调研当天）。

| 标题 | URL | 用于哪里 | 来源类型 |
| --- | --- | --- | --- |
| MCP 2026-07-28 变更清单（Key Changes） | https://modelcontextprotocol.io/specification/2026-07-28/changelog | [01 §2.1](01-background.md)；E2-01（无状态、`server/discover`）、E2-13（Tasks 扩展）、E2-15（MRTR）、E2-16（授权）；`ttlMs` / `cacheScope`、`Mcp-Method` / `Mcp-Name` 头、Roots / Sampling / Logging 弃用 | 读取原文【调研】 |
| MCP 2026-07-28 发布博客 | https://blog.modelcontextprotocol.io/posts/2026-07-28/ | 无状态服务器的迁移指引、MRTR、Tasks 作为扩展、授权变化（CIMD 取代 DCR）、SDK 支持概述 | 读取原文【调研】 |
| MCP Apps 公告 | https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/ | E2-14：`ui://` 资源、`io.modelcontextprotocol/ui` 扩展、已支持的客户端 | 仅见检索摘要【调研】 |
| MCP TypeScript SDK v2：支持 2026-07-28 的迁移说明 | https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 | E2-01、假设 A-4：`@modelcontextprotocol/server` 2.x、`createMcpHandler`、Tasks 扩展仍有缺口 | 仅见检索摘要【调研】 |
| Claude Code 技能文档 | https://code.claude.com/docs/en/skills | E4-01、E4-09、E4-10：`SKILL.md` 格式、frontmatter 字段、安装位置、`description + when_to_use` 1,536 字符与 500 行限制、便携字段、`claude plugin eval` | 读取原文（前 10 万字符）【调研】 |
| Claude Code 插件文档 | https://code.claude.com/docs/en/plugins | E4-04、E4-05：`.claude-plugin/plugin.json`、`marketplace.json`、插件组件、安装作用域、常驻上下文成本 | 读取原文【调研】 |
| Claude Agent SDK 概览 | https://code.claude.com/docs/en/agent-sdk/overview | [03 §6](03-architecture.md)、E10-02：SDK 能力（MCP、插件、技能、权限、子代理、钩子）；无头模式 `-p --output-format json`；「不允许第三方提供 claude.ai 登录」 | 读取原文【调研】 |
| Anthropic《为代理写工具》 | https://www.anthropic.com/engineering/writing-tools-for-agents | [02 §6.4](02-strategy.md) 工具面设计准则：合并工具、命名空间、返回格式、token 效率 | 仅见检索摘要【调研】 |
| Anthropic 桌面扩展（MCPB） | https://www.anthropic.com/engineering/desktop-extensions | E4-08、E11-10：`.mcpb` 打包与 Claude Desktop 一键安装 | 仅见检索摘要【调研】 |
| MCP 采用 MCPB 格式的博客 | https://blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb/ | E4-08：MCPB 作为便携本地服务器格式 | 仅见检索摘要【调研】 |
| ai-website-cloner-template | https://github.com/JCodesMore/ai-website-cloner-template | [01 §2.3](01-background.md) 同类方案：阶段、技术栈、保真度检查方式；星标数来自第三方目录，会浮动 | 读取原文（README）【调研】 |
| Perfect-Web-Clone | https://github.com/ericshang98/perfect-web-clone | [01 §2.3](01-background.md)：确定性 `pwc` 命令 + 代理写代码、门禁表、`ready_for_user_review` / `failed_with_residuals` 终态 | 读取原文（README）【调研】 |
| MockServer | https://www.mock-server.com/ | [01 §2.3](01-background.md)：录制 / 回放 / 按 OpenAPI 生成 mock；已提供 MCP | 仅见检索摘要【调研】 |
| Agent Skills 开放标准 | https://agentskills.io | [01 §2.1](01-background.md)：技能作为跨厂商开放标准、采用范围 | 二手：来自检索结果里的第三方文章，未直接读取该站点【调研·二手】 |
| 第三方文章若干（MCP Apps 的客户端支持、Agent Skills 采用数量、国内 IDE 对 MCP 的支持对比） | （多篇，不逐条列 URL） | [01 §2.1](01-background.md) 里「各来源统计口径不一」的表述；[02 §6.5](02-strategy.md) 把国内 IDE 放进 Tier-2 的依据 | 仅见检索摘要【调研·二手】 |
| Claude API 文档快照（随 Claude 工具链内置，缓存日期 2026-10-06） | 无公开 URL | [01 §2.2](01-background.md)、[09 §2.1](09-quality-metrics.md)：模型 ID、价格、上下文；Opus 5.5 的行为差异（思考始终开启、`effort` 默认 `medium`、移除采样参数与强制 `tool_choice`）、服务端降级、高分辨率视觉 | 读取原文【调研】 |

提示：凡是「仅见检索摘要」的行，落到具体字段名、版本号、价格之前，请先回到原文核对。

---

## 2. 仓库内参考

本 PRD 反复引用、且已核实存在的仓库文件。

### 2.1 文档

| 文件 | 用于哪里 |
| --- | --- |
| [RISKS.md](../../../RISKS.md) | 边界与红线、「诚实性清单」；[02](02-strategy.md) 的 NG2 / NG10，[09 §2.6](09-quality-metrics.md) 的 H1–H8 |
| [DEMO-SCRIPT.md](../../../DEMO-SCRIPT.md) | 现有演示脚本与问答预案；Q1 / Q3 / Q6 的改写见 [10 §2](10-roadmap-risks.md) |
| [PRD.md](../../../PRD.md) | 现有产品定义，含「完整业务替代」等级——后端克隆的上限口径 |
| [README.md](../../../README.md)、[ARCHITECTURE.md](../../../ARCHITECTURE.md)、[USAGE.md](../../../USAGE.md) | 现状能力、分层、`operation-plan` 语法与 `handoff` 用法 |
| [docs/ROADMAP.md](../../ROADMAP.md) | 现有路线图与仍待验证的事项 |
| [2026-10-22 仓库审查](../../audits/2026-10-22/README.md) | 成熟度打分、验收「指纹」陷阱（冻结的 10 个文件）、CI 现状、Node 口径、「主角不明」问题 |
| [项目验收工作台](../../competition/acceptance-workbench.md) | 验收 Mirror 模式的输入输出、三视口、门禁——正式裁判的现有实现 |
| [验收固定测试集](../../competition/acceptance-demo.md) | 注入式缺陷夹具的先例 |
| [docs/guide/README.md](../../guide/README.md) | 上手导览，新增 AI 接入指南时的落点 |
| [`ci.yml`](../../../.github/workflows/ci.yml)、[`seo-gate.yml`](../../../.github/workflows/seo-gate.yml) | 现有 CI 的四个 job 与手动触发的 SEO 门禁——[09 §5](09-quality-metrics.md) 的基线 |

### 2.2 代码与测试

| 文件 | 用于哪里 |
| --- | --- |
| [`core/src/mcp/server.mjs`](../../../core/src/mcp/server.mjs) | 现有 stdio MCP 服务器（13 个工具）——[01 §1.2](01-background.md) 的逐项对照对象 |
| [`core/test/mcp.test.mjs`](../../../core/test/mcp.test.mjs) | 钉死 13 个工具名的现有测试；旧工具兼容（E1-15） |
| [`core/src/cli.mjs`](../../../core/src/cli.mjs) | 现有 30 个子命令的命令表 |
| [`core/src/engine-server.mjs`](../../../core/src/engine-server.mjs) | HTTP 路由、任务 Map、全局槽、SSE、令牌校验 |
| [`core/src/handoff.mjs`](../../../core/src/handoff.mjs) | 自起临时引擎并核对数据根——MCP 服务器与 CLI 沿用的做法 |
| [`core/src/llm.mjs`](../../../core/src/llm.mjs) | 现有三协议文本 + 视觉客户端（无工具调用、无流式） |
| [`core/src/differ/diff.mjs`](../../../core/src/differ/diff.mjs)、[`shape.mjs`](../../../core/src/differ/shape.mjs)、[`style-probe.mjs`](../../../core/src/differ/style-probe.mjs)、[`fixup.mjs`](../../../core/src/differ/fixup.mjs) | 像素与形态原语、计算样式对照、「AI 提议、门禁裁决」的现成样板 |
| [`core/src/live/adapter-runtime.mjs`](../../../core/src/live/adapter-runtime.mjs)、[`har.mjs`](../../../core/src/live/har.mjs) | 运行时适配器协议、HAR 清洗规则——契约环的落点与输入 |
| [`core/src/paths.mjs`](../../../core/src/paths.mjs) | `isSecretFile`：秘密文件名单，E12-02 要扩展的对象 |
| [`core/test/fixtures/acceptance-site.mjs`](../../../core/test/fixtures/acceptance-site.mjs) | 带冻结 case 清单与 baseline / target 两侧的夹具——Bench 夹具的写法先例 |
| [`core/scripts/smoke-forge.mjs`](../../../core/scripts/smoke-forge.mjs)、[`test-core.mjs`](../../../core/scripts/test-core.mjs) | 随机端口 + 临时数据根的无外网冒烟；测试文件的选取与分片透传 |

### 2.3 本机实测

[01 §1.4](01-background.md) 的三个探针（产物体量、大纲压缩、第一方接口统计）是 2026-10-24 在本机工作区跑的一次性脚本，**未入库**；E14-06 要求把它们做成 `heimdall probe`，使数字可复现。

---

## 3. 术语表

| 中文 | English | 一句话定义 |
| --- | --- | --- |
| 彩虹桥 | Bifröst | AI 接入层的代号；产品名仍是 Heimdall |
| 能力注册表 | Capability Registry | 一个能力的唯一定义处；CLI、MCP、HTTP 与文档由它生成（[03 §2](03-architecture.md)） |
| 控制面 | Control Plane | 加在现有任务机制外的一层门面：排队、幂等、进度、取消、预算、令牌作用域、审计 |
| 外壳 | Surface | 对外的入口形态：CLI、MCP、HTTP v1、技能与插件包、控制台新视图 |
| 简报 | Brief | 给代理看的、按 token 预算压缩过的页面证据；分 `outline / sections / full` 三档 |
| 分段 | SectionPlan | 页面的稳定分段：段 ID、各视口边界框、DOM 锚点、依赖与共享候选 |
| 参考包 | ReferencePack | 页面的冻结参考：三视口截图、动态区域遮罩、DOM 快照引用；正式裁判的基线指向它 |
| 修复包 | FixPacket | 一次对比的修复线索：区域、`cause`、对应元素、属性差、裁剪图、建议顺序、趋势 |
| 候选 | Candidate | 代理产出的待验证对象：项目目录或可访问的 URL |
| 快速裁判 | Fast Compare | 循环内每次迭代用的秒级对比；指导修复，**不能宣布通过** |
| 正式裁判 | Formal Gate | 由验收 Mirror 模式执行、带完整证据的判定；**唯一**能宣布通过的来源 |
| 门禁 | Gate | 阈值 + 逐维判定 + 证据引用；等级 `bronze / silver / gold`；一次运行内配置冻结 |
| 保真旋钮 | Fidelity Dial | `faithful`（复用原 CSS，精确但不够地道）/ `balanced`（默认）/ `idiomatic`（用令牌与工具类重写，最慢） |
| 技术栈配置 | Stack Profile | 一套脚手架 + 约定 + 构建命令 + 度量入口，如 `html-css`、`vite-react-ts-tailwind` |
| 重建工作区 | Rebuild Workspace | `rebuild init` 生成的独立目录：脚手架、真实资产、简报、`AGENTS.md`、`heimdall.config.json`；人、代理、CI 之间的合同 |
| 重建环 / 行为环 / 契约环 | Rebuild / Behavior / Contract Loop | 三个「AI 提议 → Heimdall 度量 → 修复包 → 再改」的闭环：前端、交互逻辑、后端 |
| 收敛控制器 | Convergence Controller | 执行迭代上限、停滞、回退、振荡、预算规则，并给出终态 |
| 终态 | Terminal state | `passed`、`passed_with_residuals`、`failed_with_residuals`、`budget_exhausted`、`cancelled` |
| 地板是镜像 | Floor = Mirror | 重建没过门禁就交付镜像 + 报告 + 残差，结果不比今天更差 |
| 镜像 | Mirror（clone） | Heimdall 现有的克隆产物：静态镜像或交互镜像。**不要与下一条混淆** |
| 验收 Mirror 模式 | Acceptance Mirror mode | 验收工作台的一种模式：基线 URL 对目标 URL 做三视口对照。重建环用它当正式裁判的一部分（基线 = 镜像的正式基线副本，目标 = 重建项目的 dev server；整页视觉由评估器给出，见 [05 §1.5](05-frontend-rebuild.md)） |
| 出处 | Provenance | 生成条目的来源标注：`observed`（观察到）/ `inferred`（推断）/ `invented`（占位） |
| 旅程 | Journey | 人在可见浏览器里对自己有权的系统做的一次操作录制；行为环与契约环的信号来源；原始 HAR 为秘密级 |
| 行为规格 | BehaviorSpec | 组件状态机 + 流程 + 断言，每项带出处 |
| 契约草案 | ContractDraft | OpenAPI 3.1 + 观察统计 + 样例 + 未知清单；分级 B0 回放 / B1 契约 / B2 行为 mock / B3 服务脚手架 / B4 所有者协作 |
| 留出集 | Held-out set | 评测时不让代理看到的那部分请求（默认 20%），用来度量泛化而非记忆 |
| 围栏 | Fence | 给来自网页的不可信文本加的机器可识别边界（含每个响应不同的 nonce），防止被当作指令 |
| 飞行记录器 | Flight Recorder | `ledger.jsonl`：每次迭代的分数前后、保留 / 回退、token、花费、模型；也是回放的数据源 |
| 回放 | Replay | 把一次真实运行的事件时间线重放到「AI 活动」视图；必须显著标注为回放 |
| 缺陷注入集 | Defect Injection Set | 夹具的带真值的缺陷变体（位移、尺寸、颜色、字体、间距、图像缺失、溢出、内容缺失、行为），用来客观衡量修复包 |
| Heimdall-Bench | Heimdall-Bench | 评测集合：Suite F（离线夹具）、Suite O（自有站）、Suite P（公开站，仅内部）（[09 §1](09-quality-metrics.md)） |
| 消融臂 | Ablation arm | A0–A3：无 Heimdall / + 简报 / + 标量对比 / + 完整修复包。**与假设编号 A-1 ~ A-10（带连字符）是两套编号** |
| 北极星指标 | North Star | 已验证克隆率 / 美元：`N_pass ÷ Σ cost_usd`，单位页 / 美元（[09 §4.1](09-quality-metrics.md)） |
| Autopilot 引擎 | Autopilot engine | E0 外部代理驱动 / E1 Claude Agent SDK 封装 / E2 Heimdall 原生编排（[03 §6](03-architecture.md)） |
| 站点配方 | Site Recipe | `core/sites/<host>.json` 与 `workspace/<host>/site.json`：把站点特化挤进数据，换站不改代码 |
| 指纹冻结文件 | Fingerprint-frozen files | 验收系统盖「指纹」所依赖的 10 个源文件；动一个字节就会让新运行无法生成基线候选，本方案**不得修改** |
| 星图 | Atlas | 侦察产出的整站页面图谱（`recon/atlas.json`） |
| 内容寻址存储 | CAS | 资产按内容哈希存放并以硬链接去重；重建时 `public/assets` 的原件来源 |
| MRTR | Multi Round-Trip Requests | MCP 2026-07-28 的模式：服务器返回 `input_required`，客户端带 `inputResponses` 重试原请求，取代服务器主动发起的 elicitation |
| Tasks 扩展 | Tasks extension | MCP 的 `io.modelcontextprotocol/tasks` 扩展：长任务以任务句柄返回，客户端轮询 `tasks/get`；本方案用 `jobId` 轮询作为通用兜底 |
| MCP Apps | MCP Apps | MCP 的官方扩展：工具返回 `ui://` 资源，在会话里渲染交互界面 |
| MCPB | MCP Bundle | `.mcpb` 压缩包（`manifest.json` + 服务器），Claude Desktop 双击安装 |
| 技能 | Skill（Agent Skills） | 一个目录 + `SKILL.md`，按需加载的流程说明；跨厂商开放标准 |
| 插件 | Plugin（Claude Code） | 技能 + 子代理 + 钩子 + MCP 配置的打包单元，清单在 `.claude-plugin/plugin.json` |
| 无状态 MCP | Stateless MCP | 2026-07-28 起去掉 `initialize` 握手与 `Mcp-Session-Id`，每个请求自带协议版本与客户端能力 |

---

## 4. 使用须知

1. **访问日期**：外部资料的访问日期统一写 2026-10-24（调研当天）。
2. **标「仅见检索摘要」的行**（MCP Apps 公告、TS SDK v2 迁移说明、《为代理写工具》、桌面扩展、MCPB 博客、MockServer）：正文已引用的具体字段名、包名、版本号，开发前需逐条回原文核对。
3. **术语冲突**：「镜像」（克隆产物）与「验收 Mirror 模式」同名不同物，术语表已并列说明；首次出现时带上限定词。「消融臂 A0–A3」与「假设 A-1 ~ A-11」编号体系不同，同理；「Tier-1 / 2 / 3」（客户端层级）、「Tier S / M / L」（范围分层）、「B0–B4」（后端分级）也各自独立。
4. **价目缺项**：Claude API 快照没有列缓存写入价，[09 §2.4](09-quality-metrics.md) 的成本公式已标【待核对】。
