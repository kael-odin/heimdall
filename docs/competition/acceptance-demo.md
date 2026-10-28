# Mirror 自动验收固定演示与检出基准

这套演示把一个健康基线与一个注入差异的目标项目放在本地浏览器中实际运行，展示视觉、结构、行为、脚本与资源问题的检出和源码定位，以及基线自身错误和只读阻塞的归因。

**证据等级是离线复现。固定夹具不是真实站点业务验收，基准检出率不能推广为任意项目的检出率。**

## 一键运行

在仓库根目录执行：

```powershell
node core/scripts/benchmark-acceptance.mjs
```

可选第一个参数指定证据目录：

```powershell
node core/scripts/benchmark-acceptance.mjs D:\Github-Star\heimdall\core\workspace\_runs\my-acceptance-benchmark
```

脚本自启仅绑定 `127.0.0.1` 的随机端口服务器；对每个案例用一个对应视口执行验收，最后关闭服务器。每次结果写入独立时间戳目录，默认父目录为 `core/workspace/_runs/acceptance-benchmark`。`latest.json` 指向最近一次运行。每案包含计划、JSON/Markdown 报告、双方截图、重复截图、差异图及 DOM/console/网络摘要；有可靠失败的案例另有 `localization.json` / `localization.md` 元素定位。

有误报、漏检、错误归因、覆盖缺失、门禁不符合案例真值，或检出的目标缺陷没有定位到注入源码时，进程退出码为 `1`。执行失败、未测和阻塞不能算通过。

## 固定真值

统计单位是案例，一个案例发现多个问题或产生多张截图仍只计一个样本。

| 案例 | 注入情况 | 目标 BUG 真值 | 预期 |
| --- | --- | --- | --- |
| `visual-shift` | 主要内容下移并改变面板外观 | 是 | 视觉缺陷并阻断 |
| `mobile-menu` | 390px 视口隐藏菜单按钮 | 是 | 控件缺失并阻断 |
| `menu-state` | 点击可展开菜单，但不更新 `aria-expanded` | 是 | 明确属性断言失败并阻断 |
| `missing-field` | 删除剩余配额文字字段 | 是 | 字段断言失败并阻断 |
| `wrong-link` | 详情链接改跳价格页 | 是 | 点击后 URL 断言失败并阻断 |
| `runtime-error` | 目标 JavaScript 抛出异常 | 是 | 脚本错误并阻断 |
| `missing-resource` | 目标引用不存在的脚本，返回 404 | 是 | 网络资源错误并阻断 |
| `title-change` | 目标页面 `<title>` 被改写 | 是 | 结构不一致并阻断 |
| `heading-change` | 目标主标题文案被改写 | 是 | 结构不一致并阻断 |
| `aria-label-change` | 菜单按钮的无障碍名称被改写 | 是 | 结构不一致并阻断 |
| `overflow-mobile` | 目标在 390px 视口出现 1,600px 宽元素 | 是 | 运行健康（水平溢出）并阻断 |
| `broken-link` | 详情链接指向不存在的页面 | 是 | 点击后返回 404 并阻断 |
| `tablet-shift` | 目标内容整体下移 120px，没有配色变化 | 是 | 严格视觉阈值下检出并阻断 |
| `console-warning` | 目标只调用 `console.warn` | 否 | 无 BUG 且通过 |
| `identical` | 相同 DOM、CSS、内容和行为 | 否 | 无 BUG 且通过 |
| `baseline-error` | 两侧都保留批准基线自身的脚本异常 | 否 | `baseline_failed`，不能通过 |
| `masked-noise` | 刷新批次及背景持续变化，计划显式遮罩对应区域 | 否 | 遮罩后无 BUG 且通过 |
| `blocked-write` | 两侧依赖 POST，默认只读策略阻断请求 | 否 | `environment`，不能通过 |

总分母是 18 个独立案例，其中已知目标 BUG 分母为 13，非目标 BUG 分母为 5。Precision 为 `TP / (TP + FP)`，Recall 为 `TP / 13`，误报率为 `FP / 5`。每案只要任一检查归因为 BUG，就算该案预测为 BUG；未测成的已知 BUG 计漏检。非 BUG 案例即使没有误报，也必须满足预期分类与门禁才能通过基准。

真值位于 `core/test/fixtures/acceptance-site.mjs` 的 `ACCEPTANCE_FIXTURE_CASES`，基准脚本会复制为本次证据目录中的 `truth.json`。检测器不能用案例真值决定结论；真值仅供检测完成后的独立评估。

## 元素定位

检出之后还要回答"问题在哪"。基准对每个检出的已知 BUG 案例，在验收结束后用同一只读浏览器配置重新渲染两侧，把失败检查落到元素和源码行，再与注入点比对。定位真值是 `core/scripts/benchmark-acceptance.mjs` 中的 `LOCALIZATION_TRUTH`：每案声明注入点的发现类型、元素和源码中的注入文本，同样写入 `truth.json`，定位器本身不读取它。

| 案例 | 期望定位到 |
| --- | --- |
| `visual-shift` | `main` 的 `transform` 样式差异，及含 `translateY(160px)` 的规则行 |
| `mobile-menu` | 隐藏 `#menu-toggle` 的 `@media` 规则行 |
| `menu-state` | `#menu-toggle` 的点击处理脚本，基线一侧有 `aria-expanded` 更新而目标没有 |
| `missing-field` | 目标标记中 `#quota` 应在的位置（基线相邻元素 `.metric` 之后） |
| `wrong-link` | `#details-link` 的 `href="pricing"` 标签 |
| `runtime-error` | 抛出异常的脚本行 |
| `missing-resource` | 引用 `missing-widget.js` 的标签 |
| `title-change` | 目标 `<title>` 文本 |
| `heading-change` | 目标 `<h1>` 文本 |
| `aria-label-change` | 菜单按钮的 `aria-label` 标签 |
| `overflow-mobile` | 造成溢出的 `.wide{width:1600px}` 规则 |
| `broken-link` | `#details-link` 的 `href="gone"` 标签 |
| `tablet-shift` | `main` 的 `transform: translateY(120px)` 规则 |

分三档计数，分母是检出的已知 BUG 案例：

- 命中源码：有同类型、同元素的发现，带行号，且源码摘录含注入文本。
- 仅元素：同类型、同元素的发现存在，但行号或摘录不对。
- 未命中：没有对应发现，或定位执行失败。

纯平移在低对比背景上只改变约 1.5% 的像素，默认 0.97 阈值看不出来；`tablet-shift` 因此在计划里使用 0.995 的严格阈值，生产项目若要求像素级布局，应显式收紧阈值。

只有命中源码才算案例通过。`benchmark.md` 的"元素定位"一节列出三档计数、源码命中率、单案验收与定位耗时 P50 / P95，以及每案指向的文件、行列和摘录。耗时取最近秩分位数；18 个样本下 P95 即最慢一案。定位只改变"问题在哪"的证据，不改变检出、误报或门禁统计，也不写入验收报告。

## 自动生成验收点（基准第二臂）

除了手写验收点，基准还跑一个只用自动生成验收点的臂（结果在同案的 `auto/` 子目录）：对每条案例的基线逐页探索可见控件，单步点击或填写后，把地址、可见性、文本、状态属性的变化写成断言，再按执行器语义在每个计划视口重放，只保留稳定成立的断言；结构检查不比较的短文案另组成内容验收点。该臂不访问目标页面，也不加入任何手写点。

最近一次运行（`benchmark-2026-10-28T08-21-50-273Z-62a555ff`）共生成 48 个验收点：13 个已知目标 BUG 全部检出，5 个非 BUG 案例 0 误报，18/18 案例校验通过。每案的探索结果、自动计划和报告在同案的 `auto/` 子目录；`benchmark.md` 的“自动生成验收点”一节列出每案生成数、检出与门禁。

对真实项目，控制台高级区的“从基线生成候选验收点”或 CLI 都能先得到草稿：

```powershell
node core/src/acceptance/cli.mjs --explore core/workspace/_runs/acceptance-benchmark/<运行目录>/menu-state/plan.json --output draft.json
```

`draft.json` 里的 `points` 是新增候选，`plan` 是合并后的完整计划。候选自基线推导，基线本身做错的交互也会被写成断言，运行前需要人工确认。

## 控制台演示

可单独启动固定端口服务器：

```powershell
node core/test/fixtures/acceptance-site.mjs 9087
```

将输出中的 `baselineUrl` 和 `targetUrl` 填到验收工作台。路由相对于入口路径解析，例如 `/visual-shift` 对应基线 `/baseline/visual-shift` 与目标 `/target/visual-shift`。两侧不会把自身 URL 渲染成页面内容。

首个视觉演示可使用路由 `/visual-shift`、桌面视口和默认视觉阈值。行为演示需要声明相应操作与断言；基准每案保存的 `plan.json` 是完整可执行示例。动态区域必须在 `normalization.maskSelectors` 显式声明 `#dynamic-noise`。

`config/acceptance/demo.json` 提供固定端口 `9087` 的六路由移动端演示计划，含菜单操作与断言、基线错误和动态遮罩。它用于浏览器演示；完整 18 案例及独立真值评测仍由基准脚本运行。

## 范围与后续验证

本基准不连接 Xspark 账号、数据库、支付、回调或外部 API，不证明真实业务状态机正确。夹具页面是未经构建的手写 HTML，源码行列与工程文件一致；经打包的项目定位结果是浏览器收到的产物行列，不能直接等同工程文件位置。源站与目标站均由仓库内部固定代码生成，没有代表性抽样。后续应使用用户批准的独立测试项目与人工标注数据集，分别报告页面、业务、环境和基线缺陷的检出率与误报，不能把本次 18 个案例的结果替代外部验收。
