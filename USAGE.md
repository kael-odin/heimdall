# Heimdall 使用指南

本指南说明当前控制台与命令行的操作。旧版逐日说明已移至
[历史使用手册](docs/archive/USAGE-through-2026-10-13.md)，其中的示例分数与页面数量不能当成当前验收结果。

## 准备

- Node.js 20.19+、pnpm 11.7+；抓取与测试需要 Playwright Chromium。
- 仅处理自有站点或取得明确授权的内容。登录会话、导出包和代理访问分别按授权范围控制。
- 新机要分别安装两个子包。根目录没有 pnpm workspace 配置。

```powershell
pnpm -C core install --frozen-lockfile
pnpm -C console install --frozen-lockfile
pnpm -C core exec playwright install chromium
```

## 启动

开发时开两个终端：

```powershell
pnpm -C core dev
pnpm -C console dev
```

控制台为 `http://127.0.0.1:5173`，引擎为 `http://127.0.0.1:8900`。
Windows 也可运行根目录的 `clone-heimdall.cmd`，脚本会检查两个服务均返回成功后再打开控制台。

单端口运行：

```powershell
pnpm -C console build
$env:HEIMDALL_CONSOLE_DIR = (Resolve-Path console/dist).Path
pnpm -C core dev
```

此时打开 `http://127.0.0.1:8900`。若引擎设置了 `HEIMDALL_TOKEN`，先在控制台「设置 → 引擎 Token」保存同一口令；工作区产物与 API 都由引擎校验。控制台开发服务器不直接发布 `core/workspace/`。

## 克隆与验收

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

## 交互镜像

交互镜像适合有明确授权、需要分析前端行为的场景，不能等同于任意站点的完整离线副本。

```powershell
node core/src/cli.mjs live example.org --offline --heal --strict --root mirror
```

已审核的公开跨源静态资源可精确许可补抓：将最多 50 个完整 HTTPS URL 写成 JSON 字符串数组，然后加 `--external-static-approvals .\external-static-approvals.json --offline --strict`。导出只处理候选包 HTML/CSS 中确实引用的 URL；失败项按列表索引写入 `health.externalStatic`，失败候选保留，旧正式包不受影响。该选项不会把第三方广告、接口或动态服务变成离线业务。完整边界见 [跨源静态资源补抓](docs/guide/05-external-static-assets.md)。

裸 `live <host>` 是允许回源的在线包。严格离线导出会把 `recon/atlas.json` 中已发现的页面与实际克隆页、包内路由核对，并逐页运行断网 Chromium 首次加载检查；没有侦察数据时，`health.json` 的 `coverage.scope` 为 `captured-only`，只能说明已捕获范围。侦察本身达到页数或深度预算时，也不能据此声称已经覆盖整站。
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

`actions` 支持 `navigate`、`click`、`fill`、`scroll`；`expect` 支持 `visible`、`hidden`、`text-includes`、`url`。每条流程必须有可观察的最终断言。严格导出会在候选包中断开外网重放这些流程，HTTP 错误、脚本错误、未执行动作或断言失败均阻断发布；`operationProbe` 记录脱敏的依赖与失败。计划文件及输入值不进入交付包。未提供计划时，`operationPlan.status=missing`，交互未验收。默认禁止提交控件和写入型请求；这些业务要由本地适配器实现并单独验证。

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

### 本地业务适配器

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

导出前核对授权和敏感数据。严格导出会检查候选包中的凭据型 URL、Bearer、Cookie 值；`health.privacyAudit` 记录问题数与扫描是否完整。它不是全面的个人信息识别。认证站点默认不应把 API 正文或带凭证的 URL 纳入可分发 HAR；独立包仍需验收登录、重定向、登出和长期运行。`--strict` 失败时先修缺口，不要把包标成离线完成。

## SEO 回归

SEO 审计本身可独立运行：

```powershell
node core/src/cli.mjs audit example.org --max 30
```

仓库的 SEO 回归工作流当前仅手动触发，`config/seo-targets.txt` 没有已授权目标或受版本控制的基线。正式启用门禁前，先录入目标并审核基线；损坏或缺失的基线不能当成回归通过。

## 产物与排障

- 工作区：`core/workspace/<host>/`；交付包：`core/deliverable/`。默认均不进 Git，可通过 `HEIMDALL_DATA_DIR` 改数据根目录。`health.coverage` 用同一批已发现 URL 统计按当前默认配方估算的队列排除、实际入队、克隆、有效 v2 验证及交付数量；侦察页数或深度触顶、sitemap 预算耗尽、声明的 sitemap 读取失败、出现站外 sitemap 或页面采集失败时，`discovery.scopeLimited` 标记范围受限。即使它为 `false`，仍不能证明整站所有页面都已发现。
- 页面目录名由引擎的 URL 映射决定。不要根据路径手写目录名；从「页面」清单、报告索引或 `manifest.json` 查实际路径。
- 打不开控制台时检查 `:8900/api/status` 与 `:5173/`；有 Token 时在设置中保存后刷新。启动脚本超时会报错，不代表服务已就绪。
- 未生成的可选产物不会在报告里显示链接。已有产物打不开时先检查引擎鉴权，再看引擎日志与浏览器网络请求。
- 测试入口：`pnpm -C core lint`、`pnpm -C core test`、`pnpm -C core smoke`、`pnpm -C console build`。

架构、产品边界和当前待办分别见 [ARCHITECTURE.md](ARCHITECTURE.md)、[PRD.md](PRD.md) 与 [ROADMAP](docs/ROADMAP.md)。
