# D6 fixed manual decisions · 项目验收报告

任务：ac-7f955228-09c2-4954-9009-d258019de41f
模式：regression；时间：2026-10-18T03:31:03.927Z → 2026-10-18T03:31:07.456Z
基线：http://127.0.0.1:61734/source?token=d6-source-url-sentinel
目标：http://127.0.0.1:61734/broken

计划指纹：75336a993c4c7b1daad709812a1f041da3c663a9372d7e036ef8ab61171c4430
验证器指纹：2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337

**门禁：阻断：发现缺陷**

声明检查 14，已形成结果 14，完成可靠判定 14。
通过 10；失败 4；阻塞 0；待复核 0；目标缺陷 4；基线失败 0；缺测 0。

仅验收已声明路由、视口、操作和有界观察窗口；未声明业务与接口契约为未测。单侧文档高度不超过12,000像素且面积不超过12,000,000像素时截图覆盖全页，两次稳定性截图采用相同范围。超过预算仅保留首屏证据，视觉检查标为待复核，不作为完整页面通过依据。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 2 | 0 | 2 | 0 | 0 | 72.36% |
| structure | 2 | 2 | 0 | 0 | 0 | 未测 |
| behavior | 2 | 0 | 2 | 0 | 0 | 未测 |
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
| route-1-1-desktop-point-1-menu | / | desktop | failed | bug | high |
| route-1-2-mobile-navigation | / | mobile | passed | match | medium |
| route-1-2-mobile-console | / | mobile | passed | match | high |
| route-1-2-mobile-network | / | mobile | passed | match | medium |
| route-1-2-mobile-overflow | / | mobile | passed | match | medium |
| route-1-2-mobile-structure | / | mobile | passed | match | high |
| route-1-2-mobile-visual | / | mobile | failed | bug | medium |
| route-1-2-mobile-point-1-menu | / | mobile | failed | bug | high |

## 问题与证据

### route-1-1-desktop-visual · 页面视觉还原度

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:61734/source?token=d6-source-url-sentinel"}
预期：{"minimumScore":0.97,"stabilityMinimum":0.9995,"maximumMaskedRatio":0.8,"captureBudget":{"maxPixels":12000000,"maxHeight":12000}}
实际：{"score":0.6787,"baselineStability":1,"targetStability":1,"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":614400,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":614400,"samplingCapped":false}},"capture":{"baseline":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":960,"height":640}},"target":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":960,"height":640}}},"eligible":true}

复现步骤：

1. Open http://127.0.0.1:61734/source?token=d6-source-url-sentinel at 960×640.
2. Open http://127.0.0.1:61734/broken in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-baseline.png
- targetScreenshot：route-1-1-desktop-target.png
- baselineDetails：route-1-1-desktop-baseline.json
- targetDetails：route-1-1-desktop-target.json
- baselineRepeat：route-1-1-desktop-baseline-repeat.png
- targetRepeat：route-1-1-desktop-target-repeat.png
- diff：route-1-1-desktop-diff.png

### route-1-1-desktop-point-1-menu · Expanded menu

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:61734/source?token=d6-source-url-sentinel"}
预期：{"stepsComplete":true,"assertions":[{"kind":"visible","selector":"#menu","expected":true,"actual":true,"passed":true},{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"true","passed":true},{"kind":"text","selector":"#literal","expected":"d6-captured-source-sentinel","actual":"d6-captured-source-sentinel","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"visible","selector":"#menu","expected":true,"actual":false,"passed":false},{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"false","passed":false},{"kind":"text","selector":"#literal","expected":"d6-captured-source-sentinel","actual":"d6-captured-source-sentinel","passed":true}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:61734/source?token=d6-source-url-sentinel at 960×640.
2. Open http://127.0.0.1:61734/broken in a fresh browser context at the same viewport.
3. fill #entry (d6-fill-sentinel)
4. click #menu-toggle

证据文件：

- baselineScreenshot：route-1-1-desktop-point-1-baseline.png
- targetScreenshot：route-1-1-desktop-point-1-target.png
- baselineDetails：route-1-1-desktop-point-1-baseline.json
- targetDetails：route-1-1-desktop-point-1-target.json
- baselineRepeat：route-1-1-desktop-point-1-baseline-repeat.png
- targetRepeat：route-1-1-desktop-point-1-target-repeat.png

### route-1-2-mobile-visual · 页面视觉还原度

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:61734/source?token=d6-source-url-sentinel"}
预期：{"minimumScore":0.97,"stabilityMinimum":0.9995,"maximumMaskedRatio":0.8,"captureBudget":{"maxPixels":12000000,"maxHeight":12000}}
实际：{"score":0.7685,"baselineStability":1,"targetStability":1,"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":304500,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":304500,"samplingCapped":false}},"capture":{"baseline":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":375,"height":812}},"target":{"captureScope":"full-page","captureLimited":false,"documentSize":{"width":375,"height":812}}},"eligible":true}

复现步骤：

1. Open http://127.0.0.1:61734/source?token=d6-source-url-sentinel at 375×812.
2. Open http://127.0.0.1:61734/broken in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-2-mobile-baseline.png
- targetScreenshot：route-1-2-mobile-target.png
- baselineDetails：route-1-2-mobile-baseline.json
- targetDetails：route-1-2-mobile-target.json
- baselineRepeat：route-1-2-mobile-baseline-repeat.png
- targetRepeat：route-1-2-mobile-target-repeat.png
- diff：route-1-2-mobile-diff.png

### route-1-2-mobile-point-1-menu · Expanded menu

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:61734/source?token=d6-source-url-sentinel"}
预期：{"stepsComplete":true,"assertions":[{"kind":"visible","selector":"#menu","expected":true,"actual":true,"passed":true},{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"true","passed":true},{"kind":"text","selector":"#literal","expected":"d6-captured-source-sentinel","actual":"d6-captured-source-sentinel","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"visible","selector":"#menu","expected":true,"actual":false,"passed":false},{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"false","passed":false},{"kind":"text","selector":"#literal","expected":"d6-captured-source-sentinel","actual":"d6-captured-source-sentinel","passed":true}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:61734/source?token=d6-source-url-sentinel at 375×812.
2. Open http://127.0.0.1:61734/broken in a fresh browser context at the same viewport.
3. fill #entry (d6-fill-sentinel)
4. click #menu-toggle

证据文件：

- baselineScreenshot：route-1-2-mobile-point-1-baseline.png
- targetScreenshot：route-1-2-mobile-point-1-target.png
- baselineDetails：route-1-2-mobile-point-1-baseline.json
- targetDetails：route-1-2-mobile-point-1-target.json
- baselineRepeat：route-1-2-mobile-point-1-baseline-repeat.png
- targetRepeat：route-1-2-mobile-point-1-target-repeat.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
