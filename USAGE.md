# Heimdall 使用指南

本指南说明当前控制台与命令行的操作。旧版逐日说明已移至
[历史使用手册](docs/archive/USAGE-through-2026-10-13.md)，其中的示例分数与页面数量不能当成当前验收结果。

## 准备与启动

前提只有两个：Node.js 22.13+，以及可用的 pnpm 11.28.10。
如果系统自带的 Corepack 无法验签，先升级 Corepack 或运行
`npm install -g pnpm@11.28.10`。

Windows 小白路径：双击根目录 `clone-heimdall.cmd`。第一次运行会自动：

1. 检查 Node / pnpm；
2. 只安装缺失的 `core`、`console`、`packages/mcp` 依赖；
3. 缺 Chromium 时安装 Playwright Chromium；
4. 控制台源码有变化时重新构建；
5. 缺失时构建自包含 MCP 插件入口；
6. 复用或启动 `http://127.0.0.1:8900` 单端口引擎；
7. 打开 `http://127.0.0.1:8900`。

终端等价命令：

```powershell
node bin/heimdall.mjs setup --no-connect
```

要让安装器同时配置并自测 Claude Code / Claude Desktop / Codex：

```powershell
node bin/heimdall.mjs setup
```

只想覆盖指定客户端：

```powershell
node bin/heimdall.mjs setup --connect codex,claude-desktop
```

`setup` 默认打开浏览器；脚本/CI 用 `--no-open`，只做检查不启动服务可以先用
`node bin/heimdall.mjs doctor --json`。npm 镜像用
`--registry https://registry.npmmirror.com`，Playwright 下载镜像沿用其官方环境变量
`PLAYWRIGHT_DOWNLOAD_HOST`。

> `:8900` 才是完整入口，同时提供控制台、API 和 MCP 执行引擎。
> `:5173` 只用于前端开发者单独跑 Vite；普通使用和 AI 调用都不需要它。

开发模式仍可开两个终端：

```powershell
pnpm -C core dev
pnpm -C console dev
```

此时只把 `:5173` 当 Vite 开发页，引擎仍是 `:8900`。若引擎设置了
`HEIMDALL_TOKEN`，先在控制台「设置 → 引擎 Token」保存同一口令；工作区产物与 API
都由引擎校验。

### 只给 AI 用，不需要打开控制台

如果只让 Codex、Claude Desktop 或 Claude Code 调用 MCP，可以不打开浏览器，但仍要有
本机执行引擎：

```powershell
node bin/heimdall.mjs setup --no-open
```

然后重新打开客户端或新开一个会话，先让它调用 `heimdall_doctor`。MCP 服务本身由客户端
拉起，不需要手工再跑一条 MCP 命令。`engine_unreachable` 只查
`http://127.0.0.1:8900/api/status`，不要查 `:5173`。

- Codex：全局 `config.toml` 里的 `[mcp_servers.heimdall]`
- Claude Desktop：`claude_desktop_config.json`
- Claude Code：`heimdall@heimdall` 插件

三个入口当前都应能看到 15 个 Heimdall 工具。Claude Code 的插件代理依赖 `:8900`
引擎；Codex 和 Claude Desktop 使用完整 MCP 服务，任务类工具在引擎没开时可以按需拉起
临时引擎，但演示时建议统一先开 `:8900`，避免工作区或进程来源不一致。

## 克隆与验收

**先确认站点授权、环境和数据保护。** 克隆、侦察、多视口验证、SEO 审计与监控会执行源页面脚本，也可能复用本地已保存的站点登录态；页面可能发出 POST 等请求、连接第三方或发起 WebSocket。它们没有统一的只读请求边界，也不能保证只连接目标站。GET 本身也可能有业务副作用；优先使用测试环境和受限账号。QA 工作区的 HTTP 方法策略是另一套机制，不会自动约束这些采集流程，且不能证明业务只读。

克隆默认不再自动点击名称包含“同意”或 `Accept` 的按钮。仅在站点配方中显式设置 `capture.consentButton` 为按钮名称正则时，才会点击第一个匹配按钮；请先人工审查按钮及其后果，因为它可能提交表单或修改业务数据。不点击按钮也不能阻止页面脚本主动发请求。

SEO 页面采集和交互回放遵循浏览器的 HTTPS 证书校验；证书不受信任时，该页面或交互不能测量。请修复证书或使用受信任的证书链，不要为了携带登录态而忽略证书错误。这不代表所有模块都实现了同样的保护。

1. 在顶部输入完整 URL 或域名，点「侦察」生成站内页面星图。点星球只打开详情，不自动克隆。
2. 在详情里点「克隆」，或去「页面」清单勾选并批量克隆。只要一页时，直接在顶部输入完整页面 URL，点「只克隆此页」。
3. 在「任务」看运行状态；在「页面」核对每页的产物与分数。切站后等待页面状态加载完，再执行删除或批量操作。
4. 去「报告」打开克隆档案、同步对比、SEO 报告和情报包；首行快捷入口只显示已存在的产物。未出现的报告要先运行对应任务。
5. 交付前运行全站多视口验证和离线健康检查，查看未测页面、缺失资源及失败项。历史分数可能由旧算法生成，需要重算后才能比较。

命令行入口及完整参数：`node core/src/cli.mjs --help`。

```powershell
node core/src/cli.mjs forge https://example.org/
node core/src/cli.mjs recon https://example.org 30
node core/src/cli.mjs queue example.org
node core/src/cli.mjs verify example.org --all
node core/src/cli.mjs assets example.org
node core/src/cli.mjs deliver example.org
```

`verify --all` 遍历全部目标页；有意抽样时显式传 `--max N`。结果里核对目标数、实测数、未测数及失败原因，不能只看平均分。页面结构、文字覆盖与像素是不同维度，分数不能替代断网浏览和人工检查。

大站全量验证按小时计，中断了不必从头再来：

```powershell
node core/src/cli.mjs verify example.org --all --resume
```

`--resume` 只复用**上次完整测成**、且 `manifest.json` / `clone/index.html` 都没比结果更新的页（克隆过的页会自动重测）；未测成的页一律重跑。摘要里的 `reused` 与 `measured` 分开计数，整站门禁仍按"全部页都测到"判定 —— 复用不会把没测过的页算成通过。

有些页永远等不到"请求全部结束"（长轮询、埋点心跳、统计信标），但版面早就定住了 —— 截下来就是终态。这种页默认仍然算"未测到"，要计入分数得显式开口：

```powershell
node core/src/cli.mjs verify example.org --all --allow-bounded
```

开了之后，这类页按**有界置信度**计入：分数可信，但摘要里 `bounded` 会单独计数，交接说明也会提醒"这些页背地里还在跑东西"。版面还在变、滚动后页高还在长的页，开不开都会被拦下 —— 那是中间态。

大站想快一点可以用 `--jobs N`（1–8，默认 1）：

```powershell
node core/src/cli.mjs verify example.org --all --resume --jobs 3
```

并发按页并行，每页仍独占自己的浏览器上下文。**默认是 1**：像素比对对时序敏感，抢 CPU 会让同一页的分数轻微漂移 —— 快是使用者的选择，准是默认值。

### 一条命令走完全程

不想手动串 `recon → queue → verify → assets → deliver` 时：

```powershell
node core/src/cli.mjs handoff https://example.org --max-pages 40
```

它会自己起一个临时引擎（用完关掉；本机已有引擎时直接复用），按顺序跑完五步，最后在
`workspace/<站点>/handoff/README.md` 写一份**先说清楚覆盖到哪一步**的交接说明：
发现多少页、完整测到多少页、没测到的卡在什么原因上、资产缺口有多少、交付包在哪里。
没测到的部分会如实写出来 —— 一个写着"120 页里测到 96 页"的包，比一个假装全绿的包有用。

可选：`--jobs N`（验证并发）、`--allow-bounded`（有界置信度）、`--skip-verify`（只要复刻件）。

## 交互镜像

交互镜像适合有明确授权、需要分析前端行为的场景，不能等同于任意站点的完整离线副本。

```powershell
node core/src/cli.mjs live example.org --offline --heal --strict --root mirror
```

这三个开关的边界要分开看：`--offline` 约束的是最终交付包运行时不回源；`--heal` 允许导出阶段访问原站，尝试补抓公开资源或页面，因此两者同时使用时不是“整个导出过程绝对断网”；`--strict` 才是发布门禁，会因未解析资源、站外运行时、未镜像链接、覆盖缺口或离线浏览器探针失败而退出非零。要验证导出过程本身也不联网，不能使用 `--heal`，还应在隔离网络环境中运行。`--strict` 失败时保留候选包和 `health.json` 供排查，不应把候选包称为离线交付通过。

已审核的公开跨源静态资源可精确许可补抓：将最多 50 个完整 HTTPS URL 写成 JSON 字符串数组，然后加 `--external-static-approvals .\external-static-approvals.json --offline --strict`。导出只处理候选包 HTML/CSS 中确实引用的 URL；失败项按列表索引写入 `health.externalStatic`，失败候选保留，旧正式包不受影响。该选项不会把第三方广告、接口或动态服务变成离线业务。完整边界见 [跨源静态资源补抓](docs/guide/05-external-static-assets.md)。

裸 `live <host>` 是允许回源的在线包。严格离线导出会把 `recon/atlas.json` 中已发现的页面与实际克隆页、包内路由核对，并逐页运行断网 Chromium 首次加载检查；没有侦察数据时，`health.json` 的 `coverage.scope` 为 `captured-only`，只能说明已捕获范围。侦察本身达到页数或深度预算时，也不能据此声称已经覆盖整站。

独立包的静态克隆目录中，字体、图片和 CSS 可被其他来源读取，以便隔离页面正常显示。不要在这些素材里放私密内容；包内 HTML、脚本、JSON 和克隆目录外的文件不因此开放跨来源读取。克隆目录内指向其他位置的符号链接不获得此许可，但普通请求仍可能读到链接目标；并发替换和硬链接未作安全保证。服务默认监听所有网卡，仅本机使用时请加 `--host 127.0.0.1`；这不是认证保护。旧包不会自动修复，须重新导出并逐页检查。
需要把侦察图谱里全部有效同源 URL 纳入克隆队列时，用 `node core/src/cli.mjs queue example.org --all-discovered`；新建普通队列仍按站点配方与页数预算筛选，续跑旧队列可能补入更多同源页面。旧队列若含无效或站外 URL，会拒绝执行并保留原文件，需先核对来源。

对已有捕获页面，可先运行 `node core/src/cli.mjs discover-operations example.org`。私有 `operation-discovery.json` 只列候选，不会点击。审核后把选中的 `pageName`、候选 `index`、`kind`、`action.selector` 原样写入同一站点工作区的 `operation-review.json`：

```json
{
  "version": 1,
  "origin": "https://example.org",
  "pages": [{
    "pageName": "home",
    "candidates": [{ "index": 0, "kind": "menu", "selector": "body > :nth-child(1)" }]
  }]
}
```

`origin` 必须与 `site-origin.json` 完全一致，候选字段以实际报告为准。运行 `node core/src/cli.mjs discover-operations example.org --execute-reviewed --max-actions 8` 才会执行清单中的分支；每次从新页面起步并重新校验候选，默认每页最多 150 个请求、最多执行 8 个审核分支、每页检查与探索至多 45 秒。`source-observed` 只表示点击后 URL、目标控件或其 `aria-controls` 区域的状态发生变化，不能证明变化由点击导致；只有整页 DOM 变化时记为 `page-change-unattributed`，不扣减未探索分支。后续新分支按候选类别数量的净增保守计数，同型控件重建不会算新增。依赖类别只覆盖本次动作的观察窗口，不代表整页依赖全集。页数、动作、请求、时间、iframe 和 Shadow DOM 之外的状态不视为已覆盖。该步骤只观察源站；仍需为离线镜像写操作计划和最终断言。`operation-review.json` 与发现报告一样不对外提供，也不随包分发。

需要验收点击或输入后的状态时，在 `core/workspace/<host>/operation-plan.json` 放置操作计划（使用 `HEIMDALL_DATA_DIR` 时放在相应站点工作区）。例如：

```json
{
  "version": 1,
  "flows": [{
    "path": "/search/",
    "actions": [
      { "type": "fill", "selector": "input[name=q]", "value": "sample" },
      { "type": "click", "selector": "button.search" }
    ],
    "expect": [{ "type": "visible", "selector": ".results" }]
  }]
}
```

`flows[].sessionName` 是可选字段。若要区分“匿名 / 管理员 / 某个测试账号”，先用 `node core/src/session/login.mjs <host> --session admin` 保存命名登录态，再在对应 flow 里写 `"sessionName": "admin"`。默认 `session.json` 仍用于没有 `sessionName` 的 flow；命名会话保存为 `session.admin.json`，不会互相覆盖。源站采集会按 flow 使用对应登录态，缺失的命名会话会作为显式失败记录，不会静默退化成匿名访问。

`actions` 支持 `navigate`、`click`、`fill`、`scroll`、`useSession`；`expect` 支持 `visible`、`hidden`、`text-includes`、`url`。`useSession` 不是页面点击，而是关闭当前浏览器上下文并从当前 URL 继续：`{"type":"useSession","sessionName":"guest"}` 切到命名登录态，`{"type":"useSession","sessionName":null}` 切回匿名。源站采集会在报告中记录脱敏的 `sessionSwitches`；离线包只支持匿名切换，命名会话会以 `sessionUnsupported` 阻断 strict 发布，不能伪装成离线登录。每条流程必须有可观察的最终断言。严格导出会在候选包中断开外网重放这些流程，HTTP 错误、脚本错误、未执行动作或断言失败均阻断发布；`operationProbe` 记录脱敏的依赖与失败。计划文件及输入值不进入交付包。未提供计划时，`operationPlan.status=missing`，交互未验收。默认禁止提交控件和写入型请求；这些业务要由本地适配器实现并单独验证。

严格导出还会在断外联浏览器中首载每个包内页面：默认至少观察 3 秒、等待 500 毫秒网络安静，最多观察 8 秒；上限时仍有未完成的本地请求或网络未安静会判失败。需要等待较晚启动的请求时可加 `--browser-observe-ms 5000`，最短观察期可设为 3000 至 15000 毫秒，实际策略与逐页时长见 `health.browserProbe.observation`。观察窗口外的请求和未声明的操作仍不属于通过范围。

离线包默认保留隐藏像素节点，使跨源请求继续被严格门禁报告。只有明确接受这个降级时，才加 `--omit-nonvisual-pixels`：它仅省略属性受限、行内声明隐藏的跨源 1×1 图片，`health.nonvisualExternalPixels` 会记录 `preserve` 或 `omit` 策略及移除数。静态属性无法证明页面脚本不读取这些节点，也不能排除外部 CSS 覆盖隐藏声明；如省略，应对目标站做视觉和关键操作对照。脚本、可见图片及其他跨源资源仍按原门禁处理。

页面脚本运行时再请求的公开只读服务默认阻断。确认有权分发这些响应后，创建 JSON 数组策略文件并加 `--cache-runtime-services <json-file>`（要求 `--offline --strict`）：

```json
["iconify", "vite-sponsors", "github-avatars"]
```

导出只收集源 HAR 中已声明服务的安全 GET 响应，写入本地 `_ext` 树并改写 JS 中的完整 URL 和 API 基址；`serve.mjs` 会把带查询的运行时请求映射到本地哈希实体。策略中的每个 service ID 必须出现在本次源 HAR 的运行时服务证据里，否则导出直接失败。Iconify 的三个镜像域名会按已观测的安全 GET 补齐，GitHub 头像只跟随声明服务内的安全重定向。`health.runtimeServiceCache` 记录服务、请求、成功、失败与字节数；策略文件、任意 API、敏感 query、未知服务或捕获失败都不会被静默加入。该选项不证明任意业务接口等价，未声明或未识别的运行时 origin 仍由浏览器探针阻断。

CarbonAds 默认作为第三方运行时服务阻断。只有明确接受"移除广告与追踪"的降级时，才在离线 strict 导出加 `--remove-carbonads`。它会删除候选包中已识别的 CarbonAds 脚本、广告容器和关联像素，并在 `health.carbonAdsRemoval`、`heimdall-live.json` 里记录策略与结果；漏删或失败仍会阻断发布。该选项不代表复刻原站广告业务，只表示交付一个不含该运行时的离线镜像。

YouTube 嵌入同样默认阻断。只有明确接受"视频不可离线播放"的降级时，才在离线 strict 导出加 `--replace-youtube`。它会替换已识别的 YouTube iframe，包括已被本地化到 `_ext` 的 iframe 路径，并在 `health.youtubePlaceholder`、`heimdall-live.json` 里记录占位策略；普通 YouTube 外链保留，因为它不是页面自动加载的运行时依赖。

路径别名探测出的跨域跳转默认作为 `unsupported-external-redirect` 阻断。只有明确接受"该链接不镜像、点击后只得到本地 404"时，才加 `--allow-unsupported-external-redirects`。该选项不会跟随或抓取外部目标站；`health.externalRedirectPolicy` 会记录接受数量，报告仍保留 `pathAliases` 证据。

加 `--compare-source` 会在获授权的源站运行同一操作计划，并把脱敏的源站结果与离线包结果写入 `health.sourceOperationProbe`。该开关要求 `--offline --strict`；源站不可达、源站流程失败或计划缺失都会阻断发布。`health.dependencyParity` 还按声明流程逐项核对源站与离线包的请求路径及查询、请求次数、响应状态、MIME，以及请求来自主 frame 还是 iframe/subframe；报告仅公开类别和计数。Shadow DOM 内发起的请求按网络层归入主 frame。最后一个状态捕获之后仍出现的请求会计入 `lateRequests`，并让源站采集或离线探针失败，不会静默并入前一个状态。它不比较静态资源正文，也不证明业务结果相同。源站采集阻断非只读 HTTP 方法与 WebSocket，因此不能用它证明提交、登录等写入业务等价；GET 在个别站点仍可能有业务副作用，只对已审阅的流程使用。没有该开关时，离线通过不代表已与源站交互对照。

### B3 后端脚手架

如果要把契约和可选的 B2 适配器包装成一个可启动的后端起点：

```powershell
node core/src/cli.mjs backend scaffold example.org
cd core/workspace/example.org/backend-scaffold
npm start
npm run check
```

这是 B3-scaffold，不是源站后端等价物。没有适配器的观察路由会返回 501；认证、权限、状态机、持久化和副作用仍需授权旅程与人工规则。

### 本地业务适配器

#### 先用观察数据做 B2 小验收

如果站点工作区已经有明确授权、清洗后的 API HAR，可以先让 Heimdall 自动生成一个**观察回放草稿**并做一次留出验证：

```powershell
node core/src/cli.mjs probe adapter --site example.org --include-api-bodies --out .\adapter-draft
```

这条命令会把样本按端点拆成训练集和留出集，只用训练集写入 `adapter-draft\manifest.json`、`adapter-draft\index.mjs`；验证报告写在 `adapter-report.json`。报告里的 `passed` 只表示脱敏观察样本的有限泛化，`not-validated` 表示样本不够，不能当作“后端已经复刻”。路径变化、新查询参数、状态码/MIME/JSON 形状或稳定字段不一致都会列为失败。若报告和输出目录已存在，需显式加 `--force` 才覆盖。

分页或字段选择查询需要逐条批准：复用下文的 `read-data-plan.json`，再为契约或适配器探针显式加 `--include-readonly-data`。这只读取已有 HAR，不会重新访问源站。站点来源须唯一且与记录一致；缺失或无效的计划会拒绝执行，批准的公开 GET 仍不能含认证信息或私密正文。

```powershell
node core/src/cli.mjs probe contract --site example.org --include-readonly-data
node core/src/cli.mjs probe adapter --site example.org --include-api-bodies --include-readonly-data --out .\approved-adapter-draft
```

适配器命令退出码 0 表示已生成草稿和报告。留出失败时摘要会明确显示 `failed`；应检查 `adapter-report.json` 的 `results.status`，不能将生成成功当作行为验证通过。

它不会自动生成登录、权限、状态机、支付、实时连接或真实副作用；也不要把 Xspark 的 QA 误报/漏报聚合数字当成 API HAR。Xspark 当前脱敏材料能支持检测器决策审查，但不足以证明某个 API 适配器的留出泛化。

需要在离线包内处理表单或有状态 API 时，可为**一个已授权站点**编写本地适配器。在 `core/workspace/<host>/runtime-adapter/` 放入 `manifest.json` 和 `index.mjs` 两个文件。清单只声明要接管的精确方法与路径，不含查询参数：

```json
{
  "version": 1,
  "routes": [
    { "method": "GET", "path": "/api/items" },
    { "method": "POST", "path": "/api/items" }
  ]
}
```

如果离线操作计划要使用命名会话，可在同一个清单里声明 `sessions`。每个会话名映射到一条已声明的 `POST` 路由；适配器必须返回 2xx 和 `Set-Cookie`，探针才会把这份 cookie 注入新的浏览器上下文：

```json
{
  "version": 1,
  "routes": [
    { "method": "POST", "path": "/api/session/admin" }
  ],
  "sessions": {
    "admin": { "method": "POST", "path": "/api/session/admin" }
  }
}
```

`sessionName: null` 永远表示匿名上下文。命名会话缺失、适配器返回失败或没有 `Set-Cookie` 时，离线探针记录 `sessionUnsupported` 并阻断严格发布；`health.adapter.sessionRoutes` 会报告 declared / initialized / failed。本地引导只用于建立离线浏览器上下文，不写入交付包，也不参与 `--compare-source` 的源站/离线依赖等价统计。它仍不证明登录业务与源站一致，独立登录、会话延续和写入业务还需要逐站适配器与授权验收。

`index.mjs` 导出 `async function handle(request, { dataDir })` 并返回标准 `Response`。`request` 是 Web Request；持久化文件必须写到 `dataDir`，该目录位于交付包外，由运行时的 `HEIMDALL_RUNTIME_DATA_DIR` 指定。导出只包含这两个适配器文件，不会自动复制 npm 依赖。适配器代码由操作者编写并随包执行，应审核其数据访问与外联行为；它不是自动生成的通用登录、支付或实时服务。

```powershell
node core/src/cli.mjs live example.org --offline --strict --root mirror --include-adapter
```

导出时必须在 `operation-plan.json` 中覆盖清单里的每条路由，并用页面最终状态断言验证关键操作。`health.adapter` 会显示声明、实际触达和未测路由数，未测路由阻断严格发布。未声明的写请求在离线包中返回 404，不会静默回源。请求体上限为 4 MiB，未结束的请求体在 10 秒后拒绝；适配器处理与响应流共用 15 秒期限。处理期限依赖适配器遵守取消信号，不能强制停止阻塞事件循环的代码。部署包生成的 Compose 会把持久数据卷挂在 `/data`；直接用 Node 启动时，先建立包外目录并设置 `HEIMDALL_RUNTIME_DATA_DIR`。严格浏览器探针阻断浏览器外联，但不会隔离适配器 Node 进程的网络，`health.adapter.serverEgress=not-tested` 会明确提示这一点。每个实际适配器还须在无外联容器中重新执行关键操作、验证状态持久化。源站写操作仍不会被 `--compare-source` 自动重放，业务正确性需要授权场景下的独立验收。

只读 GET 数据必须先确认有权分发，再在站点工作区放置 `read-data-plan.json`：

```json
{ "version": 1, "paths": ["/api/catalog?page=1"] }
```

然后显式加 `--include-readonly-data --offline --strict`。导出只接受精确 URL、同源、无认证信息、2xx 的 JSON/纯文本响应；候选包中缺少任何声明响应都会阻断发布，结果见 `health.readOnlyData`。默认从页面已有的 `network.har` 取响应；同时加 `--compare-source` 并提供已审阅的 `operation-plan.json`，可在源站执行声明流程时采集点击后才出现的许可 GET。每个响应限 1 MiB、累计限 10 MiB；认证、超限、缺失或同 URL 内容冲突均阻断严格交付。源站流程仅执行一次，`health.readOnlyData.flowParity` 按声明流程对照许可 GET 的精确 URL、状态、MIME 和清洗后正文指纹；报告只保留脱敏计数及问题类别。对照不证明请求时序、重复次数、未声明操作或业务结果一致。计划和响应内容仍须人工审核，自动敏感信息规则不能识别所有个人数据或商业机密。宽泛的 `--include-api-har` 不能与 `--strict` 同用。

在 `--compare-source` 模式下，源站和离线复测从 Chromium 协议读取同一次请求的正文；取正文不会主动重发请求，但页面自身仍可能多次请求。缓存、重定向、必要响应头不可核实，或浏览器与协议的可见响应数不一致时，严格导出会阻断，逐流程数据对照显示未完成。两者都没有观察到的请求仍可能遗漏，弹窗和跨进程页面也不保证完整覆盖。旧版生成的包应重新对照并人工审阅；未启用源站对照而只使用已有 HAR 时，不能据此确认 HAR 正文来自哪次请求。

导出前核对授权和敏感数据。严格导出会检查候选包中的凭据型 URL、Bearer、Cookie 值；`health.privacyAudit` 记录问题数与扫描是否完整。它不是全面的个人信息识别。认证站点默认不应把 API 正文或带凭证的 URL 纳入可分发 HAR；独立包仍需验收登录、重定向、登出和长期运行。隐私扫描默认累计检查 128MB 文本；大站可用 `--privacy-max-total-bytes 134217728..1073741824` 提高预算。公开文档补抓默认 60 秒，可用 `--public-text-links-max-wall-ms 60000..900000` 延长。`--strict` 失败时先修缺口，不要把包标成离线完成。

## SEO 回归

SEO 审计本身可独立运行：

```powershell
node core/src/cli.mjs audit example.org --max 30
```

仓库的 SEO 回归工作流当前仅手动触发，`config/seo-targets.txt` 没有已授权目标或受版本控制的基线。正式启用门禁前，先录入目标并审核基线；损坏或缺失的基线不能当成回归通过。

站点地图只读取目标来源的 `robots.txt` 声明、递归子地图及常见地址，跨来源声明和跳转不会跟随。报告的 `sitemap.coverage` 仅说明这个有预算的检查范围：`complete` 表示声明项及常见地址没有已知采集缺口；`not_found` 表示已检查位置没有找到，不代表其他位置不存在；`partial` 表示只采到一部分；`unavailable` 表示不能取得有效地图。XML 检查包含格式良构性，不等于完整的 sitemap 规范或搜索引擎验证。

`partial` 或 `unavailable` 时，普通审计仍生成报告，但分数只是暂算，不写趋势、不比对或更新基线；基线及分数门禁返回失败。依赖地图发现页面的变更监控也会停止比较和更新基线。AI 返回和竞品矩阵不会把旧对比或不完整分数当作有效结果；旧报告未记录采集状态时需重新审计。即使地图状态为 `complete`，也不代表已经发现全站页面、搜索引擎已收录或 AI 已引用。

旧版基线没有记录地图采集状态，不能直接用于回归或原地更新；保留旧文件，并指定新路径重新采集、人工审核。例如：

```powershell
node core/src/seo/audit.mjs https://example.org --max 30 --baseline .\seo-baseline-new.json --update-baseline
```

后续用同一路径启用 `--require-baseline --fail-on-regression`。若 `--max` 太小而没有检查完旧基线中的页面，本次不会把它们说成消失，也不会更新基线；应提高上限后重跑。页面本身采集失败时同样跳过基线比较，普通报告保留 HTTP 状态供排查。

## QA CI

把已有的 QA 工作区接进 CI 时，用：

```powershell
heimdall qa ci --site web --viewports 1440,390 --fail-on all --github
```

它会运行同一套只读 QA，并在本次运行目录下写 `qa-ci.json` / `qa-ci.md`，同时向 GitHub Actions 写摘要和注解。`--fail-on wall|degrade|all|none` 控制什么级别会让流水线变红。完整模板见 [QA CI 指南](docs/guide/07-qa-ci.md)。

## 产物与排障

- 工作区：`core/workspace/<host>/`；交付包：`core/deliverable/`。默认均不进 Git，可通过 `HEIMDALL_DATA_DIR` 改数据根目录。`health.coverage` 用同一批已发现 URL 统计按当前默认配方估算的队列排除、实际入队、克隆、有效 v2 验证及交付数量；侦察页数或深度触顶、sitemap 预算耗尽、声明的 sitemap 读取失败、出现站外 sitemap 或页面采集失败时，`discovery.scopeLimited` 标记范围受限。即使它为 `false`，仍不能证明整站所有页面都已发现。
- 页面目录名由引擎的 URL 映射决定。不要根据路径手写目录名；从「页面」清单、报告索引或 `manifest.json` 查实际路径。
- 打不开控制台时先运行 `node core/src/cli.mjs doctor --json`，再检查
  `http://127.0.0.1:8900/api/status` 与 `http://127.0.0.1:8900/`。`:5173`
  只属于 Vite 开发模式，不是 MCP 或日常使用入口。有 Token 时在设置中保存后刷新。
- 未生成的可选产物不会在报告里显示链接。已有产物打不开时先检查引擎鉴权，再看引擎日志与浏览器网络请求。
- 测试入口：`pnpm -C core lint`、`pnpm -C core test`、`pnpm -C core smoke`、`pnpm -C console build`。

架构、产品边界和当前待办分别见 [当前架构](./docs/guide/01-architecture.md)、[PRD.md](PRD.md) 与 [ROADMAP](docs/ROADMAP.md)。
