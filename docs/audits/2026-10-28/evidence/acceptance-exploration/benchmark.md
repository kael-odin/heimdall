# 固定注入缺陷基准

运行：benchmark-2026-10-28T08-21-50-273Z-62a555ff
生成时间：2026-10-28T08:25:05.688Z

**离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。**

基准门禁：通过；案例验收通过 18/18。

## 计算口径

统计单位是独立案例；一个案例产生多条检查或多张截图，仍只计一个样本。已知目标 BUG 分母 13，非目标 BUG 分母 5，总案例 18。

- TP：已知目标 BUG 案例中至少一条检查归因为 BUG。
- FP：非目标 BUG 案例被至少一条检查归因为 BUG。
- FN：已知目标 BUG 案例没有被识别；执行失败、未测与阻塞均不能免除漏检。
- TN：非目标 BUG 案例没有被误报为 BUG。TN 只表示无误报，仍须通过案例预期分类和门禁校验。

| 指标 | 数值 |
| --- | ---: |
| TP / FP / FN / TN | 13 / 0 / 0 / 5 |
| Precision = TP / (TP + FP) | 100.00% |
| Recall = TP / 已知目标 BUG 案例 | 100.00% |
| False positive rate = FP / 非目标 BUG 案例 | 0.00% |
| 单案验收耗时 P50 / P95 | 1484 ms / 5134 ms |
| 运行耗时 | 195415 ms |

## 元素定位

对每个检出的已知 BUG 案例，在验收结束后重新渲染双方页面，把失败检查落到元素和源码行（旁路 `localization.json`，不改报告与核验指纹）。分母是检出的已知 BUG 案例 13 个。

- 命中源码：定位结果里有与注入点同类、同元素的发现，且其源码摘录含注入文本、带行号。
- 仅元素：找到了同类同元素的发现，但源码位置或摘录不对。
- 未命中：没有同类同元素的发现，或定位执行失败。

| 指标 | 数值 |
| --- | ---: |
| 命中源码 / 仅元素 / 未命中 | 13 / 0 / 0 |
| 源码命中率 = 命中源码 / 检出的已知 BUG 案例 | 100.00% |
| 单案定位耗时 P50 / P95 | 470 ms / 1078 ms |

| 案例 | 定位结果 | 指向 |
| --- | --- | --- |
| visual-shift | 源码 | style body > main:nth-of-type(1) → /target/visual-shift:11:6 `main{transform:translateY(160px)}.panel{background:#8f2500;border-color:#6d1b00;color:#fff` |
| mobile-menu | 源码 | hidden #menu-toggle → /target/mobile-menu:11:38 `@media(max-width:600px){#menu-toggle{display:none}}` |
| menu-state | 源码 | handler #menu-toggle → /target/menu-state:15:123 `…ggle').addEventListener('click',function(){const menu=document.getElementById('menu');men` |
| missing-field | 源码 | missing #quota → /target/missing-field:14:55 `…="panel"><span class="badge">运行正常</span><div class="metric">128</div><a id="details-link"` |
| wrong-link | 源码 | attribute #details-link → /target/wrong-link:14:161 `…个任务</p><a id="details-link" class="cta" href="pricing">查看详情</a></section>` |
| runtime-error | 源码 | script-error  → /target/runtime-error:15:275 `…!menu.hidden));});setTimeout(()=>{throw new Error('fixture: approved runtime script faile` |
| missing-resource | 源码 | resource  → /target/missing-resource:15:43 `…ooter>固定离线夹具 · 不包含真实客户数据</footer></main><script src="missing-widget.js"></script><script>` |
| title-change | 源码 | text title → /target/title-change:1:161 `…scale=1"><link rel="icon" href="data:,"><title>Heimdall 验收演示 · 新版</title><style>` |
| heading-change | 源码 | text h1 #1 → /target/heading-change:13:11 `<main><h1>团队项目总览</h1><p class="subtitle">面向团队的开发交付状态</p><nav id="menu" class="menu" hidden` |
| aria-label-change | 源码 | attribute #menu-toggle → /target/aria-label-change:12:84 `…><button id="menu-toggle" type="button" aria-label="主菜单" aria-expanded="false" aria-contr` |
| overflow-mobile | 源码 | overflow #wide → /target/overflow-mobile:11:7 `.wide{width:1600px;height:10px;background:#fca5a5}` |
| broken-link | 源码 | attribute #details-link → /target/broken-link:14:161 `…个任务</p><a id="details-link" class="cta" href="gone">查看详情</a></section>` |
| tablet-shift | 源码 | style body > main:nth-of-type(1) → /target/tablet-shift:11:6 `main{transform:translateY(120px)}` |

## 自动生成验收点

第二个基准臂只使用**自动生成的验收点**：在每条案例的基线上逐页探索可见控件，把单步点击/填写前后可观察的变化写成断言，按执行器语义在计划视口上重放，只保留稳定成立的断言；不加入任何手写验收点。默认检查（导航、运行健康、结构、视觉）仍然执行。回放证据在 `auto/<案例>/`。

该臂共生成 48 个验收点；已知目标 BUG 案例 13 个被检出，非目标 BUG 案例误报 0 个，案例校验通过 18/18。

| 案例 | 自动点 | 检出 | 门禁 | 案例校验 | 问题 |
| --- | ---: | --- | --- | --- | --- |
| visual-shift | 3 | BUG | failed | 通过 |  |
| mobile-menu | 3 | BUG | failed | 通过 |  |
| menu-state | 3 | BUG | failed | 通过 |  |
| missing-field | 3 | BUG | failed | 通过 |  |
| wrong-link | 3 | BUG | failed | 通过 |  |
| runtime-error | 3 | BUG | failed | 通过 |  |
| missing-resource | 3 | BUG | failed | 通过 |  |
| title-change | 3 | BUG | failed | 通过 |  |
| heading-change | 3 | BUG | failed | 通过 |  |
| aria-label-change | 3 | BUG | failed | 通过 |  |
| overflow-mobile | 3 | BUG | failed | 通过 |  |
| broken-link | 3 | BUG | failed | 通过 |  |
| tablet-shift | 3 | BUG | failed | 通过 |  |
| console-warning | 3 | 无 BUG | passed | 通过 |  |
| identical | 3 | 无 BUG | passed | 通过 |  |
| baseline-error | 0 | 无 BUG | blocked | 通过 |  |
| masked-noise | 3 | 无 BUG | passed | 通过 |  |
| blocked-write | 0 | 无 BUG | blocked | 通过 |  |

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
| title-change · 页面标题与基线不一致 | 目标 BUG | BUG | failed | 通过 |  |
| heading-change · 主标题文案被改写 | 目标 BUG | BUG | failed | 通过 |  |
| aria-label-change · 菜单按钮的无障碍名称改变 | 目标 BUG | BUG | failed | 通过 |  |
| overflow-mobile · 移动端出现水平溢出 | 目标 BUG | BUG | failed | 通过 |  |
| broken-link · 详情链接指向不存在的页面 | 目标 BUG | BUG | failed | 通过 |  |
| tablet-shift · 平板视口的内容布局偏移 | 目标 BUG | BUG | failed | 通过 |  |
| console-warning · 目标只输出控制台警告 | match | 无 BUG | passed | 通过 |  |
| identical · 稳定一致页面 | match | 无 BUG | passed | 通过 |  |
| baseline-error · 基线与目标共有基线脚本异常 | baseline_failed | 无 BUG | blocked | 通过 |  |
| masked-noise · 动态刷新区按已声明规则遮罩 | match | 无 BUG | passed | 通过 |  |
| blocked-write · 依赖写请求的流程被只读策略阻断 | environment | 无 BUG | blocked | 通过 |  |

## 证据

- [visual-shift 报告](visual-shift/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](visual-shift/localization.md)。
- [mobile-menu 报告](mobile-menu/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](mobile-menu/localization.md)。
- [menu-state 报告](menu-state/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](menu-state/localization.md)。
- [missing-field 报告](missing-field/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](missing-field/localization.md)。
- [wrong-link 报告](wrong-link/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](wrong-link/localization.md)。
- [runtime-error 报告](runtime-error/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](runtime-error/localization.md)。
- [missing-resource 报告](missing-resource/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](missing-resource/localization.md)。
- [title-change 报告](title-change/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](title-change/localization.md)。
- [heading-change 报告](heading-change/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](heading-change/localization.md)。
- [aria-label-change 报告](aria-label-change/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](aria-label-change/localization.md)。
- [overflow-mobile 报告](overflow-mobile/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](overflow-mobile/localization.md)。
- [broken-link 报告](broken-link/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](broken-link/localization.md)。
- [tablet-shift 报告](tablet-shift/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。[元素定位](tablet-shift/localization.md)。
- [console-warning 报告](console-warning/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [identical 报告](identical/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [baseline-error 报告](baseline-error/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [masked-noise 报告](masked-noise/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。
- [blocked-write 报告](blocked-write/report.md)：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。

fixture、truth 和检测器均属于仓库内的固定演示材料，样本没有代表性抽样。这里的 precision / recall 只适用于这组注入案例，不可对外描述为真实项目检出率。基线错误及只读阻塞必须维持非通过状态；遮罩规则由计划显式声明。
