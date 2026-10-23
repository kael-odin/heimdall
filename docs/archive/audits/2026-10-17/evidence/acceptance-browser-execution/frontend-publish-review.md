# D3 publish 前端只读复核

审查日期：2026-10-17（Asia/Hong_Kong）。本轮七张实际 publish 截图与布局、错误原件和四份账本已核对，仍支持此前局部可用性结论，未发现新增前端交付阻断。本记录直接新增于指定根目录，未覆盖旧审查文档或修改任何源码，没有另启 Browser、运行 Core 或 commit/push。

本轮原件目录为 `../browser-execution-console-smoke-d3-publish-20261017/`。`summary.json` 为 passed，`checks.json` 实际 16 项全部 true；运行时段为 **2026-10-17 12:59:41.518–13:02:40.611 UTC**，即 **香港时间 20:59:41.518–21:02:40.611**。原件注明 Browser 插件不可用，使用仓库 Playwright CDP；本审查读取主代理已完成的真实本地受控站点运行，没有重复运行。源码 578 文件冻结不变由主代理校验，本审查未独立重算。

## 七张实际截图及布局

以下七张 PNG 均已实际打开查看，未用之前 release/final 图替代。本轮继续按已读取的 UI/UX Pro Max 响应式、长标识及信息层级规则进行局部审查。

| PNG | 视口 / 主题 | 页面宽度 | 组件 client / scroll | 目视结果 |
| --- | --- | ---: | ---: | --- |
| `browser-execution-desktop-light.png` | 1440×1000 / light | 1440 | 964 / 964 | 三次运行的目标、编号、状态和报告入口清楚 |
| `browser-execution-desktop-dark.png` | 1440×1000 / dark | 1440 | 964 / 964 | 固定来源说明、检查结果和证据按钮可辨 |
| `browser-execution-mobile-light.png` | 390×844 / light | 390 | 296 / 296 | 字段与动作单列，说明换行，无可见覆盖 |
| `browser-execution-mobile-dark.png` | 390×844 / dark | 390 | 296 / 296 | 主流程与长操作编号留在组件内 |
| `browser-execution-evidence-desktop.png` | 1440×1000 / light | 1440 | 964 / 964 | 固定来源、本次目标、视觉差异三列角色对应清楚 |
| `browser-execution-issue-history-desktop.png` | 1440×1000 / light | 1440 | 964 / 964 | 问题维度、再次发现状态与三次历史层级清楚 |
| `browser-execution-issue-history-mobile.png` | 390×844 / dark | 390 | 296 / 296 | 关系、时间、操作编号分行，无可见横向挤出或遮挡 |

`layouts.json` 七组均满足组件 scrollWidth 等于 clientWidth，documentWidth 等于视口宽度。证据和历史图处于内部纵向滚动位置，不据其负 y 值判断内容丢失。

固定来源、本次目标、视觉差异分别显示白色来源面板、棕色目标面板、红色差异区域；报告和登记动作未被图片横向挤出。手机长候选与 URL 在原生下拉控件中受宽度截断，没有撑破布局；展开选项及完整名称确认仍属于本轮未采样范围。

## 四份账本与界面一致

| 原件 | issue 数量 | 全部状态 | 全部历史关系 |
| --- | ---: | --- | --- |
| `ledger-initial.json` | 4 | open | observed_failure |
| `ledger-verified-passed.json` | 4 | verified_passed | observed_failure → verified_passed |
| `ledger-reopened.json` | 4 | reopened | observed_failure → verified_passed → reopened |
| `final-ledger.json` | 4 | reopened | observed_failure → verified_passed → reopened |

所有 issue 的 `closesBusinessIssue` 均为 false。桌面 light 与手机 dark 均显示“首次发现 → 已复验通过 → 通过后再次发现”，当前状态“再次发现”，并保留“业务问题最终关闭仍需另行确认”的说明，与账本一致。

第一项问题的截图时间和操作号与原账本一致：2026-10-17 香港时间 21:00:18，`bo-1f341fdd-d118-4ac1-bcef-34d746c5e4bc`；21:00:38，`bo-d97ee905-9ce4-4910-98a2-7687e55b2171`；21:01:00，`bo-d62f239f-fd86-44db-8c11-a735f0c48633`。截图显示到秒，原账本保留毫秒。

## 错误原件与结论边界

`browser-errors.json` 实际 **pageErrors 0、consoleMessages 12**：故意丢接纳响应的 HTTP 502 共 **1** 条，显式停机/重启期间 ERR_CONNECTION_REFUSED 共 **11** 条，其他 console 消息 **0** 条。原件保留全部记录；本轮结论是“无页面脚本异常”，不能写成“控制台零错误”或“没有网络错误”。16/16 的行为检查是主代理本轮运行的原件结果，本审查没有独立重跑。

四主题主流程图的操作数量及拍摄阶段不同，用于布局和可读性复核，不构成同一状态的逐像素主题比较。证据三图仅覆盖桌面 light；问题历史覆盖桌面 light 与手机 dark。没有推断手机证据展开、其他主题历史或所有滚动位置均已实测，也未验证键盘全流程、读屏、200% 缩放、精确颜色对比及真实手机触摸，不构成完整无障碍认证。

本轮 publish 原件与此前局部结论一致，没有新增 UI 发布阻断。最终发布仍需合并主代理的完整回归、构建和冻结校验。
