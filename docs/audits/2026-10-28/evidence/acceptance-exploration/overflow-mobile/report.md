# 固定注入基准 · 移动端出现水平溢出 · 项目验收报告

任务：benchmark-2026-10-28T08-21-50-273Z-62a555ff-overflow-mobile
模式：mirror；时间：2026-10-28T08:23:53.283Z → 2026-10-28T08:23:54.775Z
基线：http://127.0.0.1:60701/baseline
目标：http://127.0.0.1:60701/target

**门禁：阻断：发现缺陷**

声明检查 6，已形成结果 6，完成可靠判定 4。
通过 3；失败 1；阻塞 2；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 1 | 0 | 0 | 1 | 0 | 未测 |
| structure | 1 | 0 | 0 | 1 | 0 | 未测 |
| behavior | 0 | 0 | 0 | 0 | 0 | 未测 |
| health | 4 | 3 | 1 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-mobile-navigation | /overflow-mobile | mobile | passed | match | medium |
| route-1-1-mobile-console | /overflow-mobile | mobile | passed | match | high |
| route-1-1-mobile-network | /overflow-mobile | mobile | passed | match | medium |
| route-1-1-mobile-overflow | /overflow-mobile | mobile | failed | bug | medium |
| route-1-1-mobile-structure | /overflow-mobile | mobile | blocked | environment | high |
| route-1-1-mobile-visual | /overflow-mobile | mobile | blocked | environment | medium |

## 问题与证据

### route-1-1-mobile-overflow · 视口水平溢出

结论：bug；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：[]
实际：{"observed":[{"kind":"overflow"}],"added":[{"kind":"overflow"}],"policyAffected":false}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/overflow-mobile at 390×844.
2. Open http://127.0.0.1:60701/target/overflow-mobile in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-mobile-baseline.png
- targetScreenshot：route-1-1-mobile-target.png
- baselineDetails：route-1-1-mobile-baseline.json
- targetDetails：route-1-1-mobile-target.json
- baselineRepeat：route-1-1-mobile-baseline-repeat.png
- targetRepeat：route-1-1-mobile-target-repeat.png

### route-1-1-mobile-structure · 标题、主标题与关键控件语义

结论：environment；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：{"title":"Heimdall 验收演示","headings":["团队项目概览"],"controls":[{"path":"#menu-toggle","tag":"button","role":null,"label":"菜单","type":"button","href":null,"disabled":false,"expanded":"false","selected":null},{"path":"#details-link","tag":"a","role":null,"label":"查看详情","type":null,"href":"/details","disabled":false,"expanded":null,"selected":null}]}
实际：{"title":"Heimdall 验收演示","headings":["团队项目概览"],"controls":[{"path":"#menu-toggle","tag":"button","role":null,"label":"菜单","type":"button","href":null,"disabled":false,"expanded":"false","selected":null},{"path":"#details-link","tag":"a","role":null,"label":"查看详情","type":null,"href":"/details","disabled":false,"expanded":null,"selected":null}],"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":329160,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":329160,"samplingCapped":false}}}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/overflow-mobile at 390×844.
2. Open http://127.0.0.1:60701/target/overflow-mobile in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-mobile-baseline.png
- targetScreenshot：route-1-1-mobile-target.png
- baselineDetails：route-1-1-mobile-baseline.json
- targetDetails：route-1-1-mobile-target.json
- baselineRepeat：route-1-1-mobile-baseline-repeat.png
- targetRepeat：route-1-1-mobile-target-repeat.png

### route-1-1-mobile-visual · 页面视觉还原度

结论：environment；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：{"minimumScore":0.97,"stabilityMinimum":0.9995,"maximumMaskedRatio":0.8,"captureBudget":{"maxPixels":12000000,"maxHeight":12000}}
实际：{"score":0.2353,"baselineStability":1,"targetStability":1,"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":329160,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":329160,"samplingCapped":false}},"capture":{"baseline":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":390,"height":844}},"target":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":1637,"height":844}}},"eligible":false}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/overflow-mobile at 390×844.
2. Open http://127.0.0.1:60701/target/overflow-mobile in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-mobile-baseline.png
- targetScreenshot：route-1-1-mobile-target.png
- baselineDetails：route-1-1-mobile-baseline.json
- targetDetails：route-1-1-mobile-target.json
- baselineRepeat：route-1-1-mobile-baseline-repeat.png
- targetRepeat：route-1-1-mobile-target-repeat.png
- diff：route-1-1-mobile-diff.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
