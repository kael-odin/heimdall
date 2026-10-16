# 执行 UI 最终证据

对应[实施报告](../../acceptance-execution-ui.md)。证据等级为 `local-fixture-real-button-flow`：真实 Chromium CDP、原生表单／按钮、真实引擎接纳与 runner/writer，业务目标为本地受控 API 夹具。浏览器插件不可用，实际使用仓库 Playwright 的 `connectOverCDP`。

最终有效原件目录为 `core/workspace/_runs/execution-ui-bdad78f7-e5bb-4765-bb0d-c8ccceff3ac6`。本目录发布六张有效 PNG、六份 DOM、JSON 与压缩日志；原件、失败轮次和中间作废截图均保留在 ignored workspace，未删除。

| 证据 | 当次结果与边界 |
| --- | --- |
| [质量门摘要](validation-summary.json) | Windows Core 1819 total / 1811 pass / 0 fail / 8 skip；helper 22/22；重叠 helper 回归 63/63 不重复累加 |
| [Core 原 stdout](gates/core.stdout.gz) | 原文件名 core.tap，实际为 spec reporter stdout；原字节以无损 gzip 保存，458391.8319 ms |
| [最终浏览器检查](cdp-final/browser-checks.json) | 16/16 checks、8 cases、pageErrors=0；发布脱敏副本 |
| [场景记录](cdp-final/cases.json) | 执行夹具目标 8、只读夹具目标 0、两组模型请求均为 0；来源 before/after 字节相同 |
| [原生浏览器请求](cdp-final/browser-requests.json) | 六次启动 POST 中四次真实接纳、一次未转发故障、一次旧 CAS 拒绝，不能称为六次执行 |
| [截图状态矩形](cdp-final/screenshot-rects.json) | 最终捕获断言状态位于视口与头栏之间；交叉核对六图与 DOM |
| [独立视觉复核](independent-review.json) | ship，限定本执行 UI；复核者逐张打开六图，未发现新阻塞项 |
| [原控制台克隆 CDP](gates/console-cdp.stdout.gz) | task done、cloneStatus=200、pageErrors=[]；不混入本轮 16 个检查 |
| [源码字节清单](source-files.json) | 冻结工作树的 Vue、JS helper、专项测试、smoke、夹具与 CI/命令入口 SHA；基准提交不代表已包含这些变更 |
| [脱敏清单](redactions.json) | 两处临时受控 fixture set-cookie header 被删除；记录原件／发布 SHA 和精确 JSON pointer |
| [归档字节清单](archive-manifest.json) | 所有发布文件 SHA；原件到副本／gzip 的转换及校验 |

六张有效图：

- [桌面运行中](cdp-final/execution-running-native-desktop.png)
- [390px 暗色完成且发现缺陷](cdp-final/execution-completed-mobile-dark.png)
- [390px 亮色 CANCELLED 中断](cdp-final/execution-cancelled-mobile-light.png)
- [prepared 仅查询](cdp-final/execution-prepared-query-only-desktop.png)
- [404 刷新后仍未知](cdp-final/execution-unknown-404-reload-desktop.png)
- [旧 CAS 拒绝并要求重新核对](cdp-final/execution-stale-cas-requires-new-review-desktop.png)

两张手机图只直接证明状态与原操作身份可读、记录宽度无新增横向溢出。“查看运行与报告”按钮在该滚动位置的视口下方，不能声称手机报告按钮已目视或触控验收。报告打开闭环由浏览器操作记录证明。独立复核没有重新跑完整键盘、屏幕阅读器或计算颜色对比度。

[首次缺少 receipt seed 的失败](attempts/first-missing-seed/README.md)保留 failure.json 原字节；[中间无效手机截图说明](attempts/superseded-mobile/README.md)只保存 metadata 与原件 SHA，不把作废图放入通过图。失败与重复轮次不累加。

JSON 发布副本仅删除 `browser-checks.json` 的 `/cases/6/lookup/headers/set-cookie` 和 `cases.json` 的 `/6/lookup/headers/set-cookie`，并重新序列化；两文件均不是逐字节原件。其他直接副本均核对 SHA。所有日志通过[既有归档脚本](gates/archive-evidence.mjs)无损 gzip，每份 `.gz.json` 保存原长度／SHA、压缩长度／SHA 与解压往返核验。

最新 Console build 在最终文案修正后通过（433 modules、669ms），原始输出只存在主代理工具消息，没有伪造本地 log；既有 Graph3D 大 chunk 提示仍保留。Core 的 8 个 skip 是 5 项 POSIX pipe/FIFO、1 项 POSIX SIGTERM 和 2 项显式 Docker。本 UI 推送后的 CI 需要按新 head 独立核对，父后端提交成功不能替代。

最终 CDP 使用的 smoke SHA 为 `f86d89829290a5874bb01467b956a81df1d30c42e1cf2935d6ac37c5060a8d12`。其后仅删除 EOF 多余空行；[源码清单](source-files.json)分别记录 executedSource 与 publishedSource，已通过向发布字节补回一个末尾 LF 得到执行 SHA 的方式核验差异，未重写原运行证据。
