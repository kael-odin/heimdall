# 固定注入基准 · 动态刷新区按已声明规则遮罩 · 项目验收报告

任务：benchmark-2026-10-18T03-34-30-164Z-f1911875-masked-noise
模式：mirror；时间：2026-10-18T03:34:51.576Z → 2026-10-18T03:34:53.154Z
基线：http://127.0.0.1:55191/baseline
目标：http://127.0.0.1:55191/target

**门禁：通过**

声明检查 6，已形成结果 6，完成可靠判定 6。
通过 6；失败 0；阻塞 0；待复核 0；目标缺陷 0；基线失败 0；缺测 0。

离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 1 | 1 | 0 | 0 | 0 | 100.00% |
| structure | 1 | 1 | 0 | 0 | 0 | 未测 |
| behavior | 0 | 0 | 0 | 0 | 0 | 未测 |
| health | 4 | 4 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| route-1-1-desktop-navigation | /masked-noise | desktop | passed | match | medium |
| route-1-1-desktop-console | /masked-noise | desktop | passed | match | high |
| route-1-1-desktop-network | /masked-noise | desktop | passed | match | medium |
| route-1-1-desktop-overflow | /masked-noise | desktop | passed | match | medium |
| route-1-1-desktop-structure | /masked-noise | desktop | passed | match | high |
| route-1-1-desktop-visual | /masked-noise | desktop | passed | match | medium |

## 问题与证据

## 边界

页面来自用户指定的运行基线。浏览器实测可以证明本次观测结果，不能代替 PRD、业务数据库或接口契约验收。视觉分不覆盖未声明功能。默认阻断非 GET/HEAD/OPTIONS 请求；依赖写请求的流程记为环境阻塞。截图、DOM 摘要及文本输入可能包含业务数据，应使用授权测试环境。
