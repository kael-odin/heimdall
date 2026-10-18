# 比赛演示 · 菜单与配额验收 · 项目验收报告

任务：ac-781cb0d3-4e9b-403f-9073-504e02015542
模式：mirror；时间：2026-10-18T03:06:20.838Z → 2026-10-18T03:06:36.555Z
基线：http://127.0.0.1:55176/baseline
目标：http://127.0.0.1:55176/target

计划指纹：189172a1ec64972f0b1d6b93e7629cb97850bb85b46ad9a1c1ef727e4c4815a8
验证器指纹：2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337

**门禁：阻断：发现缺陷**

声明检查 39，已形成结果 39，完成可靠判定 39。
通过 36；失败 3；阻塞 0；待复核 0；目标缺陷 3；基线失败 0；缺测 0。

仅验收已声明路由、视口、操作和有界观察窗口；未声明业务与接口契约为未测。单侧文档高度不超过12,000像素且面积不超过12,000,000像素时截图覆盖全页，两次稳定性截图采用相同范围。超过预算仅保留首屏证据，视觉检查标为待复核，不作为完整页面通过依据。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 6 | 6 | 0 | 0 | 0 | 99.90% |
| structure | 6 | 6 | 0 | 0 | 0 | 未测 |
| behavior | 3 | 0 | 3 | 0 | 0 | 未测 |
| health | 24 | 24 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-mobile-navigation | /menu-state | mobile | passed | match | medium |
| route-1-1-mobile-console | /menu-state | mobile | passed | match | high |
| route-1-1-mobile-network | /menu-state | mobile | passed | match | medium |
| route-1-1-mobile-overflow | /menu-state | mobile | passed | match | medium |
| route-1-1-mobile-structure | /menu-state | mobile | passed | match | high |
| route-1-1-mobile-visual | /menu-state | mobile | passed | match | medium |
| route-1-1-mobile-point-1-MENU-OPEN | /menu-state | mobile | failed | bug | high |
| route-1-2-tablet-navigation | /menu-state | tablet | passed | match | medium |
| route-1-2-tablet-console | /menu-state | tablet | passed | match | high |
| route-1-2-tablet-network | /menu-state | tablet | passed | match | medium |
| route-1-2-tablet-overflow | /menu-state | tablet | passed | match | medium |
| route-1-2-tablet-structure | /menu-state | tablet | passed | match | high |
| route-1-2-tablet-visual | /menu-state | tablet | passed | match | medium |
| route-1-2-tablet-point-1-MENU-OPEN | /menu-state | tablet | failed | bug | high |
| route-1-3-desktop-navigation | /menu-state | desktop | passed | match | medium |
| route-1-3-desktop-console | /menu-state | desktop | passed | match | high |
| route-1-3-desktop-network | /menu-state | desktop | passed | match | medium |
| route-1-3-desktop-overflow | /menu-state | desktop | passed | match | medium |
| route-1-3-desktop-structure | /menu-state | desktop | passed | match | high |
| route-1-3-desktop-visual | /menu-state | desktop | passed | match | medium |
| route-1-3-desktop-point-1-MENU-OPEN | /menu-state | desktop | failed | bug | high |
| route-2-1-mobile-navigation | /missing-field | mobile | passed | match | medium |
| route-2-1-mobile-console | /missing-field | mobile | passed | match | high |
| route-2-1-mobile-network | /missing-field | mobile | passed | match | medium |
| route-2-1-mobile-overflow | /missing-field | mobile | passed | match | medium |
| route-2-1-mobile-structure | /missing-field | mobile | passed | match | high |
| route-2-1-mobile-visual | /missing-field | mobile | passed | match | medium |
| route-2-2-tablet-navigation | /missing-field | tablet | passed | match | medium |
| route-2-2-tablet-console | /missing-field | tablet | passed | match | high |
| route-2-2-tablet-network | /missing-field | tablet | passed | match | medium |
| route-2-2-tablet-overflow | /missing-field | tablet | passed | match | medium |
| route-2-2-tablet-structure | /missing-field | tablet | passed | match | high |
| route-2-2-tablet-visual | /missing-field | tablet | passed | match | medium |
| route-2-3-desktop-navigation | /missing-field | desktop | passed | match | medium |
| route-2-3-desktop-console | /missing-field | desktop | passed | match | high |
| route-2-3-desktop-network | /missing-field | desktop | passed | match | medium |
| route-2-3-desktop-overflow | /missing-field | desktop | passed | match | medium |
| route-2-3-desktop-structure | /missing-field | desktop | passed | match | high |
| route-2-3-desktop-visual | /missing-field | desktop | passed | match | medium |

## 问题与证据

### route-1-1-mobile-point-1-MENU-OPEN · 菜单点击后展开

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:55176/baseline"}
预期：{"stepsComplete":true,"assertions":[{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"true","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"false","passed":false}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:55176/baseline/menu-state at 375×812.
2. Open http://127.0.0.1:55176/target/menu-state in a fresh browser context at the same viewport.
3. click #menu-toggle

证据文件：

- baselineScreenshot：route-1-1-mobile-point-1-baseline.png
- targetScreenshot：route-1-1-mobile-point-1-target.png
- baselineDetails：route-1-1-mobile-point-1-baseline.json
- targetDetails：route-1-1-mobile-point-1-target.json
- baselineRepeat：route-1-1-mobile-point-1-baseline-repeat.png
- targetRepeat：route-1-1-mobile-point-1-target-repeat.png

### route-1-2-tablet-point-1-MENU-OPEN · 菜单点击后展开

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:55176/baseline"}
预期：{"stepsComplete":true,"assertions":[{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"true","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"false","passed":false}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:55176/baseline/menu-state at 768×1024.
2. Open http://127.0.0.1:55176/target/menu-state in a fresh browser context at the same viewport.
3. click #menu-toggle

证据文件：

- baselineScreenshot：route-1-2-tablet-point-1-baseline.png
- targetScreenshot：route-1-2-tablet-point-1-target.png
- baselineDetails：route-1-2-tablet-point-1-baseline.json
- targetDetails：route-1-2-tablet-point-1-target.json
- baselineRepeat：route-1-2-tablet-point-1-baseline-repeat.png
- targetRepeat：route-1-2-tablet-point-1-target-repeat.png

### route-1-3-desktop-point-1-MENU-OPEN · 菜单点击后展开

结论：bug；证据等级：browser-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:55176/baseline"}
预期：{"stepsComplete":true,"assertions":[{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"true","passed":true}],"httpStatus":200}
实际：{"stepsComplete":true,"stepError":null,"assertions":[{"kind":"attribute","selector":"#menu-toggle","attribute":"aria-expanded","expected":"true","actual":"false","passed":false}],"httpStatus":200,"navigationError":null,"errors":[],"network":[],"overflow":false,"blockedRequests":[]}

复现步骤：

1. Open http://127.0.0.1:55176/baseline/menu-state at 1440×900.
2. Open http://127.0.0.1:55176/target/menu-state in a fresh browser context at the same viewport.
3. click #menu-toggle

证据文件：

- baselineScreenshot：route-1-3-desktop-point-1-baseline.png
- targetScreenshot：route-1-3-desktop-point-1-target.png
- baselineDetails：route-1-3-desktop-point-1-baseline.json
- targetDetails：route-1-3-desktop-point-1-target.json
- baselineRepeat：route-1-3-desktop-point-1-baseline-repeat.png
- targetRepeat：route-1-3-desktop-point-1-target-repeat.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
