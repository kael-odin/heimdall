# Fresh regression Browser source binding · 项目验收报告

任务：ac-0fbee61e-2591-4565-a223-e193587780e7
模式：regression；时间：2026-10-18T03:11:32.059Z → 2026-10-18T03:11:35.250Z
基线：http://127.0.0.1:55806/baseline?build=approved&channel=stable
目标：http://127.0.0.1:55806/target?build=current&channel=development

计划指纹：39d65b0622b703f9a21735b91da6f35a37e15f4bde4b32e76adc6ce2fc985d1b
验证器指纹：2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337

**门禁：阻断：发现缺陷**

声明检查 14，已形成结果 14，完成可靠判定 14。
通过 12；失败 2；阻塞 0；待复核 0；目标缺陷 2；基线失败 0；缺测 0。

仅验收已声明路由、视口、操作和有界观察窗口；未声明业务与接口契约为未测。单侧文档高度不超过12,000像素且面积不超过12,000,000像素时截图覆盖全页，两次稳定性截图采用相同范围。超过预算仅保留首屏证据，视觉检查标为待复核，不作为完整页面通过依据。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 2 | 0 | 2 | 0 | 0 | 68.21% |
| structure | 2 | 2 | 0 | 0 | 0 | 未测 |
| behavior | 2 | 2 | 0 | 0 | 0 | 未测 |
| health | 8 | 8 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-desktop-navigation | / | desktop | passed | match | medium |
| route-1-1-desktop-console | / | desktop | passed | match | high |
| route-1-1-desktop-network | / | desktop | passed | match | medium |
| route-1-1-desktop-overflow | / | desktop | passed | match | medium |
| route-1-1-desktop-structure | / | desktop | passed | match | high |
| route-1-1-desktop-visual | / | desktop | failed | bug | medium |
| route-1-1-desktop-point-1-menu | / | desktop | passed | match | high |
| route-1-2-mobile-navigation | / | mobile | passed | match | medium |
| route-1-2-mobile-console | / | mobile | passed | match | high |
| route-1-2-mobile-network | / | mobile | passed | match | medium |
| route-1-2-mobile-overflow | / | mobile | passed | match | medium |
| route-1-2-mobile-structure | / | mobile | passed | match | high |
| route-1-2-mobile-visual | / | mobile | failed | bug | medium |
| route-1-2-mobile-point-1-menu | / | mobile | passed | match | high |

## 问题与证据

### route-1-1-desktop-visual · 页面视觉还原度

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:55806/baseline?build=approved&channel=stable"}
预期：{"minimumScore":0.97,"stabilityMinimum":0.9995,"maximumMaskedRatio":0.8,"captureBudget":{"maxPixels":12000000,"maxHeight":12000}}
实际：{"score":0.6709,"baselineStability":1,"targetStability":1,"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":614400,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":614400,"samplingCapped":false}},"capture":{"baseline":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":960,"height":640}},"target":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":960,"height":640}}},"eligible":true}

复现步骤：

1. Open http://127.0.0.1:55806/baseline?build=approved&channel=stable at 960×640.
2. Open http://127.0.0.1:55806/target?build=current&channel=development in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-baseline.png
- targetScreenshot：route-1-1-desktop-target.png
- baselineDetails：route-1-1-desktop-baseline.json
- targetDetails：route-1-1-desktop-target.json
- baselineRepeat：route-1-1-desktop-baseline-repeat.png
- targetRepeat：route-1-1-desktop-target-repeat.png
- diff：route-1-1-desktop-diff.png

### route-1-2-mobile-visual · 页面视觉还原度

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:55806/baseline?build=approved&channel=stable"}
预期：{"minimumScore":0.97,"stabilityMinimum":0.9995,"maximumMaskedRatio":0.8,"captureBudget":{"maxPixels":12000000,"maxHeight":12000}}
实际：{"score":0.6933,"baselineStability":1,"targetStability":1,"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":304500,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":304500,"samplingCapped":false}},"capture":{"baseline":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":375,"height":812}},"target":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":375,"height":812}}},"eligible":true}

复现步骤：

1. Open http://127.0.0.1:55806/baseline?build=approved&channel=stable at 375×812.
2. Open http://127.0.0.1:55806/target?build=current&channel=development in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-2-mobile-baseline.png
- targetScreenshot：route-1-2-mobile-target.png
- baselineDetails：route-1-2-mobile-baseline.json
- targetDetails：route-1-2-mobile-target.json
- baselineRepeat：route-1-2-mobile-baseline-repeat.png
- targetRepeat：route-1-2-mobile-target-repeat.png
- diff：route-1-2-mobile-diff.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
