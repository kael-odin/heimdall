# 2026-11-04 · Heimdall 全项目现状审查

> 大白话结论：Heimdall 已经不是玩具，也不是“任意网站一键复制”的成熟商业产品。它现在最适合做的是：**本机、人工授权、可留证据的网页克隆 / 重建 / QA / SEO / 回归门禁工作台**。能认真试用，能内部演示，能接 CI；还不能承诺任意站点、任意登录业务都开箱可用。

## 这次看了什么

- 代码与测试：能力注册表、MCP、QA、QA CI、GitHub Action、启动脚本、现有测试和工作流。
- 文档与路线：`STATUS`、`ROADMAP`、AI 接入、测试工作区、演示脚本和公开案例。
- 本机真实安装：Codex App、Claude Desktop、Claude Code 插件。
- 真实外部案例：Xspark 公开官网 5 页 QA 与 SEO 证据，以及 Xspark 工作区现有测试沉淀。
- 本机门禁：`pnpm check`，包括核心快速集、真浏览器、控制台、MCP、D7、依赖审计。

## 先说最值得肯定的事

1. **确定性比“让 AI 看着像”强。** 克隆、截图、资源、修复包、门禁和证据链是代码在算，模型只负责解释或写重建代码。
2. **失败边界写得比多数项目诚实。** 未测页面、资源缺口、环境问题、`pass-candidate` 和正式通过区分得比较清楚。
3. **不是只有一个界面。** 同一批能力已经能从 CLI、MCP、HTTP 和 GitHub Action 进入。
4. **有真实外站证据。** Xspark 公开案例证明它能在授权生产官网上留下可复核 QA / SEO 结果，而不只是本地夹具。
5. **本机集成确实通了。** Codex App、Claude Desktop、Claude Code 插件都能看到 15 个工具；Claude Code 插件版本为 `0.2.2`。

## 本轮审查发现并已修掉

| 级别 | 问题 | 为什么重要 | 处理 |
| --- | --- | --- | --- |
| P1 | 复合 Action 把 `github.action_path` 误当仓库根目录 | 远程用户一调用就找不到 `core/`，发布出去等于坏件 | 改为从 Action 目录回退两级；加入 Hosted 自测 |
| P1 | Action 自测在安装依赖前启动依赖 `pngjs` 的夹具 | 干净 CI 会因缺依赖起不来，本地有 `node_modules` 反而误绿 | 改为零依赖本地夹具 |
| P1 | `checks` 文档说工作区相对路径，实际按调用仓库根目录解析 | 用户在工作区子目录放检查文件会读错 | Action 内显式拼到 `QA_WORKSPACE` |
| P1 | `qa-ci.json/md` 写失败时仍声称文件已生成 | 违背“证据必须真实存在” | 返回 `files:null`、`sidecarError` 和 warning |
| P1 | 网页标题可能把 `@用户`、Markdown 链接或 HTML 注入 PR 评论 | 网页是不可信数据，不能污染 CI | 表格文本统一转义并加回归测试 |
| P1 | 源码 MCP 报 `2.0.0-dev`，插件报 `0.2.2` | 同一服务两个版本号，排障时容易误判 | 统一使用 MCP 包版本 `0.2.2` |
| P2 | fork PR 没有评论权限时，附带的 PR 评论步骤可能把 QA 门禁拖红 | 评论失败不应改写 QA 结论 | 降级为 warning，artifact 和门禁结果保留 |
| P2 | `clone-heimdall.cmd` 重复双击会重复拉起进程 | 第二次打开可能命中旧服务或制造混乱 | 先探测已有引擎/控制台，只补启动缺的那一个 |
| P2 | D6 里 Chromium 偶发把已收到的完整响应事后标成 `ERR_ABORTED` | 测试会把真实完成的动作误判成传输失败 | 用 Relay 完整字节、CDP 响应和下游 `finish` 三层证据精确对账，未对账的失败仍阻断 |
| P2 | D7 的 Playwright 截图在 Hosted 高负载下卡在 `fonts to load` | 控制台已经不用下载字体，却可能让真浏览器演示假红 | 改用同源 Chromium CDP 视口截图，并显式确认页面没有 `@font-face` |

## Hosted CI 回归和最终结果

本轮不是“本地绿了就直接交付”。首次推送后，Hosted CI 连续暴露了三层问题：

1. `41864671787`：D6 case D 的 deny 响应实际完整返回，但 Playwright 延迟读取响应体时报 `navigated away`。
2. `41871552620`：响应体对账已通过，独立 verifier 又因为 Playwright 把同一请求事后标成 `ERR_ABORTED` 而拒绝。
3. `41876697791`：D6 本体和 verifier 都已通过；后续 D7 在 Hosted 高负载下等待字体加载 90 秒后截图超时。

最终处理原则都是保留原始异常，再做可核验的补充证据，而不是直接放宽容错：

- D6 保留 `browserBodyReadFailure` 和 Playwright `ERR_ABORTED`，只有在方法、路径、状态码、完整响应字节、SHA-256、CDP 响应和 Relay 下游 `writableFinished` 全部一致时才认定传输完成。
- D7 确认控制台 `fontFaceCount = 0`，仍由真实 Chromium 截取当前视口；截图记录现在明确写出 `cdp-page-capture-screenshot`、字体状态和 1440x1000 / 390x844 实际尺寸。

最终 Hosted 结果：

- 提交：`5560de7c7f171499e8098be848d9231bbfa2de42`
- CI：[`41883522164`](https://github.com/kael-odin/heimdall/actions/runs/41883522164)
- 结果：8 个 job 全部成功，包括 lint/docs/docker、两片全量测试、MCP、依赖审计、QA Action 自测和完整真浏览器 e2e smoke。

## 仍然需要正视的问题

### P1：安装体验还没有统一

当前三种客户端不是同一种形态：

- Codex App / Claude Desktop：完整 MCP，直接指向工作树 `packages/mcp/bin/heimdall-mcp.mjs`。
- Claude Code：版本化插件代理，依赖本机 `:8900` 引擎。

这会导致三个后果：

- 仓库挪目录、清理工作树或换分支时，Codex / Claude Desktop 的配置可能失效。
- 同一个问题，在不同客户端里的“是否需要先启动引擎”不完全一样。
- 插件虽然版本化了，但还没有一个统一安装器同时管理引擎、控制台、MCP、浏览器和配置。

**改进方向：** 做正式 release 和 `heimdall setup/doctor --fix`，把“装依赖、装 Chromium、构建、写客户端配置、起服务、自测”收进一条命令。

### P1：真实项目泛化证据仍然少

固定夹具很强，Xspark 公开案例也很有价值，但目前主要是：

- 无登录公开页面
- 声明过的 5 个页面和 2 个视口
- 只读 QA 与 SEO

还没有足够的授权数据证明：登录后仪表板、多角色权限、长流程、动态表格、下单/支付、强风控站点都能稳定工作。

**改进方向：** 选 3 个获授权项目做同一口径复测，其中至少 1 个必须登录、至少 1 个必须跨版本回归、至少 1 个必须包含已知真实 BUG。

### P2：工具面开始变宽

当前 MCP 已有 15 个工具，而产品原则原来写的是“少而精、MVP 8 个”。QA 拆成 status / run / findings / ci 是合理的，但继续增加独立工具会挤压模型上下文，也让提示词和权限更难维护。

**改进方向：** 暂停无门槛加工具；新增前先回答“能不能并入既有工具”。支持工具搜索的客户端优先，工具说明保持任务导向。

### P2：验收子系统太重，当前不该继续扩张

D1–D7、Browser 来源归属、候选、缺陷单、永久拒绝等内容很严谨，但维护面也很大。对当前主线“AI 重建 + 确定性裁决 + QA CI”来说，它更像高价值但昂贵的底盘，而不是继续加功能的理由。

**改进方向：** 冻结验收子系统的新能力，只修真实缺陷和安全问题；把资源转到外部真实项目、安装体验和 QA CI 的稳定性。

### P2：Action 示例仍跟 `main`

示例使用 `kael-odin/heimdall/actions/qa-ci@main`，方便但不适合作为长期生产依赖。`main` 变了，别人 CI 的行为也会跟着变。

**改进方向：** 发布不可变 tag / release，并在文档示例中优先给版本 tag；高安全项目再鼓励锁到完整 commit SHA。

### P2：一个既有 verify 子进程测试有本机时序抖动

连续跑全量时，`verify --resume 遇到视口集合变化时重跑` 有一次触发了测试脚本自身的 20 秒子进程超时；同一用例单独复跑约 1.25 秒通过，随后整套全量约 0.97 秒通过，产品命令没有复现失败。

这不是“测试全绿所以没问题”，而是 Windows 高负载下的测试稳定性风险。后续应记录出现频率，必要时只调整该测试的子进程等待预算或清理 Chromium 启动残留，不能降低验收入口本身的通过标准。

## 本机 AI 接入的真实答案

| 客户端 | 当前状态 | 工具数 | 真实边界 |
| --- | --- | --- | --- |
| Codex App | 已配置完整 MCP | 15 | 读类、QA、SEO 可直接用；克隆任务可自起临时引擎，但稳定演示建议先开 `:8900` |
| Claude Desktop | 已配置完整 MCP | 15 | 同上 |
| Claude Code | 插件 `0.2.2` 已安装 | 15 | 轻量代理依赖 `:8900`；引擎没开时通常只有 `doctor/overview` 能给离线提示 |

所以：

- **只想看完整界面：** 双击 `clone-heimdall.cmd`。
- **只想让 AI 调用：** 可以不打开 `:5173`，但建议保留 `:8900` 引擎。
- **MCP 已安装 ≠ 完全不用本地服务。** 这个误解必须从文档和演示里拿掉。

详细步骤见 [09 · 小白一站式演示](../../guide/09-beginner-demo.md)。

## Heimdall 还能为 Xspark 做什么

已有的真实样本在 [Xspark 公开 QA 案例](../../cases/xspark/2026-11-04/README.md)：5 个公开页面、2 个视口、QA CI 和 5 页 SEO 审计。它证明的是公开官网只读巡检，不是后台业务验收。

| 能做的事 | 适配度 | 现在有什么 | 下一步 |
| --- | --- | --- | --- |
| 官网定时只读巡检 | 高 | 5 页、2 视口、CI 门禁、SEO 报告 | 把 `qa ci` 接到发布后或每周定时任务 |
| 发版前视觉回归 | 高 | 已支持 QA baseline 和截图比对 | 为测试环境建立稳定基线，按版本保存运行 |
| 仪表板/后台登录后回归 | 高，但需授权 | 支持 `storageState` 登录档与只读写阻断 | 使用测试账号，先测 5–10 个高价值页面，不碰写操作 |
| 前后端改版验收 | 中高 | 有 Mirror / Regression 和跨运行复验 | 需要稳定旧版 URL、新版 URL、固定测试计划 |
| SEO 竞品对标 | 中 | 支持 2–6 站点矩阵 | 先只选获授权公开页面，避免把第三方数据当可分发资产 |
| 官网改版底稿/竞品复刻 | 中 | 有 clone、brief、compare | 仅用于授权设计和重建，不替代正式资产授权 |
| API / DB / 权限 / 支付 / 回调漏洞 | 低 | Heimdall 只做浏览器与证据，不做后端全量审计 | 继续交给 Xspark 现有 API、DB、安全测试工具 |

最建议先做的一条：**把 Xspark 测试环境做成一份正式的 `.heimdall/qa.json`，覆盖官网 5 页 + 登录后 5–10 个只读高价值页面，固定 1440/390 两个视口，生成基线并接发布后 QA CI。**

这条线的价值不是“发现所有问题”，而是每次发版都能稳定回答：

- 哪些声明页面打不开
- 有没有新的控制台错误、坏图、坏链、布局溢出
- 和上一版相比哪里发生了视觉回退
- 哪些页面或登录态这次根本没测到

## 后续道路

### 最推荐的定位

**“AI 代理使用的本机网页验收工作台”**：

- AI 负责写、改、解释
- Heimdall 负责取证、量差异、跑 QA、保存证据、给门禁
- 人决定授权范围、登录和最终验收

这个定位与现有代码最一致，也最容易形成真价值。

### 未来 30 天

1. 用 Xspark 测试环境做首个“公开页 + 登录后只读页”的稳定试点。
2. 发布一个稳定版本号，把 Codex / Claude Desktop / Claude Code 从“工作树路径”切到版本化安装。
3. 把 `clone-heimdall.cmd` 和 `heimdall doctor --fix` 做成真正的一键体检。
4. 给 QA CI 增加真实项目的一个发布后自动任务。

### 未来 90 天

1. 收集 3 个授权项目的误报率、漏报率、运行时长和失败分类。
2. 对 QA 工具做合并或搜索化，控制上下文成本。
3. 把“环境失败 / 登录过期 / 检查点写错 / 产品 BUG”继续强行分层。
4. 只在这三件事有数据后再谈团队远程服务、多租户或商业化。

### 暂时不要做

- 不要先做“大而全 SaaS”。
- 不要继续无限增加检测器和 MCP 工具。
- 不要把固定夹具 21/21、18/18 外推成任意真实站点的成功率。
- 不要让 Heimdall 假装替代 API、数据库、权限和支付安全测试。

## 本机验证

本轮本地门禁结果：

```text
core fast: 1,197 / 1,197 passed
MCP: 3 / 3 passed
lint: 711 files OK
Markdown links: 698 targets / 140 files OK
D6 real browser decisions: 4 / 4 cases, 13 / 13 required checks, independent verifier passed
D7 real browser acceptance: accepted:true, 17 screenshots, fontFaceCount 0, ordinary console errors 0
dependency audit: no known vulnerabilities
Windows launcher: started :8900 + :5173, route check 34 / 34, second run reused both
```

Hosted CI 已在精确提交 `5560de7c` 上确认全绿；本地与远端证据一致。
