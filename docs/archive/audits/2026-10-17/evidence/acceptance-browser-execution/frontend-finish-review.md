# D3 固定来源 Browser 单次验收：前端完成审查

审查日期：2026-10-17（Asia/Hong_Kong）。结论：本轮采样中的桌面与手机明暗主题、桌面证据三图、桌面与手机问题历史可读且无可见布局阻断；没有新增阻止 D3 交付的局部可用性问题。原 POST 无期限导致界面一直等待的 P2 已修复，单测与最终真实 Browser smoke 均覆盖了有界等待。

本审查只读查看主代理已生成的实际截图、布局、DOM 和 JSON 证据；未另启浏览器、未重跑全量 Core、未修改产品源码。审查使用 UI/UX Pro Max 中响应式布局、长标识换行、触控与信息层级规则辅助判断，不将截图目视结论写成完整无障碍认证。

## 已读取的实际证据

证据目录：`../browser-execution-console-smoke-d3-final-20261017/`。七张 PNG 均已实际打开查看，未仅依据文件名或 DOM 判断。

| 截图 | 视口 / 主题 | 组件宽度 client / scroll | 页面宽度 | 局部结果 |
| --- | --- | --- | --- | --- |
| `browser-execution-desktop-light.png` | 1440 × 1000 / light | 964 / 964 | 1440 | 候选、目标、三个操作、完成报告入口与结果层级清楚 |
| `browser-execution-desktop-dark.png` | 1440 × 1000 / dark | 964 / 964 | 1440 | 深色下标题、次要说明、状态和证据按钮可辨 |
| `browser-execution-mobile-light.png` | 390 × 844 / light | 296 / 296 | 390 | 字段与动作单列，说明换行，按钮未相互覆盖 |
| `browser-execution-mobile-dark.png` | 390 × 844 / dark | 296 / 296 | 390 | 深色手机主流程可读，长操作编号未撑破布局 |
| `browser-execution-evidence-desktop.png` | 1440 × 1000 / light | 964 / 964 | 1440 | 固定来源、本次目标、视觉差异三列对应清楚 |
| `browser-execution-issue-history-desktop.png` | 1440 × 1000 / light | 964 / 964 | 1440 | 问题维度、最近目标、状态与三次历史层级清楚 |
| `browser-execution-issue-history-mobile.png` | 390 × 844 / dark | 296 / 296 | 390 | 历史展开后关系、时间、操作编号逐项可读 |

布局数值来自最终 `layouts.json`：七个采样的组件 `scrollWidth` 均等于 `clientWidth`，页面 `documentWidth` 均等于对应视口宽度。目标区域在内部纵向滚动容器中；证据和历史截图的组件 y 为负，是为拍到所选局部而滚动后的采样位置，不能据此认定元素离屏丢失。

## 真实界面与账本核对

- 顶部以“固定来源验收”说明本次批准、只访问目标、完成后登记问题。候选与目标分开选择；读取操作与复核合同为独立动作。操作列表同时展示目标名称、操作编号和文字状态，状态不只依赖颜色。
- 手机字段与动作自然改为单列，说明和操作标识留在组件内；原生下拉框中的长候选与 URL 被可视宽度截断，未造成横向溢出。完整候选原文入口由界面提供，本轮截图没有拍摄展开的原生下拉选项。
- 桌面证据截图中三张原图保持相同列宽和清晰角色标签；可直接看出固定来源白色面板与本次目标棕色面板的差异，以及差异图标出的区域。完整报告、显式此前运行和登记按钮仍按阅读顺序排列，没有被证据图挤出横向边界。
- 问题历史的桌面与手机截图均展示“首次发现 → 已复验通过 → 通过后再次发现”，当前状态为“再次发现”。关系、时间和操作编号分别成行，未与下一问题覆盖。界面明确保留“业务问题最终关闭仍需另行确认”的含义。
- `ledger-initial.json`、`ledger-verified-passed.json`、`ledger-reopened.json` 当前各有 4 个 issue；四项分别从 `open` 到 `verified_passed` 再到 `reopened`，历史依次为 `observed_failure → verified_passed → reopened`。因此截图所示历史与账本一致，未凭“某次通过”自动展示最终关闭。

## 验证及已修复问题

最终 smoke 的 `summary.json` 为 `passed`，`checks.json` 16 项全部为 `true`；起止时间为 2026-10-17 20:02:49 至 20:06:03（Asia/Hong_Kong）。这是主代理已完成的本地受控站点真实 Browser/CDP 运行，本审查读取其原始产物。

`browser-errors.json` 的 `pageErrors` 为 0。Console 保留了故意丢失接纳响应的 502 和显式重启引擎期间的 `ERR_CONNECTION_REFUSED`；这些与 smoke 的故障注入流程相符，不能删掉后声称控制台零错误。

此前审查认定的 P2 是：POST 的 fetch 或响应体一直 pending 时，`writing` 无法释放，切换上下文也会继续阻止提交。当前 helper 默认以独立 60 秒期限约束完整 POST 生命周期；超时和外部取消都按结果未知处理，不重发 POST、保留原操作回执，结束时清理 timer/listener。GET 的取消传播保持。该修复已通过：

- `core/test/acceptance-browser-execution-console.test.mjs` 实际 19/19；包括永不结束的 fetch、永不结束的响应体、已结束请求的清理、外部取消，并保留 `beforeObservationSha256` 与连续复验测试。
- 最终 smoke `pendingAcceptedStopResponseHasBoundedWaitWithoutRepeatingPost: true`：已接纳停止请求的响应被挂起后，界面按期限释放控制，只发一次 POST。
- helper 语法检查及相关文件 `git diff --check` 通过。

对应单测原件保留在 `../d3-fixed-runner-20261017/console-deadline.stdout.log` 和 `.stderr.log`，旧失败与旧阶段证据未覆盖。

## 结论边界与后续优化

1. 结论覆盖本地受控项目和上述七个采样。四主题主流程截图拍摄时的操作数量与运行阶段不同，因此可用于可读性和布局审查，不能作为同一状态的逐像素主题比较。
2. 证据三图的实际视觉复核覆盖桌面 light；问题历史覆盖桌面 light 和手机 dark。没有由此推断手机证据展开、其他主题历史或所有中间滚动位置都已完成目视验收。
3. 本轮未单独验证键盘全流程、屏幕阅读器、200% 缩放、精确色彩对比值、真实手机触摸或打开的原生 select。源码中的 44px 最小控件高度和可见焦点样式只是实现事实，不等同于这些项目已经实测。
4. 手机长候选名称和 URL 的截断属于当前信息密度限制，没有本轮阻断证据。后续候选增多时，可在选项下增加完整所选名称与 URL 的文本确认，以降低相似版本误选成本；无需为本轮改动整体设计系统。
5. 后续可将历史中的操作编号连接到对应完成报告，缩短多次复验的追溯路径；当前已能通过操作列表读取报告，这属于效率优化。

交付判断：D3 新增前端功能在本轮已提供的真实产物中可用，未发现新增局部阻断。该判断不覆盖候选全局批准/选择、业务问题最终关闭或未声明验收范围，也不扩大固定来源单次执行的授权边界。
