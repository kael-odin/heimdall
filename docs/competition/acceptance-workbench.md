# 项目验收工作台

更新：2026-10-28。此文描述已经实现的比赛 MVP；完整方向与尚未实现的能力在[赛题方案](02-自动验收开发项目还原度BUG检测系统.md)。[固定测试集](acceptance-demo.md)与[本轮验证证据](../audits/README.md)分别说明检出能力和验证范围。

## 现在可以做什么

控制台底部“项目验收”不要求先通过 Heimdall 克隆。Mirror 将参考页面与开发项目对照；Regression 将用户指定的上一稳定版本与新版本对照。两者执行同一套浏览器引擎。新增 [Spec 契约模式](acceptance-spec.md)接收单个目标与显式批准的 API 需求，支持手工清单及 OpenAPI JSON 只读候选、来源文档证据和接口门禁。[需求基线](acceptance-baseline.md)提供已归属 Spec 来源的完整预览、人工批准和独立选用；版本托管仍待实现。

- 默认手机 375×812、平板 768×1024、桌面 1440×900；每个路由、每个视口独立观察两侧，使用隔离浏览器上下文。
- 检查导航 / HTTP、console / 脚本错误、网络失败、横向溢出、标题 / 主标题 / 控件语义及视觉差异。
- 支持显式 click / fill / press 步骤和 visible / hidden / text / attribute / url 断言，基线通过而目标失败才归因为目标缺陷。
- 每侧重复截图识别不稳定内容。动态区域只按明确的 CSS selector 遮罩；遮罩覆盖过大时进入复核。
- 证据包括双方截图、重复截图、差异图、DOM 语义、网络摘要、复现步骤、计划及验证器指纹和文件 SHA-256。
- 可按需做元素定位：对可靠失败（verdict 为 bug）的检查，用与运行相同的只读浏览器配置重新渲染两侧，把失败落到元素和源码行。样式差异指向生效的 CSS 规则及媒体条件，被隐藏的控件指向隐藏它的规则，属性差异指向 HTML 标签，交互失败指向事件处理脚本，缺失字段锚定到基线相邻元素在目标中的位置，脚本异常与资源失败指向抛错行和引用标签；样式、隐藏、属性、交互与缺失字段同时附基线一侧的对应位置。结果存为旁路 `localization.json`，不改变报告、门禁或验证器指纹。
- 可按需请求已配置模型解释脱敏检查摘要；未知检查 ID 和模型提出的门禁改动不会被接纳。不会自动上传截图、原始页面或会话。
- 可以从基线自动生成候选验收点：对每条已声明路由，在只读上下文里逐个操作带稳定选择器的可见控件（单步点击或填写），把操作前后地址、可见性、文本和状态属性的变化写成断言，只保留操作前不成立、操作后成立、并在每个计划视口重放仍成立的断言；结构检查不比较的短文案另组成内容验收点。候选点填入验收点 JSON，由人审阅、删改后再运行；探索只访问基线，不访问目标。

## 如何开始

先按仓库 [README](../../README.md) 安装依赖、构建控制台并启动引擎，打开底部“项目验收”。填写名称、验收模式、基线 URL、目标 URL 与路由；高级区可以声明验收点和遮罩，也可以点“从基线生成候选验收点”先得到一份草稿。运行后查看维度、问题类型、双方证据和复现步骤，下载 Markdown / JSON。手机可用顶部“查看结果”直接到报告区。

`/` 表示输入入口 URL 本身，其余路由相对于该入口路径追加。例如基线 `http://127.0.0.1:9087/baseline` 配路由 `/menu-state`，访问 `/baseline/menu-state`。不接受跨 origin 路由或 `..`。输入基线表示声明该地址为本次参考，不表示系统已证明其业务正确。

**入口地址要填最终页面**：参考和目标在首次声明操作前发生跳转或重新加载，即使是常见的地址规范化、同地址重定向或刷新，也会阻断本次比较，不自动判为产品 BUG。先确认真实目的页面，再用不会继续跳转的地址重跑；当前入口不支持 `#` 片段。声明的首次操作成功后触发的正常导航仍按操作规则执行。不要在地址里放密码或令牌。

多视口克隆的 `index.html` 可能只是跳转选择器。控制台目前固定使用三个视口，没有逐个选择视口的按钮。要为不同视口分别指定基线，可通过 CLI 计划或 API 分次执行普通 Mirror / Regression 验收。例如手机计划中的入口指向已确认的 `index-375.html`，并只声明手机视口：

```json
{
  "name": "手机页面验收",
  "mode": "mirror",
  "baselineUrl": "http://127.0.0.1:9087/reference/index-375.html",
  "targetUrl": "http://127.0.0.1:9087/target",
  "routes": ["/"],
  "viewports": [{ "name": "mobile", "width": 375, "height": 812 }]
}
```

把示例地址换成实际可访问且不再跳转的两个页面，例如将计划写入仓库根目录的 `mobile-plan.json`，再从仓库根目录执行 `node core/src/acceptance/cli.mjs --plan .\mobile-plan.json --gate`。平板和桌面分别使用各自已确认的实际文档与视口。没有对应文件或仍会跳转时，应先核实基线，不要放宽门禁。这是分次普通验收，不能直接当作一次正式门禁通过。

运行本地比赛夹具：

```powershell
node core/test/fixtures/acceptance-site.mjs 9087
```

另一终端直接执行保存的演示计划：

```powershell
node core/src/acceptance/cli.mjs --plan config/acceptance/demo.json --gate
```

计划含已知缺陷，所以 `--gate` 预期退出 1。无 `--gate` 时退出码只代表执行成功；结果仍须检查 `gate`。在 CI 中应带 `--gate`，且所有非通过状态都会返回非零。

也可以先让基线自己给出验收点草稿（不创建运行，也不访问目标）：

```powershell
node core/src/acceptance/cli.mjs --explore config/acceptance/demo.json --output core/workspace/_runs/explored-demo.json
```

输出里的 `points` 是新增候选，`plan` 是合并后的完整计划；并入前请人工核对。

## 机器可读输入

```json
{
  "schemaVersion": 1,
  "name": "移动菜单验收",
  "mode": "mirror",
  "baselineUrl": "http://127.0.0.1:9087/baseline",
  "targetUrl": "http://127.0.0.1:9087/target",
  "routes": ["/menu-state"],
  "thresholds": { "visual": 0.97 },
  "points": [{
    "id": "MENU-OPEN",
    "title": "菜单点击后展开",
    "route": "/menu-state",
    "severity": "high",
    "steps": [{ "action": "click", "selector": "#menu-toggle" }],
    "assertions": [{ "kind": "attribute", "selector": "#menu-toggle", "attribute": "aria-expanded", "equals": "true" }]
  }],
  "normalization": { "maskSelectors": [] }
}
```

上限为 8 路由、3 视口、24 验收点，每点 12 步、20 断言；超限直接拒绝，不静默抽样。每点必须属于已声明路由，ID 唯一，执行动作与断言使用白名单。配置 `viewports: [{"name":"desktop","width":1440,"height":900}]` 可只验一个视口，但报告范围也仅覆盖该视口。

`text`、`attribute`、`url` 断言恰好选择 `equals` 或 `contains`；跨域名 URL 断言通常用相对路径 `contains`。不执行传入 JavaScript。

## 结果与门禁

| 字段 | 含义 |
| --- | --- |
| `status` | 单项执行状态：passed / failed / blocked / needs_review |
| `verdict` | 归因：match / bug / baseline_failed / environment / needs_review |
| `oracle` | 用户声明的运行基线来源 |
| `evidenceLevel` | 浏览器实测；固定夹具评测另标 offline-reproduced |
| `gate` | passed / failed / blocked / needs_review，只有 passed 允许门禁通过 |

目标缺陷或明确断言失败阻断；缺测、执行上限、环境或证据失败阻断；基线错误、动态差异及不可靠视觉证据不能算通过。未声明交互时行为维度显示“未声明”，没有业务或 API 真值时不自动补满分。视觉与行为独立，视觉高分不会抵消菜单状态错误。

入口阶段被阻断时，可能没有截图；只要报告明确记录该缺失且其余应有证据完整，这不等于证据损坏，更不等于通过。旧报告和历史基线不会自动修正；验证器变化时，跨版本复验不能直接用作可靠通过或自动关单。

`summary.coverage` 以检查为单位，基础是 `6 × 路由 × 视口 + 验收点 × 视口`；只读请求阻断等额外检查增加分母。`measured` 只计有可靠 match / bug 判定的 passed / failed，blocked / needs_review 不进入可靠覆盖。检查数不等于独立缺陷数，同一缺陷可在三个视口各有一条结果。

## API 与持久化

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| POST | `/api/acceptance/runs` | 校验计划并异步执行，202 `{runId, taskId}`；同引擎已有验收时 409 |
| GET | `/api/acceptance/runs` | 最近 100 个任务摘要 |
| GET | `/api/acceptance/runs/:id` | 计划、状态、进度与结论 |
| GET | `/api/acceptance/runs/:id/report` | 完整 JSON |
| GET | `/api/acceptance/runs/:id/report.md` | Markdown |
| GET | `/api/acceptance/runs/:id/evidence/:filename` | 仅该报告引用且位于任务目录中的 PNG / JSON |
| POST / GET | `/api/acceptance/runs/:id/triage` | 按需生成 / 恢复 AI 建议 |
| POST / GET | `/api/acceptance/runs/:id/localization` | 按需生成 / 恢复元素定位；同引擎一次只定位一份，运行未完成时 409 |
| POST | `/api/acceptance/explore` | 只读探索基线并返回候选验收点、每条路由的跳过原因；同引擎一次只探索一份 |
| POST | `/api/jobs/:taskId/cancel` | 复用任务取消，任务记为中断 |

沿用引擎 Token 鉴权；控制台图片与报告使用鉴权 fetch，不把 Token 写入外部地址。数据位于 `HEIMDALL_DATA_DIR/acceptance/<runId>/`，默认 `core/acceptance/`，已加入 Git 忽略。历史报告可刷新恢复；重启后仍 running 的任务会记为 interrupted，旧工作进程不能将其改回完成。不存在自动删除历史数据的流程。

## 确认的边界

Chromium 固定语言 `zh-CN`、时区 `Asia/Hong_Kong`、浅色与减少动效。全页截图受高度 12,000px / 1,200 万像素预算约束；超限退为首屏并标记待复核。当前只做两次有界截图及配置的短观察窗口，未执行通用懒加载滚动、任意延迟业务完成判断或自动探索全部状态。

入口保护只覆盖首次操作之前以及无操作时的有界采集过程，不能保证之后的任意延迟导航、网页业务或最终部署安全。正式门禁会按配置的每个视口分别提交验收任务，并为该视口提供对应的实际基线文档；缺少变体或入口仍会跳转时，该视口阻断，不能借用其他视口证据。不要把固定的桌面基线冒充其他视口的正确基线。

默认阻断非 GET / HEAD / OPTIONS 请求与 WebSocket，不使用现有用户登录态；需要写请求、认证或实时通道的页面会环境阻塞。只读限制按方法实施，依赖 GET 做业务写入的站点仍应使用独立授权测试环境。

Spec / OpenAPI 只读契约的实际支持与拒绝范围见[专用指南](acceptance-spec.md)，不能由页面 Mirror 分数推断。自动生成的验收点只覆盖单步点击和填写，跳过破坏性名称、写请求、外链、下载与新窗口；它把基线行为当作验收预期，基线自身做错的交互也会被写成断言，所以并入计划前必须人工确认这些行为确实是需求。目前没有 Figma 元数据导入、数据库对账、跨系统回调、登录态配置、缺陷自动去重关闭或自动代码修复。元素定位给出的是浏览器实际收到的 HTML、样式表与脚本中的行列，尚未经 source map 回到构建前的工程文件；它靠运行后重新渲染，页面含时间、随机数或登录态内容时可能复现不出原失败，此时只记“未复现”，不改结论。真实业务结果不能从视觉分或 DOM 相似推断。AI 摘要脱敏是有限规则，页面文案和证据仍应使用授权测试数据。

## 验证与 CI

```powershell
pnpm acceptance:benchmark
pnpm -C console build
pnpm acceptance:smoke
```

基准按固定案例真值统计 TP / FP / FN / TN、Precision / Recall / 误报率，并对每个检出的目标缺陷核对元素定位是否落到注入源码；第二臂只使用自动生成的验收点，单独报告检出、误报与案例校验；不能用检查数量代替缺陷样本数。控制台 smoke 用真实浏览器完成创建、执行、带鉴权证据、元素定位、基线探索候选点、Markdown 下载、刷新恢复与手机布局；AI 端到端链路使用本地模型模拟器，另外的真实模型验证会单独注明。两条流程都已接入 CI。
