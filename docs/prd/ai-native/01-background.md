# 01 背景与证据

上一篇：[PRD 入口](README.md) · 下一篇：[02 战略](02-strategy.md)

本章回答三件事：Heimdall 现在对 AI 代理到底有多友好（§1）；为什么是现在、同类在做什么（§2）；这些合起来说明了什么（§3）。凡数字都带证据标记，口径见入口页。

---

## 1. 现状盘点

### 1.1 入口一览【读码】

| 入口 | 是什么 | 对 AI 代理的问题 |
| --- | --- | --- |
| 控制台（Vue 3） | 给人用：星图、页面清单、报告、验收工作台 | 代理用不了；但它能做「AI 活动」的现成画布（`Graph3D`、`ActivityRail`、`Sparkline` 已有） |
| CLI `core/src/cli.mjs` | 30 个子命令，每个 spawn 一个脚本 | 输出面向人；没有统一的 `--json`、`--wait`；退出码各脚本自定；`queue` 这类命令还要先有引擎在跑 |
| HTTP `engine-server.mjs` | 近 50 个路由模式（验收子系统在 `/api/acceptance/` 下另有一批子路由），SSE 事件流，`x-heimdall-token` 单一令牌 | 没有 OpenAPI；13 个「同时只能跑一个」的全局槽，占用时回 `409 busy`；各路由返回结构不一 |
| MCP `core/src/mcp/server.mjs` | 零依赖 stdio JSON-RPC，13 个工具 | 见 §1.2 |
| 浏览器书签 `core/src/browser/bookmarklet.mjs` | 在任意页面一键把 URL 送进 Heimdall | 为拿不到 `taskId` 而设计（`no-cors`），适合人，不适合代理 |
| Skill / 插件包 / `AGENTS.md` | **没有** | 代理不知道「怎么用才对」，每次靠用户口述流程 |

### 1.2 MCP 现状逐项对照【读码】

| 方面 | 现在 | 对代理的后果 |
| --- | --- | --- |
| 协议版本 | 默认回 `2025-03-26`，靠 `initialize` 握手 | 2026-07-28 版规范已**去掉握手和会话**（见 §2.1），需要升级而不是修补 |
| 能力声明 | 只有 `tools` | 没有 `resources`、`prompts`：代理读不到任何产物，也没有现成的「斜杠命令」 |
| 返回值 | 全是 `JSON.stringify` 后的文本 | 没有 `outputSchema`、没有结构化结果、没有图片内容；代理要自己解析文本 |
| 工具注解 | 没有 | 客户端无法区分只读 / 破坏性 / 会联网的工具，只能一律弹确认 |
| 长任务 | `recon`、`forge`、`audit`、`watch`、`assets` 只回 `taskId` | 没有「查状态、等结束、取消、看事件」的工具；`heimdall_jobs` 只列清单 |
| CLI 驱动的工具 | `verify`、`tokens`、`components`、`matrix`、`live_export`、`dedupe` 走 `runCli`，10 分钟超时，只回**最后 4000 字符** | 全站验证的结果被截断成日志尾巴，拿不到结构化数字 |
| 读结果 | **没有任何工具能读** `score.json`、`verify.json`、截图、差异图 | 本地代理还能直接读 `core/workspace/`；桌面 / 远程代理完全不行 |
| 并发 | 引擎里 13 个全局槽（`runningRecon`、`runningVerify` …） | 两个代理同时发起同类任务，后者直接 409；没有排队 |
| 鉴权 | 单一共享令牌 | 无作用域：能读就能写，能克隆就能删（`DELETE /api/sites/*`） |
| 测试 | `core/test/mcp.test.mjs` 钉死 13 个工具名 | 好事：升级时有回归网；也意味着旧工具名要保留一个版本 |

一句话：**今天的 MCP 是「遥控器」，不是「工作台」**——代理能按下按钮，但看不见结果，也没法判断做得对不对。

### 1.3 CLI、HTTP、LLM【读码】

- **CLI**：`handoff <url>` 已经是一条命令走完「侦察 → 克隆 → 验证 → 资产 → 交付」，并自起临时引擎、写交接说明，说明「一键」的路径是通的；缺的是机器可读的输出和统一的等待语义。
- **HTTP**：任务模型是「内存里的 `tasks` Map + SQLite `jobs.db`（保留 500 条）+ 子进程 stdout 里的 `@@EVENT@@` 行 → SSE」。这套机制稳，可以复用，不需要重写；新增的是外面一层门面（排队、幂等、预算、作用域）。
- **秘密边界**：`isSecretFile` 已经拦住 `session*.json`、`network.har`（原始抓包）、`operation-plan/discovery/review.json`，不通过静态通道外发。这是 AI 接入时必须**继承**的边界（见 [08](08-security-governance.md)）。
- **镜像预览服务会拦掉 Web 字体**【实测，Ph0】：
  - **机制**：`clone-preview-server` 给 HTML 加 `Content-Security-Policy: sandbox`，不含 `allow-same-origin`，页面成了不透明源，字体请求按跨源被拦。用到它的有 `verify/verify.mjs`、`crawler/shot_clone.mjs`、`differ/fixup.mjs`。
  - **实测**：thordata.com 首页在它下面只加载得到 `iconfont`，IBM Plex Sans 与 Geist Mono 全部失败，文字退回 Microsoft YaHei；换成不加 sandbox 的回环服务则全部加载。
  - **影响**：在用 Web 字体的站上，克隆侧截图用的是回退字体，与原站对比会低估还原度。
  - **处理**：这是现有代码的问题，不在本 PRD 范围内，单独修（[10 §4](10-roadmap-risks.md) R18）；本 PRD 的正式基线不经它供给（[05 §1.5](05-frontend-rebuild.md)）。
- **LLM 客户端** `llm.mjs`：三种协议（`chat`、`responses`、`anthropic`），文本 + 图片，默认模型是 GLM / DeepSeek 一类；**没有工具调用、没有流式**。AI 现在用在三处：像素差异后的 CSS 校准（`differ/fixup.mjs`）、语义情报抽取（`harvest/harvest.mjs`，页型判断是它输出的一部分）、验收结果的解读（`acceptance/triage.mjs`，按需）。注意：现有文档（README、DEMO-SCRIPT Q3）说的「页面分类用 AI」与代码有出入——`crawler/classify.mjs` 本身是纯正则加 DOM 特征，不调用模型。
- **`fixup` 是现成的样板**：看图 → 出 CSS 补丁 → 重测 → 变好才保留、变差就回滚，补丁还有硬规则（花括号配平、最多 6 条规则、禁 `body`/`html`/`*`）。「AI 提议、门禁裁决」不是新发明，是把这个模式从「一页一个补丁」推广到「整个重建」。

### 1.4 本机实测（方法与结果）

三个一次性探针，在 2026-10-24 对本机 `core/workspace/` 里已有的克隆产物跑出来。**探针脚本没有入库**；E14-06 要求把它们做成 `heimdall probe` 子命令（[04](04-requirements.md)），这样数字可以复现。方法写在每张表下面。

**(a) 产物体量**【实测】——「直接把产物喂给模型」行不行？

| 指标（415 个有 `dom.html` 的页面） | 中位数 | p90 | 最大 |
| --- | --- | --- | --- |
| `dom.html`（渲染后 DOM） | 600 KB | 1.59 MB | 7.28 MB |
| `cssom.css`（CSSOM 序列化） | 350 KB | 832 KB | 4.81 MB |
| `network.har`（414 页有） | 12.5 MB | 22.4 MB | 93.6 MB |
| `clone/assets/` 文件数 | 58 | 约 210 | 1,436 |
| DOM + CSS 折合 token（字节 ÷ 3.5 粗估） | ≈ 29 万 | ≈ 64 万 | ≈ 238 万 |

方法：遍历 `core/workspace/*/pages/*/`，只读文件大小，不读内容。折算系数是粗估，真实分词器会有出入，量级不会变。
**结论**：中位页的 DOM + CSS 就要约 29 万 token，p90 接近 1M 上下文的三分之二，最大值装不进。即使装得进，Opus 5.5 每次读一遍约 1.2 美元（29 万 × $4/百万），闭环要读几十遍。**必须有简报（Brief），不能让模型自己去啃原始文件。**

**(b) 结构大纲的压缩比**【实测】——简报能有多小？

做了一个 60 行的原型：用现有依赖 `parse5` 解析 `dom.html`，只保留标签、`id`、前两个类名、`role`、少量属性（`href`/`src`/`alt`/`aria-label` 等，截断）、直接文本前 60 字符；跳过 `script`/`style`/`noscript`/`template`/`link`/`meta`；`svg` 记为 `[svg]`；折叠连续相同的兄弟节点为「… ×N」；深度上限 14。

| 页面 | `dom.html` | 大纲 | 约合 token | 压缩比 |
| --- | --- | --- | --- | --- |
| apify.com `about` | 0.55 MB | 13.7 KB | 4 千 | 40× |
| apify.com `enterprise` | 0.52 MB | 13.9 KB | 4 千 | 37× |
| apify.com `api` | 0.51 MB | 16.1 KB | 5 千 | 32× |
| vitest.dev 首页 | 0.05 MB | 7.3 KB | 2 千 | 7× |
| thordata.com 首页 | 2.05 MB | 34.7 KB | 1 万 | 59× |
| thordata.com 住宅代理产品页 | 2.10 MB | 33.2 KB | 9 千 | 63× |
| tailwindcss.com `blog` | 2.08 MB | 51.2 KB | 1.5 万 | 41× |

**结论**：不带位置和样式的纯结构大纲，在 7–61 倍之间，常见营销页只要 2–15 千 token。加上分段边界框、设计令牌和每段的样式摘要后会变大（预算在 [05 §2](05-frontend-rebuild.md) 定），但**一页简报压进 1–2 万 token 是现实的**【假设，A-2】。（`vercel.com/connect` 压缩比 806 倍，是页面主体为内联载荷的离群值，不计入。）

**(c) 被动抓包里有多少后端信号**【实测】——能不能只靠「克隆页面」来克隆后端？

做法：读 `network.har`，取响应 MIME 含 `json` / `graphql` 的条目；**排除** URL 带 `?_rsc=` 的 Next.js 预取；只算与站点同注册域（主机名最后两段）的第一方端点；按（方法、主机、路径模板）去重。

| 站点页面 | 第一方 JSON 端点（去预取后） | 是什么 |
| --- | --- | --- |
| apify.com `about` | 3 | 埋点配置、状态页、埋点上报 |
| thordata.com 首页 | 1 | 构建元数据 |
| linear.app `customers` | 4 | 特性开关、状态页、草稿模式状态、搜索索引 |
| supabase.com 首页 | 3（另有 38 条 `_rsc` 预取被排除） | 配置中心、特性开关、问卷 |
| stripe.com `contact-sales` | 3 | cookie 同意相关、通知 |
| tailwindcss.com `blog` | 0 | — |
| ant.design 首页 | 2 | 版本清单、推测加载规则 |

**结论**：被动抓取页面，第一方 JSON 端点每页 0–4 个，**全是埋点、开关、状态、配置，没有业务数据读写**。这是营销 / 文档站的常态，不是个别现象。所以：
1. 单靠「克隆页面」不会产生后端信号；要克隆后端行为，必须让信号来自**被执行过的旅程**（搜索、筛选、翻页、提交表单、登录后的操作），而旅程要由有权的人来跑（[06 §1](06-logic-backend.md)）。
2. 后端克隆的产物必须诚实标出「只覆盖被观察到的部分」。

### 1.5 已有、但还没被「AI 化」的资产【读码】

这些是 Bifröst 能快速成型的原因——裁判和证据大半已经在仓库里，缺的是把它们组织成代理能用的形状。

| 资产 | 位置 | 在 AI 闭环里的角色 |
| --- | --- | --- |
| 验收 Mirror：基线 URL 对目标 URL，三视口，click / fill / press 步骤，可见 / 文本 / 属性 / URL 断言，证据与门禁 | `core/src/acceptance/`、`POST /api/acceptance/runs` | **正式裁判**：重建项目 = 目标，镜像 = 基线。限制：8 路由、24 验收点；同引擎一次一个 |
| 多视口验证与交互回放 | `core/src/verify/` | 全站复验、断点续跑、有界置信度 |
| 差异形态分析（集中 vs 弥散） | `core/src/differ/shape.mjs` | 修复包里的「该先修哪块」排序依据 |
| 计算样式逐元素对照 | `core/src/differ/style-probe.mjs` | 修复包的「属性差值」来源；**只在 DOM 结构相同时可按路径配对**，重建后的 DOM 不同，需要新的对应算法（[05 §3](05-frontend-rebuild.md)） |
| 操作发现与计划 | `crawler/discover-operations.mjs`、`operation-plan.json` | 行为环的候选来源与回放语言（`navigate/click/fill/scroll/useSession` + `visible/hidden/text-includes/url`） |
| 运行时适配器协议 | `live/adapter-runtime.mjs` | 契约环 B2 的落点：`runtime-adapter/index.mjs` + `manifest.json`，≤ 200 条路由，可带命名会话；数据目录必须在包外 |
| 严格离线门禁 | `live/export.mjs --strict`、`--compare-source`、`read-data-plan.json` | 后端行为验证的现成裁判（断外联加载、源站只读对照） |
| HAR 清洗规则 | `live/har.mjs` | 「给 AI 看的 HAR」必须经过它：私有路径、键名、头、正文扫描 |
| 设计令牌与组件抽取 | `extract/tokens.mjs`、`extract/components.mjs` | 简报里的令牌区；组件候选（按类名启发，粗） |
| 动效档案 | `crawler/motion*.mjs` → `motion.json` | 简报里的动效清单；重建后的「动效是否保留」对照 |
| 站点配方 | `core/sites/*.json`、`workspace/<host>/site.json` | 代理可以提议配方补丁（赛后：自愈） |
| 交接说明 | `handoff-report.mjs` | 「人话摘要 + 下一步」的写法样板 |

---

## 2. 时机与同类方案

### 2.1 协议与分发在 2026 年已经成熟【调研】

| 事物 | 现状 | 对我们意味着什么 |
| --- | --- | --- |
| **MCP 2026-07-28** | 无状态：去掉 `initialize` 与 `Mcp-Session-Id`；请求在 `_meta` 里带协议版本与客户端能力；新增 `server/discover`；长任务走 Tasks 扩展（`io.modelcontextprotocol/tasks`，轮询 `tasks/get`）；服务器需要用户输入时返回 `input_required`（MRTR）；列表结果带 `ttlMs` / `cacheScope`；HTTP 请求带 `Mcp-Method` / `Mcp-Name` 头；Roots、Sampling、Logging 进入弃用；客户端注册从 DCR 转向 Client ID Metadata Documents | 现在这个手写的 2025-03-26 服务要**升级而不是修补**。官方 TypeScript SDK v2（`@modelcontextprotocol/server` 2.x，`createMcpHandler`）已支持；其 Tasks 扩展仍有缺口，所以必须同时保留「返回 `jobId` 让代理轮询」这条所有客户端都能用的路 |
| **MCP Apps** | 2026-01 成为首个官方扩展：工具返回 `ui://` 资源，在会话里渲染交互界面；Claude、ChatGPT、VS Code、Goose 已支持 | 星图、前后对比滑块可以直接出现在聊天里（赛后做，见 [04 E2-14](04-requirements.md)） |
| **Agent Skills** | Anthropic 2025-12 发布的开放标准：一个目录 + `SKILL.md`，按需加载；被 Claude Code、Codex、Cursor、Gemini CLI 等采用（各来源统计从 26 到 40 余个工具不等）；安装路径各家不同（`.claude/skills/` 与 `.agents/skills/`） | 「闭环怎么做」写成技能，而不是每次让用户贴长提示；分发要覆盖两套路径 |
| **Claude Code 插件与市场** | 插件 = 技能 + 子代理 + 钩子 + MCP 配置 + 命令，清单在 `.claude-plugin/plugin.json`；市场 = git 仓库里的 `.claude-plugin/marketplace.json`；`/plugin marketplace add` 后 `/plugin install` | 一条命令装好技能 + MCP；**私有仓库就能当内部市场**，不依赖公开发布 |
| **MCPB** | `.mcpb` 压缩包（`manifest.json` + 服务器），Claude Desktop 双击安装 | 面向非技术用户的「傻瓜式」分发形态 |
| **Claude Agent SDK** | 把 Claude Code 当库用（Python / TypeScript）：内置读写 / 命令 / 搜索工具，支持 MCP、权限、子代理、钩子、加载插件与技能 | Autopilot 引擎 E1 的现成底座。注意：官方明确**不允许第三方产品提供 claude.ai 登录**，只能用 API Key |

### 2.2 前沿模型的能力与价格【调研】

来源是随 Claude 工具链内置的 API 文档快照（2026-10-06）。

| 模型 | 上下文 / 输出 | 价格（每百万 token，输入 / 输出） | 用途建议 |
| --- | --- | --- | --- |
| Claude Opus 5.5 `claude-opus-5-5` | 1M / 128K | $4 / $20（缓存读 $0.20） | 重建的主力，Gold 档 |
| Claude Sonnet 5.5 `claude-sonnet-5-5` | 1M / 128K | $2 / $10 | 默认档、行为与契约推断 |
| Claude Haiku 5.5 `claude-haiku-5-5` | 1M | $0.10 / $0.50（≤100K 提示） | 分类、摘要、批量标注 |
| Claude Fable 5.1 `claude-fable-5-1` | 1M / 128K | $10 / $50 | 极难的收敛卡点，按需升级 |

对本方案有用的几点：
- **视觉**：自 Opus 4.7 起支持长边最高 2576 px 的高分辨率输入，之后的 Opus 沿用——足够看清 1440 宽截图的字重、间距、圆角。
- **思考**：Opus 5.5 思考始终开启（自适应），不能关；`effort` 默认 `medium`，**写代码类任务要显式设 `high` 或 `xhigh`**；不再支持强制 `tool_choice`、采样参数和 `budget_tokens`。
- **长程代理能力**：任务预算（`task_budget`）、自动压缩、工具搜索（`defer_loading`）、程序化工具调用——后两者让「工具多一点」的代价变小。
- **拒绝与降级**：安全分类器可能返回 `refusal`；官方建议默认带上服务端 `fallbacks`。逆向类措辞（抓包、接口分析）有被误判的可能，Autopilot 要处理它（[04 E10-05](04-requirements.md)）。
- **成本量级**：每页几美元（估算见 [05 §6](05-frontend-rebuild.md)），所以「整站重建」是个要预算管理的操作，不是随手一点。

### 2.3 同类方案【调研】

| 方案 | 做法 | 长处 | 与 Heimdall 的差距 |
| --- | --- | --- | --- |
| `ai-website-cloner-template`（Claude Code 技能，第三方目录统计 3 万余星） | 代理用浏览器检查站点，抽取资产与设计令牌，为每个部分写规格，并行的「构建代理」在 git worktree 里写 Next.js + Tailwind，最后对照截图 | 开箱即用，社区大；输出是现代技术栈 | 保真度靠代理目测，没有统一度量；技术栈固定；只有单站点研究目录，没有整站图谱与离线门禁 |
| `Perfect-Web-Clone`（`pwc` 命令 + 技能，MIT） | **确定性工具**做提取 / 规划 / 组装 / 构建 / 评分，**代理**写 React 并修复得分最差的分段；以门禁表而非提示词定义「像素级」；失败也是合法终态 | 思路与我们一致，证明这条路被社区认可 | 单页、Vite + React 固定；没有整站、多视口、交互与断网门禁，也没有 HAR 与后端契约 |
| 通用浏览器 MCP（Playwright MCP、Chrome DevTools MCP） | 给代理一个可操作的浏览器 | 通用，本机已装 | 只有「眼睛」：快照、截图。没有真值落盘，没有度量，没有裁判 |
| 整站拷贝工具（HTTrack、SingleFile 一类） | 抓文件 | 简单 | 不处理渲染态、CSSOM、多视口；不度量；不面向代理 |
| 接口录制与 mock（MockServer、WireMock、MSW、Mockoon 等） | 录制 / 回放 / 按 OpenAPI 生成 mock | 成熟；MockServer 已提供 MCP | 与页面脱钩：不验证「前端 + 接口」整体；不产出行为规格 |
| **Heimdall + Bifröst** | 确定性取证与度量 + 前沿模型建造 + 闭环 + 镜像兜底 | 原件资产、整站图谱、三视口度量、交互与断网门禁、HAR 证据、可枚举的缺口 | 要做的就是本 PRD |

**空位**：没有人把「测量与裁判」当成产品卖给 AI 代理。别人解决「模型怎么写」，我们解决「模型怎么知道自己写得对不对」。

---

## 3. 核心洞察

1. **模型会写，但看不准。** 给它一张截图，它能写出「像」的页面；但「像」不是数。没有真值（原站渲染态、原件资产）、没有尺子（三视口度量），它就无从修正，只能凭印象反复猜。
2. **Heimdall 恰好有真值和尺子，而且是确定性的。** 同一输入同一输出，可复现、可 diff。这正是代理循环最缺的东西：把「视觉差异」翻译成「编译器报错」——哪个区域、什么原因、对应哪个元素、哪个属性差多少、一张裁剪对比图。
3. **所以分工自然成立**：确定性的部分（取证、度量、判定）留给 Heimdall，创造性的部分（写组件、补逻辑、造后端）交给模型，闭环由门禁收敛。这与项目已有的原则一致（[DEMO-SCRIPT](../../../DEMO-SCRIPT.md) Q3：「核心的搬运不用 AI，AI 用在判断上」），只是把「判断」从三个点位扩展到「建造 + 判断」，并且**每一步都有裁判**。
4. **它同时解决两个叙事问题**。2026-10-22 的审查指出：验收子系统占核心源码 32%，演示稿里却一个字没提；评委看到的故事（克隆网站）和投入最多的东西（验收）是两回事。在新叙事里，验收的 Mirror 模式正是重建环的**正式裁判**——它从「附录」变成「主线的第二主角」。另外 Q6（为什么不用 `ai-website-cloner-template`）的回答也升级了：我们不再只说「别人全重建不可量化」，而是「我们也重建，但每一步有真值、有门禁、有兜底」（演示问答的改写见 [10 §2](10-roadmap-risks.md)）。
5. **风险也在这里**：「AI 建造」把不确定性引了进来。对策写在设计原则里——AI 提议、确定性门禁裁决；地板是镜像；每个生成物标出处；预算兜底（[02 §3](02-strategy.md)）。
