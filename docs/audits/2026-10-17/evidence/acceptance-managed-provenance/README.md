# 来源关联与普通入口隔离证据

[实施记录](../../acceptance-managed-provenance.md)解释能力及限制。`index.json` 给出每份归档与原文件的字节数和 SHA；文本统一 LF，日志整理尾空白，不重写历史原件。`source-pins.json` 固定六份实现、四份测试及未变化的十源 verifier。

- `core-tests.log`：最终完整回归；`core-tests-initial.log` 保留旧来源资格断言失败的首轮，未掩盖为通过。
- `focused-tests.log`、`compatibility-tests.log`、`quarantine-tests.log`：来源关联、普通入口隔离与相对路径兼容。
- `reader-windows.tap`、`reader-linux.tap`：跨平台字节、目录、预算、故障与句柄边界。
- `triage-pending.*`：独立真实 HTTP / 模型桩探针的原源码、原输出和调用归档信息；本批只归档已有运行，未再次执行。
- `preparation/`：25 项既有准备 smoke、零请求及原件检查。不是托管执行。
- `spec-console/`、`cdp/`：既有 Spec 与原镜像的真实浏览器回归。不是托管执行。
- `ci-c288c07.json`：上一提交自己的 CI 已 success；不代表本批新提交已通过 CI。
- `docs-links.log`：证据目录落盘后的 Markdown 链接校验，463 targets / 120 files。
