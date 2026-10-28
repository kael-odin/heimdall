# 固定注入基准 · 基线与目标共有基线脚本异常 · 项目验收报告

任务：benchmark-2026-10-28T08-21-50-273Z-62a555ff-baseline-error
模式：mirror；时间：2026-10-28T08:24:48.673Z → 2026-10-28T08:24:50.108Z
基线：http://127.0.0.1:60701/baseline
目标：http://127.0.0.1:60701/target

**门禁：阻断：存在未测/环境失败**

声明检查 6，已形成结果 6，完成可靠判定 3。
通过 3；失败 0；阻塞 2；待复核 1；目标缺陷 0；基线失败 3；缺测 0。

离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 1 | 0 | 0 | 1 | 0 | 未测 |
| structure | 1 | 0 | 0 | 1 | 0 | 未测 |
| behavior | 0 | 0 | 0 | 0 | 0 | 未测 |
| health | 4 | 3 | 0 | 0 | 1 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-desktop-navigation | /baseline-error | desktop | passed | match | medium |
| route-1-1-desktop-console | /baseline-error | desktop | needs_review | baseline_failed | high |
| route-1-1-desktop-network | /baseline-error | desktop | passed | match | medium |
| route-1-1-desktop-overflow | /baseline-error | desktop | passed | match | medium |
| route-1-1-desktop-structure | /baseline-error | desktop | blocked | baseline_failed | high |
| route-1-1-desktop-visual | /baseline-error | desktop | blocked | baseline_failed | medium |

## 问题与证据

### route-1-1-desktop-console · 浏览器脚本与控制台错误

结论：baseline_failed；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：[{"kind":"pageerror","message":"fixture: approved runtime script failed"}]
实际：{"observed":[{"kind":"pageerror","message":"fixture: approved runtime script failed"}],"added":[],"policyAffected":false}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/baseline-error at 1280×800.
2. Open http://127.0.0.1:60701/target/baseline-error in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-baseline.png
- targetScreenshot：route-1-1-desktop-target.png
- baselineDetails：route-1-1-desktop-baseline.json
- targetDetails：route-1-1-desktop-target.json
- baselineRepeat：route-1-1-desktop-baseline-repeat.png
- targetRepeat：route-1-1-desktop-target-repeat.png

### route-1-1-desktop-structure · 标题、主标题与关键控件语义

结论：baseline_failed；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：{"title":"Heimdall 验收演示","headings":["团队项目概览"],"controls":[{"path":"#menu-toggle","tag":"button","role":null,"label":"菜单","type":"button","href":null,"disabled":false,"expanded":"false","selected":null},{"path":"#details-link","tag":"a","role":null,"label":"查看详情","type":null,"href":"/details","disabled":false,"expanded":null,"selected":null}]}
实际：{"title":"Heimdall 验收演示","headings":["团队项目概览"],"controls":[{"path":"#menu-toggle","tag":"button","role":null,"label":"菜单","type":"button","href":null,"disabled":false,"expanded":"false","selected":null},{"path":"#details-link","tag":"a","role":null,"label":"查看详情","type":null,"href":"/details","disabled":false,"expanded":null,"selected":null}],"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":1024000,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":1024000,"samplingCapped":false}}}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/baseline-error at 1280×800.
2. Open http://127.0.0.1:60701/target/baseline-error in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-baseline.png
- targetScreenshot：route-1-1-desktop-target.png
- baselineDetails：route-1-1-desktop-baseline.json
- targetDetails：route-1-1-desktop-target.json
- baselineRepeat：route-1-1-desktop-baseline-repeat.png
- targetRepeat：route-1-1-desktop-target-repeat.png

### route-1-1-desktop-visual · 页面视觉还原度

结论：baseline_failed；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：{"minimumScore":0.97,"stabilityMinimum":0.9995,"maximumMaskedRatio":0.8,"captureBudget":{"maxPixels":12000000,"maxHeight":12000}}
实际：{"score":1,"baselineStability":1,"targetStability":1,"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":1024000,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":1024000,"samplingCapped":false}},"capture":{"baseline":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":1280,"height":800}},"target":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":1280,"height":800}}},"eligible":false}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/baseline-error at 1280×800.
2. Open http://127.0.0.1:60701/target/baseline-error in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-baseline.png
- targetScreenshot：route-1-1-desktop-target.png
- baselineDetails：route-1-1-desktop-baseline.json
- targetDetails：route-1-1-desktop-target.json
- baselineRepeat：route-1-1-desktop-baseline-repeat.png
- targetRepeat：route-1-1-desktop-target-repeat.png
- diff：route-1-1-desktop-diff.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
