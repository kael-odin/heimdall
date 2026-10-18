# Renamed browser run · 项目验收报告

任务：ac-1f6dd565-d172-4e26-9f27-5ca1bf953019
模式：regression；时间：2026-10-18T03:35:12.871Z → 2026-10-18T03:35:16.508Z
基线：http://127.0.0.1:52299/browser/reference
目标：http://127.0.0.1:52299/browser/after

计划指纹：9dd9319bcfafcfc0e934e32f68c3d78653fccce01ac477387417ac3d071665fe
验证器指纹：2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337

**门禁：阻断：发现缺陷**

声明检查 14，已形成结果 14，完成可靠判定 14。
通过 13；失败 1；阻塞 0；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

离线复现：本机固定版本、缺陷和假关闭反例，通过真实 browser/Spec runner、store 落盘与当前证据校验完成；只证明本组声明范围，不代表真实项目检出率、根因识别或持久缺陷自动关闭。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 2 | 2 | 0 | 0 | 0 | 99.97% |
| structure | 2 | 2 | 0 | 0 | 0 | 未测 |
| behavior | 2 | 1 | 1 | 0 | 0 | 未测 |
| health | 8 | 8 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-desktop-only-navigation | /details | desktop-only | passed | match | medium |
| route-1-1-desktop-only-console | /details | desktop-only | passed | match | high |
| route-1-1-desktop-only-network | /details | desktop-only | passed | match | medium |
| route-1-1-desktop-only-overflow | /details | desktop-only | passed | match | medium |
| route-1-1-desktop-only-structure | /details | desktop-only | passed | match | high |
| route-1-1-desktop-only-visual | /details | desktop-only | passed | match | medium |
| route-1-1-desktop-only-point-1-copy | /details | desktop-only | failed | bug | low |
| route-2-1-desktop-only-navigation | /home | desktop-only | passed | match | medium |
| route-2-1-desktop-only-console | /home | desktop-only | passed | match | high |
| route-2-1-desktop-only-network | /home | desktop-only | passed | match | medium |
| route-2-1-desktop-only-overflow | /home | desktop-only | passed | match | medium |
| route-2-1-desktop-only-structure | /home | desktop-only | passed | match | high |
| route-2-1-desktop-only-visual | /home | desktop-only | passed | match | medium |
| route-2-1-desktop-only-point-2-toggle | /home | desktop-only | passed | match | low |

## 问题与证据

### route-1-1-desktop-only-point-1-copy · Renamed point

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:52299/browser/reference"}
预期：{"stepsComplete":true,"assertions":[{"kind":"text","selector":"#copy","expected":"Ready","actual":"Ready","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"text","selector":"#copy","expected":"Ready","actual":"Unexpected value","passed":false}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:52299/browser/reference/details at 960×720.
2. Open http://127.0.0.1:52299/browser/after/details in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-only-point-1-baseline.png
- targetScreenshot：route-1-1-desktop-only-point-1-target.png
- baselineDetails：route-1-1-desktop-only-point-1-baseline.json
- targetDetails：route-1-1-desktop-only-point-1-target.json
- baselineRepeat：route-1-1-desktop-only-point-1-baseline-repeat.png
- targetRepeat：route-1-1-desktop-only-point-1-target-repeat.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
