# Renamed browser run · 项目验收报告

任务：ac-62a23a6e-7182-4d2a-b6e6-9b56ccac6836
模式：regression；时间：2026-10-16T12:12:22.308Z → 2026-10-16T12:12:29.352Z
基线：http://127.0.0.1:53572/browser/reference
目标：http://127.0.0.1:53572/browser/after

计划指纹：c9cc2b4dad3be55fe667c595c8b2e0b438dfa43c7581adbf7baa555f44c18ed3
验证器指纹：8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d

**门禁：阻断：发现缺陷**

声明检查 28，已形成结果 28，完成可靠判定 28。
通过 26；失败 2；阻塞 0；待复核 0；目标缺陷 2；基线失败 0；缺测 0。

离线复现：本机固定版本、缺陷和假关闭反例，通过真实 browser/Spec runner、store 落盘与当前证据校验完成；只证明本组声明范围，不代表真实项目检出率、根因识别或持久缺陷自动关闭。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 4 | 4 | 0 | 0 | 0 | 99.95% |
| structure | 4 | 4 | 0 | 0 | 0 | 未测 |
| behavior | 4 | 2 | 2 | 0 | 0 | 未测 |
| health | 16 | 16 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-wide-renamed-navigation | /details | wide-renamed | passed | match | medium |
| route-1-1-wide-renamed-console | /details | wide-renamed | passed | match | high |
| route-1-1-wide-renamed-network | /details | wide-renamed | passed | match | medium |
| route-1-1-wide-renamed-overflow | /details | wide-renamed | passed | match | medium |
| route-1-1-wide-renamed-structure | /details | wide-renamed | passed | match | high |
| route-1-1-wide-renamed-visual | /details | wide-renamed | passed | match | medium |
| route-1-1-wide-renamed-point-1-copy | /details | wide-renamed | failed | bug | low |
| route-1-2-phone-renamed-navigation | /details | phone-renamed | passed | match | medium |
| route-1-2-phone-renamed-console | /details | phone-renamed | passed | match | high |
| route-1-2-phone-renamed-network | /details | phone-renamed | passed | match | medium |
| route-1-2-phone-renamed-overflow | /details | phone-renamed | passed | match | medium |
| route-1-2-phone-renamed-structure | /details | phone-renamed | passed | match | high |
| route-1-2-phone-renamed-visual | /details | phone-renamed | passed | match | medium |
| route-1-2-phone-renamed-point-1-copy | /details | phone-renamed | failed | bug | low |
| route-2-1-wide-renamed-navigation | /home | wide-renamed | passed | match | medium |
| route-2-1-wide-renamed-console | /home | wide-renamed | passed | match | high |
| route-2-1-wide-renamed-network | /home | wide-renamed | passed | match | medium |
| route-2-1-wide-renamed-overflow | /home | wide-renamed | passed | match | medium |
| route-2-1-wide-renamed-structure | /home | wide-renamed | passed | match | high |
| route-2-1-wide-renamed-visual | /home | wide-renamed | passed | match | medium |
| route-2-1-wide-renamed-point-2-toggle | /home | wide-renamed | passed | match | low |
| route-2-2-phone-renamed-navigation | /home | phone-renamed | passed | match | medium |
| route-2-2-phone-renamed-console | /home | phone-renamed | passed | match | high |
| route-2-2-phone-renamed-network | /home | phone-renamed | passed | match | medium |
| route-2-2-phone-renamed-overflow | /home | phone-renamed | passed | match | medium |
| route-2-2-phone-renamed-structure | /home | phone-renamed | passed | match | high |
| route-2-2-phone-renamed-visual | /home | phone-renamed | passed | match | medium |
| route-2-2-phone-renamed-point-2-toggle | /home | phone-renamed | passed | match | low |

## 问题与证据

### route-1-1-wide-renamed-point-1-copy · Renamed point

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:53572/browser/reference"}
预期：{"stepsComplete":true,"assertions":[{"kind":"text","selector":"#copy","expected":"Ready","actual":"Ready","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"text","selector":"#copy","expected":"Ready","actual":"Unexpected value","passed":false}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:53572/browser/reference/details at 960×720.
2. Open http://127.0.0.1:53572/browser/after/details in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-wide-renamed-point-1-baseline.png
- targetScreenshot：route-1-1-wide-renamed-point-1-target.png
- baselineDetails：route-1-1-wide-renamed-point-1-baseline.json
- targetDetails：route-1-1-wide-renamed-point-1-target.json
- baselineRepeat：route-1-1-wide-renamed-point-1-baseline-repeat.png
- targetRepeat：route-1-1-wide-renamed-point-1-target-repeat.png

### route-1-2-phone-renamed-point-1-copy · Renamed point

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:53572/browser/reference"}
预期：{"stepsComplete":true,"assertions":[{"kind":"text","selector":"#copy","expected":"Ready","actual":"Ready","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"text","selector":"#copy","expected":"Ready","actual":"Unexpected value","passed":false}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:53572/browser/reference/details at 375×812.
2. Open http://127.0.0.1:53572/browser/after/details in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-2-phone-renamed-point-1-baseline.png
- targetScreenshot：route-1-2-phone-renamed-point-1-target.png
- baselineDetails：route-1-2-phone-renamed-point-1-baseline.json
- targetDetails：route-1-2-phone-renamed-point-1-target.json
- baselineRepeat：route-1-2-phone-renamed-point-1-baseline-repeat.png
- targetRepeat：route-1-2-phone-renamed-point-1-target-repeat.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
