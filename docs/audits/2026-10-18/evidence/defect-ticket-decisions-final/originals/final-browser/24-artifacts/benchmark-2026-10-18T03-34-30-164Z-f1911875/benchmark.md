# 固定注入缺陷基准

运行：benchmark-2026-10-18T03-34-30-164Z-f1911875
生成时间：2026-10-18T03:34:54.611Z

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
| 运行耗时 | 24447 ms |

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

## 证据

- [visual-shift 报告](visual-shift/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [mobile-menu 报告](mobile-menu/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [menu-state 报告](menu-state/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [missing-field 报告](missing-field/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [wrong-link 报告](wrong-link/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [runtime-error 报告](runtime-error/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [missing-resource 报告](missing-resource/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [identical 报告](identical/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [baseline-error 报告](baseline-error/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [masked-noise 报告](masked-noise/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [blocked-write 报告](blocked-write/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。

fixture、truth 和检测器均属于仓库内的固定演示材料，样本没有代表性抽样。这里的 precision / recall 只适用于这组注入案例，不可对外描述为真实项目检出率。基线错误及只读阻塞必须维持非通过状态；遮罩规则由计划显式声明。
