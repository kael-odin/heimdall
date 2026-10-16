# 固定注入缺陷基准

运行：benchmark-2026-10-16T08-58-25-792Z-03a991f9
生成时间：2026-10-16T08:58:50.834Z

**离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。**

基准门禁：通过；案例验收通过 11/11。

## 计算口径

统计单位是独立案例；一个案例产生多条检查或多张截图，仍只计一个样本。已知目标 BUG 分母 7，非目标 BUG 分母 4，总案例 11。

- TP：已知目标 BUG 案例中至少一条检查归因为 BUG。
- FP：非目标 BUG 案例被至少一条检查归因为 BUG。
- FN：已知目标 BUG 案例没有被识别；执行失败、未测与阻塞均不能免除漏检。
- TN：非目标 BUG 案例没有被误报为 BUG。TN 只表示无误报，仍须通过案例预期分类和门禁校验。

| 指标 | 数值 |
| --- | ---: |
| TP / FP / FN / TN | 7 / 0 / 0 / 4 |
| Precision = TP / (TP + FP) | 100.00% |
| Recall = TP / 已知目标 BUG 案例 | 100.00% |
| False positive rate = FP / 非目标 BUG 案例 | 0.00% |
| 运行耗时 | 25042 ms |

## 案例结果

| 案例 | 真值 | 检出 | 门禁 | 案例校验 | 问题 |
| --- | --- | --- | --- | --- | --- |
| visual-shift · 目标主要内容布局偏移 | 目标 BUG | BUG | failed | 通过 |  |
| mobile-menu · 移动端菜单按钮缺失 | 目标 BUG | BUG | failed | 通过 |  |
| menu-state · 菜单展开但 aria-expanded 未更新 | 目标 BUG | BUG | failed | 通过 |  |
| missing-field · 套餐配额文字字段缺失 | 目标 BUG | BUG | failed | 通过 |  |
| wrong-link · 查看详情跳向错误页面 | 目标 BUG | BUG | failed | 通过 |  |
| runtime-error · 目标脚本抛出异常 | 目标 BUG | BUG | failed | 通过 |  |
| missing-resource · 目标静态资源返回 404 | 目标 BUG | BUG | failed | 通过 |  |
| identical · 稳定一致页面 | match | 无 BUG | passed | 通过 |  |
| baseline-error · 基线与目标共有基线脚本异常 | baseline_failed | 无 BUG | blocked | 通过 |  |
| masked-noise · 动态刷新区按已声明规则遮罩 | match | 无 BUG | passed | 通过 |  |
| blocked-write · 依赖写请求的流程被只读策略阻断 | environment | 无 BUG | blocked | 通过 |  |

## 精简证据归档说明

本目录仅保存 benchmark.json、benchmark.md、truth.json，包含本次指标、全部 11 个案例的检测结果与真值。逐案报告和截图没有复制到此归档；本文不链接未归档的案例目录。

完整原始证据保留于本机运行目录：

D:\Github-Star\heimdall\core\workspace\_runs\acceptance-benchmark\benchmark-2026-10-16T08-58-25-792Z-03a991f9

其中包含每案的 plan.json、report.json、report.md、双方截图、重复截图、差异图和 DOM/网络/console 摘要。运行使用随机临时端口，结束后已关闭 fixture 服务器；原始 plan.json 中的地址属于复现历史，不是长期可用服务。需要复验时从仓库根目录执行 node core/scripts/benchmark-acceptance.mjs，重新生成本次临时服务与证据。

证据等级：离线复现。fixture、truth 和检测器均属于仓库内固定演示材料，没有代表性抽样；precision / recall 只适用于这 11 个案例，不代表真实站点业务验收或通用检出率。基线错误与只读阻塞维持非通过状态，动态遮罩由计划显式声明。
