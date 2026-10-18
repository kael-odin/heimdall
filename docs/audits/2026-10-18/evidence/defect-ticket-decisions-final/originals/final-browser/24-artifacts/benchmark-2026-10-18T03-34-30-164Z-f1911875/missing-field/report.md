# 固定注入基准 · 套餐配额文字字段缺失 · 项目验收报告

任务：benchmark-2026-10-18T03-34-30-164Z-f1911875-missing-field
模式：mirror；时间：2026-10-18T03:34:37.245Z → 2026-10-18T03:34:42.367Z
基线：http://127.0.0.1:55191/baseline
目标：http://127.0.0.1:55191/target

**门禁：阻断：发现缺陷**

声明检查 7，已形成结果 7，完成可靠判定 7。
通过 6；失败 1；阻塞 0；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 1 | 1 | 0 | 0 | 0 | 99.88% |
| structure | 1 | 1 | 0 | 0 | 0 | 未测 |
| behavior | 1 | 0 | 1 | 0 | 0 | 未测 |
| health | 4 | 4 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-desktop-navigation | /missing-field | desktop | passed | match | medium |
| route-1-1-desktop-console | /missing-field | desktop | passed | match | high |
| route-1-1-desktop-network | /missing-field | desktop | passed | match | medium |
| route-1-1-desktop-overflow | /missing-field | desktop | passed | match | medium |
| route-1-1-desktop-structure | /missing-field | desktop | passed | match | high |
| route-1-1-desktop-visual | /missing-field | desktop | passed | match | medium |
| route-1-1-desktop-point-1-truth-missing-field | /missing-field | desktop | failed | bug | high |

## 问题与证据

### route-1-1-desktop-point-1-truth-missing-field · 套餐配额文字字段缺失

结论：bug；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:55191/baseline"}
预期：{"stepsComplete":true,"assertions":[{"kind":"text","selector":"#quota","expected":{"contains":"128 个任务"},"actual":"剩余配额：128 个任务","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"text","selector":"#quota","passed":false,"error":"locator.textContent: Timeout 2000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#quota').first()\u001b[22m\n"}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:55191/baseline/missing-field at 1280×800.
2. Open http://127.0.0.1:55191/target/missing-field in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-point-1-baseline.png
- targetScreenshot：route-1-1-desktop-point-1-target.png
- baselineDetails：route-1-1-desktop-point-1-baseline.json
- targetDetails：route-1-1-desktop-point-1-target.json
- baselineRepeat：route-1-1-desktop-point-1-baseline-repeat.png
- targetRepeat：route-1-1-desktop-point-1-target-repeat.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
