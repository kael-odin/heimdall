# D3 release 前端独立复核

审查日期：2026-10-17（Asia/Hong_Kong）。重新冻结后的 release 七张实际截图仍支持此前局部可用性结论，未发现新增前端交付阻断。本记录独立新增于 development 目录，未覆盖 `../frontend-finish-review.md`，未用旧 final 图代替本轮 release 原件。

本次只读审阅主代理产生的实际 PNG、布局、检查结果、浏览器错误和问题账本；沿用已读取的 UI/UX Pro Max 响应式布局、长标识与信息层级规则。没有另启 Browser、重跑全量 Core、编辑冻结的 D3 实现或实现 D4，没有 commit/push。578 个源码文件冻结不变为主代理提供的发布背景，本审查未重做源码清单哈希；完整发布门禁仍由主代理汇总。

## 原件及运行时段

证据目录：`../../browser-execution-console-smoke-d3-release-20261017/`。已读取 `summary.json`、`checks.json`、`layouts.json`、`browser-errors.json`、`ledger-initial.json`、`ledger-verified-passed.json`、`ledger-reopened.json`、`final-ledger.json`，并实际打开下表全部七张 PNG。

本轮 smoke 为 `passed`，16 项检查全部 `true`。运行时段：2026-10-17 12:28:52.969–12:32:10.427 UTC，即 2026-10-17 20:28:52.969–20:32:10.427（Asia/Hong_Kong）。原件注明 Browser 插件不可用，实际使用仓库 Playwright CDP。这是主代理完成的本地受控站点真实运行，本审查没有重新运行它。

| release 截图 | 视口 / 主题 | 页面宽度 | 组件 client / scroll | 目视结果 |
| --- | --- | ---: | ---: | --- |
| `browser-execution-desktop-light.png` | 1440×1000 / light | 1440 | 964 / 964 | 候选和目标分列，三次操作的名称、编号、状态与报告入口可辨 |
| `browser-execution-desktop-dark.png` | 1440×1000 / dark | 1440 | 964 / 964 | 标题、说明、失败检查和证据按钮可辨 |
| `browser-execution-mobile-light.png` | 390×844 / light | 390 | 296 / 296 | 字段与动作单列，说明换行，按钮无可见覆盖 |
| `browser-execution-mobile-dark.png` | 390×844 / dark | 390 | 296 / 296 | 主流程可读，操作编号和状态留在组件内 |
| `browser-execution-evidence-desktop.png` | 1440×1000 / light | 1440 | 964 / 964 | 固定来源、本次目标、视觉差异三列角色与内容对应清楚 |
| `browser-execution-issue-history-desktop.png` | 1440×1000 / light | 1440 | 964 / 964 | 问题状态与三次历史层级清楚 |
| `browser-execution-issue-history-mobile.png` | 390×844 / dark | 390 | 296 / 296 | 关系、时间和操作编号分行，无可见横向挤出或遮挡 |

布局原件七组组件 `scrollWidth = clientWidth`，页面 `documentWidth` 等于对应视口宽度。证据和历史采样的组件 y 为负，与其内部纵向滚动位置相符，不能据此判定内容丢失；本轮没有遍历所有滚动位置。

## 界面与账本一致性

- “固定来源验收”说明批准、仅访问目标和执行后登记问题；复核合同与读取操作分开。操作记录同时呈现名称、编号和文字状态，状态不只依赖颜色。桌面 light 的 Repaired / Regressed / Known broken 结果各自清楚。
- 手机字段和动作改为单列；原生下拉框中的长候选与 URL 受宽度截断，未撑破布局。本次未拍摄展开的原生 select，完整名称的辅助确认仍可后续优化，本轮没有新增阻断证据。
- 桌面 light 证据中白色固定来源、棕色本次目标、红色差异可辨；三列标签及报告、显式此前运行、登记动作按阅读顺序排列，未被图片横向挤出。
- 桌面 light 与手机 dark 历史均显示“首次发现 → 已复验通过 → 通过后再次发现”，当前状态“再次发现”。关系、时间、操作编号分行，界面保留“业务问题最终关闭仍需另行确认”的说明。

| 账本 | issue 数 | 全部状态 | 全部历史关系 |
| --- | ---: | --- | --- |
| `ledger-initial.json` | 4 | `open` | `observed_failure` |
| `ledger-verified-passed.json` | 4 | `verified_passed` | `observed_failure → verified_passed` |
| `ledger-reopened.json` | 4 | `reopened` | `observed_failure → verified_passed → reopened` |
| `final-ledger.json` | 4 | `reopened` | `observed_failure → verified_passed → reopened` |

截图第一项问题与账本对应：首次发现 `bo-5632545a-5a18-4139-9f7a-dcb36c40df79`，20:29:40；已复验通过 `bo-20b20a28-a821-44c5-a851-6136d97a54f4`，20:30:06；通过后再次发现 `bo-3577f2e1-44ef-4341-ba08-b33006c7b7f9`，20:30:29。均为 2026-10-17 Asia/Hong_Kong；截图精度到秒，账本保留毫秒。原件 `closesBusinessIssue = false`，界面没有把某次检查通过改为业务问题最终关闭。

## 验证与 console 边界

16/16 包括健康来源侧保存候选、专用路由鉴权、视觉及行为缺陷、原图校验与篡改拒绝、丢响应仅查原操作、显式复验、可靠回归重开、图片渲染与 revoke、真实停止不误完成、挂起已接纳停止 POST 有界等待且只发一次、重放/跨项目隔离、重启账本与 prepared 不自动启动、重启 UI 读问题、来源不进 storage/hrefs、不重访来源且原字节不变，以及页面无 pageErrors。这是原件检查结果，本审查没有独立重跑上述用例。

`browser-errors.json` 的 `pageErrors` 为 0，`consoleMessages` 精确为 12 条：故意丢接纳响应的 HTTP 502 共 1 条，显式停机/重启期间 `ERR_CONNECTION_REFUSED` 共 11 条。原件全部保留。结论是“无页面脚本异常”，不能声称“控制台零错误”或“没有网络错误”。

此前 POST 无限等待的 P2 在本轮由 `pendingAcceptedStopResponseHasBoundedWaitWithoutRepeatingPost: true` 继续覆盖。本审查未重新跑此前 19/19 helper 单测，其实现与单测证据仍以旧 finish-review 和原始日志为准。

## 结论边界

四主题主流程图处于不同操作数量与运行阶段，可用于布局和可读性判断，不是同一状态的逐像素主题比较。证据三图的本轮目视范围仅桌面 light；历史为桌面 light、手机 dark，不能推断手机证据展开、其他主题历史或所有中间滚动位置均已验收。

本轮没有单独验证键盘全流程、读屏、200% 缩放、精确颜色对比、真实手机触摸或打开的原生下拉框，不构成完整无障碍认证。完整所选候选名称/URL 辅助确认、历史操作编号直达报告仍是可后续优化的效率项。

本次只新增这份 ignored 报告。release 原件支持原 finish-review 的局部可用性判断，无新增前端发布阻断；最终发布结论仍需合并主代理的完整 11 组回归、构建和冻结校验。
