# Browser before · 项目验收报告

任务：ac-a39b2f30-8bd8-4543-815a-97bdb05313e5
模式：regression；时间：2026-10-16T12:12:37.235Z → 2026-10-16T12:12:39.078Z
基线：http://127.0.0.1:53572/browser/reference
目标：http://127.0.0.1:53572/browser/before

计划指纹：1c9e92c61b6a7748b3b2080f7166d4def7a9459274bfbb5ab8c20ae10eb48bec
验证器指纹：8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d

**门禁：阻断：发现缺陷**

声明检查 7，已形成结果 7，完成可靠判定 7。
通过 6；失败 1；阻塞 0；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

离线复现：本机固定版本、缺陷和假关闭反例，通过真实 browser/Spec runner、store 落盘与当前证据校验完成；只证明本组声明范围，不代表真实项目检出率、根因识别或持久缺陷自动关闭。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 1 | 1 | 0 | 0 | 0 | 100.00% |
| structure | 1 | 1 | 0 | 0 | 0 | 未测 |
| behavior | 1 | 0 | 1 | 0 | 0 | 未测 |
| health | 4 | 4 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-mobile-navigation | /home | mobile | passed | match | medium |
| route-1-1-mobile-console | /home | mobile | passed | match | high |
| route-1-1-mobile-network | /home | mobile | passed | match | medium |
| route-1-1-mobile-overflow | /home | mobile | passed | match | medium |
| route-1-1-mobile-structure | /home | mobile | passed | match | high |
| route-1-1-mobile-visual | /home | mobile | passed | match | medium |
| route-1-1-mobile-point-1-toggle | /home | mobile | failed | bug | high |

## 问题与证据

### route-1-1-mobile-point-1-toggle · Toggle exposes expanded state

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:53572/browser/reference"}
预期：{"stepsComplete":true,"assertions":[{"kind":"attribute","selector":"#toggle","attribute":"aria-expanded","expected":"true","actual":"true","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"attribute","selector":"#toggle","attribute":"aria-expanded","expected":"true","actual":"false","passed":false}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:53572/browser/reference/home at 375×812.
2. Open http://127.0.0.1:53572/browser/before/home in a fresh browser context at the same viewport.
3. click #toggle

证据文件：

- baselineScreenshot：route-1-1-mobile-point-1-baseline.png
- targetScreenshot：route-1-1-mobile-point-1-target.png
- baselineDetails：route-1-1-mobile-point-1-baseline.json
- targetDetails：route-1-1-mobile-point-1-target.json
- baselineRepeat：route-1-1-mobile-point-1-baseline-repeat.png
- targetRepeat：route-1-1-mobile-point-1-target-repeat.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
