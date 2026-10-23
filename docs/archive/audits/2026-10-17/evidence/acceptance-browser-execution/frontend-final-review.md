# D3 最终 commit 轮前端只读复核

本轮七张实际渲染截图及配套数据未发现新的 UI 阻断。原始 smoke 的 16 项检查全部通过，四份问题账本的状态、问题身份和复验历史一致。控制台原件包含 12 条网络错误，不能将本轮描述为“控制台零错误”。

## 原件与范围

- 原件目录：`core/workspace/_runs/browser-execution-console-smoke-d3-commit-20261017/`。
- 原件运行时段：`2026-10-17T13:26:56.676Z` 至 `2026-10-17T13:29:56.015Z`，即香港时间 `2026-10-17 21:26:56.676–21:29:56.015`。
- `summary.json`：`status=passed`，`checks=16`，使用仓库 Playwright CDP；Browser plugin 不可用。
- 本复核实际打开了该目录的全部七张 PNG，并读取 `summary.json`、`checks.json`、`layouts.json`、`browser-errors.json`；同轮只读交叉核对四份账本。
- 本复核未另启 Browser/Core，未修改冻结源码，未覆盖旧报告或运行原件。最终完整回归结果由父任务汇总。

## 七张截图与布局

| 截图文件 | 视口与主题 | documentWidth | 容器 clientWidth / scrollWidth | 目视与数据结论 |
|---|---|---:|---:|---|
| `browser-execution-evidence-desktop.png` | 1440 × 1000，light | 1440 | 964 / 964 | 固定来源、本次目标、视觉差异三图标签清楚，图像可辨；报告及登记动作位于容器内。 |
| `browser-execution-desktop-dark.png` | 1440 × 1000，dark | 1440 | 964 / 964 | 说明、检查结果、问题状态与动作文字可辨。 |
| `browser-execution-mobile-light.png` | 390 × 844，light | 390 | 296 / 296 | 字段与操作随窄屏排列，长操作号保留在容器内。 |
| `browser-execution-issue-history-desktop.png` | 1440 × 1000，light | 1440 | 964 / 964 | 首次发现、已复验通过、通过后再次发现顺序清楚，当前状态为再次发现。 |
| `browser-execution-issue-history-mobile.png` | 390 × 844，dark | 390 | 296 / 296 | 三次历史、时间和操作号可辨，窄屏内未见横向挤出。 |
| `browser-execution-desktop-light.png` | 1440 × 1000，light | 1440 | 964 / 964 | 修复版通过、回归版发现问题、首次问题运行均可辨；“复验通过”与“业务问题最终关闭”说明清楚。 |
| `browser-execution-mobile-dark.png` | 390 × 844，dark | 390 | 296 / 296 | 选择控件、复核与读取按钮、完成状态及操作号布局可用。 |

七个采样中 `documentWidth` 均与视口宽一致，受测容器 `scrollWidth=clientWidth`，未发现横向溢出。原生选择框在手机上会截短当前长标签，本轮截图未出现横向撑宽。

这些截图来自不同状态和流程阶段，不能据此声称完成了同一状态的四主题像素对比。证据三图仅在桌面 light 截图中直接展示；展开的问题历史直接展示于桌面 light 与手机 dark。

## 检查与控制台边界

`checks.json` 的 16 项值均为 `true`，包括固定候选来源、路由鉴权、视觉与行为缺陷发现、证据字节核验及篡改拒绝、接纳响应丢失后仅查询原操作、显式前后复验、回归重开、证据图释放、停止操作及响应期限、重放/外来查询限制、重启后账本与问题记录读取、来源信息隔离、来源不重访及原截图字节不变、实际页面无脚本异常。

本轮 `browser-errors.json` 精确统计如下：

| 分类 | 数量 | 原件范围 |
|---|---:|---|
| 页面脚本异常 `pageErrors` | 0 | 空数组。 |
| 控制台 `error` 总数 | 12 | 全部为网络加载错误。 |
| HTTP 502 | 1 | `POST /api/acceptance/projects/ap-c547e076-988c-41ac-85aa-a6ecf90c8e4d/browser-executions` 的受控接纳响应丢失阶段。 |
| `ERR_CONNECTION_REFUSED` | 11 | 旧引擎地址 `127.0.0.1:53557`；`/api/acceptance/runs` 6 条、`/api/acceptance/execution` 4 条、`/api/status` 1 条。 |

因此，“实际页面无脚本异常”与 16/16 smoke 通过有原件支持；“控制台零错误”没有原件支持。故障注入及停机阶段的网络错误必须随原件保留，本只读复核未过滤或改写这些记录。

## 四份问题账本与历史一致性

项目为 `ap-c547e076-988c-41ac-85aa-a6ecf90c8e4d`。四份账本中均为同一组 4 个唯一 issue，身份与历史前缀保持一致。

| 原件 | entries | 4 个 issue 的状态 | 每个 issue 的历史条数 |
|---|---:|---|---:|
| `ledger-initial.json` | 1 | `open` | 1 |
| `ledger-verified-passed.json` | 2 | `verified_passed` | 2 |
| `ledger-reopened.json` | 3 | `reopened` | 3 |
| `final-ledger.json` | 3 | `reopened` | 3 |

全部 issue 的 `closesBusinessIssue=false`，四份账本顶层均为 `closesBugs=false`。`lastVerifiedState` 与相应阶段状态一致；最终历史为 `observed_failure → verified_passed → reopened`，对应 `failed/bug → passed/match → failed/bug`。各历史操作号、此前操作号和登记时间与对应 ledger entry 一致，`latestOperationId` 指向最后一条历史。

以桌面视觉问题 `bug-05ad5e216b0415ab144762db00b4061c7db4d26886d2bf7ec69af4a7ba743cb8` 为例，截图中的三次记录与账本一致：

| 历史 | operationId | recordedAt（UTC） | 香港时间 |
|---|---|---|---|
| 首次发现 | `bo-aac68888-386d-4da4-962c-90e37d45e379` | `2026-10-17T13:27:33.976Z` | `2026-10-17 21:27:33.976` |
| 已复验通过 | `bo-5bf2c305-3114-4bf4-8d8f-d2eb89f41b3c` | `2026-10-17T13:27:52.954Z` | `2026-10-17 21:27:52.954` |
| 通过后再次发现 | `bo-5e939b10-436e-4f67-b707-4bc8d4e10c45` | `2026-10-17T13:28:14.914Z` | `2026-10-17 21:28:14.914` |

`ledger-reopened.json` 与 `final-ledger.json` 内容一致，SHA-256 均为 `bb56e2ab56627bef49b97ca9b01631093f8aded97b1507720cadaf54b5757bce`。界面的“再次发现”与最终账本一致，没有把检查复验通过展示为业务问题已关闭。

## 结论边界

本轮证据级别为真实渲染 smoke 原件的截图、布局数据、检查结果、错误记录及持久账本交叉复核。受测页面与样例流程可进入最终汇总；未额外验证键盘完整流程、读屏、200% 缩放、精确文字对比度、其他浏览器或其他真实站点，不构成完整无障碍认证或通用无缺陷证明。
