# 固定注入基准 · 菜单按钮的无障碍名称改变 · 项目验收报告

任务：benchmark-2026-10-28T08-21-50-273Z-62a555ff-aria-label-change
模式：mirror；时间：2026-10-28T08:23:42.175Z → 2026-10-28T08:23:43.640Z
基线：http://127.0.0.1:60701/baseline
目标：http://127.0.0.1:60701/target

**门禁：阻断：发现缺陷**

声明检查 6，已形成结果 6，完成可靠判定 6。
通过 5；失败 1；阻塞 0；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 1 | 1 | 0 | 0 | 0 | 100.00% |
| structure | 1 | 0 | 1 | 0 | 0 | 未测 |
| behavior | 0 | 0 | 0 | 0 | 0 | 未测 |
| health | 4 | 4 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-desktop-navigation | /aria-label-change | desktop | passed | match | medium |
| route-1-1-desktop-console | /aria-label-change | desktop | passed | match | high |
| route-1-1-desktop-network | /aria-label-change | desktop | passed | match | medium |
| route-1-1-desktop-overflow | /aria-label-change | desktop | passed | match | medium |
| route-1-1-desktop-structure | /aria-label-change | desktop | failed | bug | high |
| route-1-1-desktop-visual | /aria-label-change | desktop | passed | match | medium |

## 问题与证据

### route-1-1-desktop-structure · 标题、主标题与关键控件语义

结论：bug；证据等级：offline-reproduced；参照：{"kind":"approved-runtime","source":"http://127.0.0.1:60701/baseline"}
预期：{"title":"Heimdall 验收演示","headings":["团队项目概览"],"controls":[{"path":"#menu-toggle","tag":"button","role":null,"label":"菜单","type":"button","href":null,"disabled":false,"expanded":"false","selected":null},{"path":"#details-link","tag":"a","role":null,"label":"查看详情","type":null,"href":"/details","disabled":false,"expanded":null,"selected":null}]}
实际：{"title":"Heimdall 验收演示","headings":["团队项目概览"],"controls":[{"path":"#menu-toggle","tag":"button","role":null,"label":"主菜单","type":"button","href":null,"disabled":false,"expanded":"false","selected":null},{"path":"#details-link","tag":"a","role":null,"label":"查看详情","type":null,"href":"/details","disabled":false,"expanded":null,"selected":null}],"maskCoverage":{"baseline":{"maskedRatio":0,"effectiveAreaPx":1024000,"samplingCapped":false},"target":{"maskedRatio":0,"effectiveAreaPx":1024000,"samplingCapped":false}}}

复现步骤：

1. Open http://127.0.0.1:60701/baseline/aria-label-change at 1280×800.
2. Open http://127.0.0.1:60701/target/aria-label-change in a fresh browser context at the same viewport.

证据文件：

- baselineScreenshot：route-1-1-desktop-baseline.png
- targetScreenshot：route-1-1-desktop-target.png
- baselineDetails：route-1-1-desktop-baseline.json
- targetDetails：route-1-1-desktop-target.json
- baselineRepeat：route-1-1-desktop-baseline-repeat.png
- targetRepeat：route-1-1-desktop-target-repeat.png

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
