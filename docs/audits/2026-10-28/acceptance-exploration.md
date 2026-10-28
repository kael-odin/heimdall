# 自动验收：元素定位与基线探索候选验收点

日期：2026-10-28。本次在比赛方向（[工作台指南](../../competition/acceptance-workbench.md)、[固定测试集](../../competition/acceptance-demo.md)、[赛题方案](../../competition/02-自动验收开发项目还原度BUG检测系统.md)）上补了两层证据能力：
验收失败后**落到元素和源码行**，以及从**基线自动生成候选验收点**。两者都是旁路模块，不改执行器、报告与核验指纹，也不改变历史运行的“可比”判定。

## 已交付

| 能力 | 当前实现 |
| --- | --- |
| 元素定位 | 对每个可靠失败（verdict 为 bug）的检查，用与运行相同的只读浏览器配置重新渲染两侧，输出元素、样式/脚本/标记差异与源码行列。分类：样式属性差异、被隐藏控件、属性差异、交互处理脚本、缺失字段的插入点、脚本异常、资源失败。 |
| 定位持久化 | 旁路 `localization.json` 写入运行目录，`report.json`、门禁、验证器指纹不变；`localizationAvailable` 只作展示标记。 |
| 定位接口 | `POST/GET /api/acceptance/runs/:id/localization`；同一引擎一次只定位一份，运行未完成 409，托管运行返回 503 `MANAGED_EXECUTION_REQUIRED`。 |
| 基线探索 | `POST /api/acceptance/explore` 与 `node core/src/acceptance/cli.mjs --explore plan.json`：只访问基线，逐控件单步点击/填写，把操作前后地址、可见性、文本、状态属性的变化写成断言，只保留“操作前不成立、操作后成立、每个计划视口重放仍成立”的断言；短文案另组成内容验收点。 |
| 控制台 | 高级区“从基线生成候选验收点”把候选合并进验收点 JSON（按路由/步骤/断言去重），由人审阅后再运行。验收报告新增“元素定位”面板，可按需生成、刷新恢复。 |
| 基准 | 第二个基准臂只用自动生成的验收点，与手写点臂、元素定位命中率一起输出。 |

新增模块 `core/src/acceptance/localize.mjs`（约 1,000 行）与 `core/src/acceptance/explore.mjs`（约 540 行）；`store.mjs`、`run-view.mjs`、`engine-server.mjs`、`console/src/AcceptanceWorkbench.vue`、`console/src/acceptance-workbench.js`、`core/scripts/benchmark-acceptance.mjs` 与 smoke 接入。

## 基准结果（离线复现）

运行：`core/workspace/_runs/acceptance-benchmark/benchmark-2026-10-28T08-21-50-273Z-62a555ff`，总耗时 **195.415 秒**，基准门禁通过。样本单位是案例，18 个固定注入案例（13 个已知目标 BUG、5 个非 BUG）。

| 指标 | 结果 | 分母 |
| --- | ---: | --- |
| 手写点臂 TP / FP / FN / TN | 13 / 0 / 0 / 5 | 独立案例 |
| 手写点臂 Precision / Recall | 100% / 100% | 预测缺陷 / 已知缺陷 |
| 元素定位源码命中 | 13 / 13 | 检出的已知 BUG 案例 |
| 自动点臂检出 / 误报 | 13 / 0 | 已知 BUG 案例 / 非 BUG 案例 |
| 自动点臂案例校验通过 | 18 / 18 | 全部案例 |
| 自动点臂生成验收点 | 48 | 每条案例一条路由 |
| 单案验收耗时 P50 / P95 | 1,484 ms / 5,134 ms | 18 个案例 |
| 单案定位耗时 P50 / P95 | 470 ms / 1,078 ms | 13 个案例 |

16 个有可探索控件的案例各生成 3 个点（点击菜单、点击详情链接、配额文案，共 48 个）；`baseline-error` 与 `blocked-write` 的基线本身有脚本错误或写请求，探索直接报告 `baseline-unhealthy`，不生成点也不误报。新增案例覆盖了标题、主标题、无障碍名称、移动端水平溢出、坏链接、纯布局平移与控制台警告：前五类由结构或运行健康检查检出，`tablet-shift` 在 0.995 的严格视觉阈值下检出，`console-warning` 确认只有警告不会误报。

`menu-state` 与 `missing-field` 是手写点之外最能说明问题的两个案例：前者只有交互后的 `aria-expanded` 状态能发现，后者只有结构检查不比较的段落文案能发现，自动生成的断言都检出了。

元素定位在 `wrong-link` 上同时覆盖结构与行为两条检查，均指向 `href="pricing"` 标签；`mobile-menu` 指向 `@media(max-width:600px){#menu-toggle{display:none}}`；`menu-state` 指向点击处理脚本，并给出“目标处理函数缺少 `this.setAttribute('aria-expanded', …)`”；`missing-field` 锚定到基线相邻的 `.metric` 元素。

## 控制台闭环（离线受控夹具）

`pnpm acceptance:smoke`（真实控制台构建产物 → 隔离数据根 → 真实引擎）：

- 在高级区点击“从基线生成候选验收点”，断言点 JSON 中出现 `#menu-toggle` 的点击点且每个点至少一条断言；随后人工改写为显式点并运行，既有流程不变。
- 验收后请求元素定位，断言每个可靠失败都到源码位置、门禁仍为 `failed`、刷新后恢复。
- 结果保存在 `core/workspace/_runs/acceptance-console/`（`browser-checks.json`、`acceptance-localization.json`、截图）。

## 边界

- 定位坐标是浏览器实际收到的 HTML、样式表或脚本行列，未接 source map；打包项目需自行映射回工程文件。
- 定位靠运行后重新渲染；含时间、随机数或登录态内容时可能复现不出原失败，此时只记“未复现”，不改结论。
- 探索只覆盖单步点击与填写，跳过破坏性名称、写请求、外链、下载、新窗口与下拉选择；只把基线行为当预期，基线自身做错的交互也会被写成断言，必须人工审阅。
- 探索与定位都不访问未声明路由，不保存截图，不进入运行目录以外的位置。
- 本次样本是仓库内固定夹具，不能推广为真实项目检出率。GitHub Actions 自 2026-10-26 起因账号计费禁用，本次只做本机验证：全量 `pnpm test`、`pnpm lint`、`pnpm docs:links`、`pnpm acceptance:benchmark` 与 `pnpm acceptance:smoke`。

## 证据

- [基准 JSON](evidence/acceptance-exploration/benchmark.json)、[基准 Markdown](evidence/acceptance-exploration/benchmark.md)、[真值](evidence/acceptance-exploration/truth.json)
- 自动点臂样例：[menu-state 计划](evidence/acceptance-exploration/auto-menu-state-plan.json)、[探索结果](evidence/acceptance-exploration/auto-menu-state-exploration.json)
- 元素定位样例：[menu-state 定位](evidence/acceptance-exploration/menu-state-localization.json)、[overflow-mobile 定位](evidence/acceptance-exploration/overflow-mobile-localization.json)
- 控制台 smoke：[检查结果](evidence/acceptance-exploration/smoke-browser-checks.json)、[定位结果](evidence/acceptance-exploration/smoke-localization.json)
