# Mirror 自动验收固定演示与检出基准

这套演示把一个健康基线与一个注入差异的目标项目放在本地浏览器中实际运行，展示视觉、结构、行为、脚本与资源问题的定位，以及基线自身错误和只读阻塞的归因。

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

脚本自启仅绑定 `127.0.0.1` 的随机端口服务器；对每个案例用一个对应视口执行验收，最后关闭服务器。每次结果写入独立时间戳目录，默认父目录为 `core/workspace/_runs/acceptance-benchmark`。`latest.json` 指向最近一次运行。每案包含计划、JSON/Markdown 报告、双方截图、重复截图、差异图及 DOM/console/网络摘要。

有误报、漏检、错误归因、覆盖缺失或门禁不符合案例真值时，进程退出码为 `1`。执行失败、未测和阻塞不能算通过。

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
| `identical` | 相同 DOM、CSS、内容和行为 | 否 | 无 BUG 且通过 |
| `baseline-error` | 两侧都保留批准基线自身的脚本异常 | 否 | `baseline_failed`，不能通过 |
| `masked-noise` | 刷新批次及背景持续变化，计划显式遮罩对应区域 | 否 | 遮罩后无 BUG 且通过 |
| `blocked-write` | 两侧依赖 POST，默认只读策略阻断请求 | 否 | `environment`，不能通过 |

总分母是 11 个独立案例，其中已知目标 BUG 分母为 7，非目标 BUG 分母为 4。Precision 为 `TP / (TP + FP)`，Recall 为 `TP / 7`，误报率为 `FP / 4`。每案只要任一检查归因为 BUG，就算该案预测为 BUG；未测成的已知 BUG 计漏检。非 BUG 案例即使没有误报，也必须满足预期分类与门禁才能通过基准。

真值位于 `core/test/fixtures/acceptance-site.mjs` 的 `ACCEPTANCE_FIXTURE_CASES`，基准脚本会复制为本次证据目录中的 `truth.json`。检测器不能用案例真值决定结论；真值仅供检测完成后的独立评估。

## 控制台演示

可单独启动固定端口服务器：

```powershell
node core/test/fixtures/acceptance-site.mjs 9087
```

将输出中的 `baselineUrl` 和 `targetUrl` 填到验收工作台。路由相对于入口路径解析，例如 `/visual-shift` 对应基线 `/baseline/visual-shift` 与目标 `/target/visual-shift`。两侧不会把自身 URL 渲染成页面内容。

首个视觉演示可使用路由 `/visual-shift`、桌面视口和默认视觉阈值。行为演示需要声明相应操作与断言；基准每案保存的 `plan.json` 是完整可执行示例。动态区域必须在 `normalization.maskSelectors` 显式声明 `#dynamic-noise`。

`config/acceptance/demo.json` 提供固定端口 `9087` 的六路由移动端演示计划，含菜单操作与断言、基线错误和动态遮罩。它用于浏览器演示；完整 11 案例及独立真值评测仍由基准脚本运行。

## 范围与后续验证

本基准不连接 Xspark 账号、数据库、支付、回调或外部 API，不证明真实业务状态机正确。源站与目标站均由仓库内部固定代码生成，没有代表性抽样。后续应使用用户批准的独立测试项目与人工标注数据集，分别报告页面、业务、环境和基线缺陷的检出率与误报，不能把本次 11 个案例的结果替代外部验收。
