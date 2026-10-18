# 验收运行对比

此前：ac-c4972769-8b5b-46d5-9724-724c6ed9bd55 · Browser before · 原门禁 failed
本次：ac-6081a04b-aa0b-48ad-bda0-8108922405f4 · Renamed browser run · 原门禁 failed
对比状态：完成

检查 28；仍失败 0；可靠复验通过 0；新增失败 2；本次观测失败 0；持续通过 12；本次观测通过 0；未复验 14；不可比 0。

## 证据完整性

| 运行 | 完整性 | 证据验证 | 通过文件数 | 已读字节数 |
| --- | --- | --- | ---: | ---: |
| 此前 | 通过 | 通过 | 52 | 349617 |
| 本次 | 通过 | 通过 | 26 | 177906 |


## 检查对比

| 检查 | 路由 | 视口 | 维度 | 此前检查 | 本次检查 | 对比结果 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 页面导航与 HTTP 状态 | /home | 375 × 812 | navigation | route-1-1-mobile-navigation | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 浏览器脚本与控制台错误 | /home | 375 × 812 | console | route-1-1-mobile-console | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 资源与只读网络请求 | /home | 375 × 812 | network | route-1-1-mobile-network | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 视口水平溢出 | /home | 375 × 812 | overflow | route-1-1-mobile-overflow | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 标题、主标题与关键控件语义 | /home | 375 × 812 | structure | route-1-1-mobile-structure | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 页面视觉还原度 | /home | 375 × 812 | visual | route-1-1-mobile-visual | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| Toggle exposes expanded state | /home | 375 × 812 | behavior | route-1-1-mobile-point-1-toggle | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 页面导航与 HTTP 状态 | /home | 960 × 720 | navigation | route-1-2-desktop-navigation | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 浏览器脚本与控制台错误 | /home | 960 × 720 | console | route-1-2-desktop-console | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 资源与只读网络请求 | /home | 960 × 720 | network | route-1-2-desktop-network | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 视口水平溢出 | /home | 960 × 720 | overflow | route-1-2-desktop-overflow | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 标题、主标题与关键控件语义 | /home | 960 × 720 | structure | route-1-2-desktop-structure | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 页面视觉还原度 | /home | 960 × 720 | visual | route-1-2-desktop-visual | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| Toggle exposes expanded state | /home | 960 × 720 | behavior | route-1-2-desktop-point-1-toggle | — | 未复验 | check-not-rerun: 本次没有同一上下文的检查；删除或缺测不能算修复。 |
| 页面导航与 HTTP 状态 | /details | 375 × 812 | navigation | route-2-1-mobile-navigation | route-1-2-phone-renamed-navigation | 持续通过 |  |
| 浏览器脚本与控制台错误 | /details | 375 × 812 | console | route-2-1-mobile-console | route-1-2-phone-renamed-console | 持续通过 |  |
| 资源与只读网络请求 | /details | 375 × 812 | network | route-2-1-mobile-network | route-1-2-phone-renamed-network | 持续通过 |  |
| 视口水平溢出 | /details | 375 × 812 | overflow | route-2-1-mobile-overflow | route-1-2-phone-renamed-overflow | 持续通过 |  |
| 标题、主标题与关键控件语义 | /details | 375 × 812 | structure | route-2-1-mobile-structure | route-1-2-phone-renamed-structure | 持续通过 |  |
| 页面视觉还原度 | /details | 375 × 812 | visual | route-2-1-mobile-visual | route-1-2-phone-renamed-visual | 持续通过 |  |
| Renamed point | /details | 375 × 812 | behavior | route-2-1-mobile-point-2-copy | route-1-2-phone-renamed-point-1-copy | 新增失败 |  |
| 页面导航与 HTTP 状态 | /details | 960 × 720 | navigation | route-2-2-desktop-navigation | route-1-1-wide-renamed-navigation | 持续通过 |  |
| 浏览器脚本与控制台错误 | /details | 960 × 720 | console | route-2-2-desktop-console | route-1-1-wide-renamed-console | 持续通过 |  |
| 资源与只读网络请求 | /details | 960 × 720 | network | route-2-2-desktop-network | route-1-1-wide-renamed-network | 持续通过 |  |
| 视口水平溢出 | /details | 960 × 720 | overflow | route-2-2-desktop-overflow | route-1-1-wide-renamed-overflow | 持续通过 |  |
| 标题、主标题与关键控件语义 | /details | 960 × 720 | structure | route-2-2-desktop-structure | route-1-1-wide-renamed-structure | 持续通过 |  |
| 页面视觉还原度 | /details | 960 × 720 | visual | route-2-2-desktop-visual | route-1-1-wide-renamed-visual | 持续通过 |  |
| Renamed point | /details | 960 × 720 | behavior | route-2-2-desktop-point-2-copy | route-1-1-wide-renamed-point-1-copy | 新增失败 |  |

## 边界

- 仅对比用户明确选择的两次运行；此前/本次是选择标签，不自动批准项目基线，也不改写原门禁。
- 可靠复验通过针对整个相同合同、操作点或检查，不推断子失败根因相同，不自动关闭持久问题。
- 未测、删除、受阻、待复核及不可比均不算修复；精确参考截图哈希变化会保守停止视觉趋势比较。
