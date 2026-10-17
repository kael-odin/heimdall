# D5 自身 Linux CI 超时原件

精确 head `a0f834ebe727d6d00e2d692a008d3d0512a56536`，run `39072135745`，attempt 1。结论是 **cancelled**，不是通过。

- [GitHub annotations 原件](timeout-annotations/annotations.json)明确记录 `The job has exceeded the maximum execution time of 45m0s`。
- [完整采集](final-20261017T222913.304634Z/capture-summary.json)保留 run/jobs、原 ZIP、CRC 与提取日志；原 ZIP 为 542877 字节，SHA256 `153c7379cd0a19e5d789a78ac08af93db4f2f7a0d7bd4871742d6e3f8a801a3c`。
- [独立核验](verification-20261017T222932.385061Z/verified-summary.json)按原工具输出保留 `passed:false`、`captureComplete:false`、`identityMatches:true`、`executionAccepted:false`。Docker 未执行且没有对应 step log，D5 没有终态摘要；这不等同于已证明原日志损坏。
- [逐文件清单](manifest.json)把归档文件绑定到本机来源与原始 SHA256；工具原字节保存在 `tools/`，未修改其判断来接受本次取消。

Core 全量测试为 2661 total / 2657 pass / 0 fail / 4 skipped；前 19 项 Core acceptance smoke 成功，第 20 项 D5 cancelled，Docker skipped。其他两个 job 成功。这些部分成功不替代整轮结果。

这些是该次失败历史的原件。后续调度修复与其自身 CI 另行记录，不能覆盖本目录。

原核验 REPORT.md 使用 CRLF，原始 stdout 与提取日志还保留时间戳后的空白。Git 对这份报告及本目录的 log / txt 原件禁用文本 diff；完整内容、换行与 SHA256 保持原样，可直接核对，不做格式化改写。
