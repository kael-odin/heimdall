# 固定注入基准 · 平板视口的内容布局偏移 · 项目验收报告

任务：benchmark-2026-10-28T08-21-50-273Z-62a555ff-tablet-shift
模式：mirror；时间：2026-10-28T08:24:17.367Z → 2026-10-28T08:24:18.738Z
基线：http://127.0.0.1:60701/baseline
目标：http://127.0.0.1:60701/target

**门禁：阻断：发现缺陷**

声明检查 6，已形成结果 6，完成可靠判定 6。
通过 5；失败 1；阻塞 0；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 1 | 0 | 1 | 0 | 0 | 98.16% |
| structure | 1 | 1 | 0 | 0 | 0 | 未测 |
| behavior | 0 | 0 | 0 | 0 | 0 | 未测 |
| health | 4 | 4 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-tablet-navigation | /tablet-shift | tablet | passed | match | medium |
| route-1-1-tablet-console | /tablet-shift | tablet | passed | match | high |
| route-1-1-tablet-network | /tablet-shift | tablet | passed | match | medium |
| route-1-1-tablet-overflow | /tablet-shift | tablet | passed | match | medium |
| route-1-1-tablet-structure | /tablet-shift | tablet | passed | match | high |
| route-1-1-tablet-visual | /tablet-shift | tablet | failed | bug | medium |

## 问题与证据

### route-1-1-tablet-visual · 页面视觉还原度

结论：bug；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：{"minimumScore":0.995,"stabilityMinimum":0.9995,"maximumMaskedRatio":0.8,"captureBudget":{"maxPixels":12000000,"maxHeight":12000}}
实际：{"score":0.9816,"baselineStability":1,"targetStability":1,"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":786432,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":786432,"samplingCapped":false}},"capture":{"baseline":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":768,"height":1024}},"target":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":768,"height":1024}}},"eligible":true}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/tablet-shift at 768×1024.
2. Open http://127.0.0.1:60701/target/tablet-shift in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-tablet-baseline.png
- targetScreenshot：route-1-1-tablet-target.png
- baselineDetails：route-1-1-tablet-baseline.json
- targetDetails：route-1-1-tablet-target.json
- baselineRepeat：route-1-1-tablet-baseline-repeat.png
- targetRepeat：route-1-1-tablet-target-repeat.png
- diff：route-1-1-tablet-diff.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
