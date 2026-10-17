# D4 自身提交的 Linux CI 原件

- 仓库：`kael-odin/heimdall`。
- 提交：`5006e16bf73e47f36877da24df4ac4a5c8207965`。
- GitHub Actions run：`39051880267`，attempt 1，push / main。
- 完成：UTC `2026-10-17T17:40:03Z`，香港 `2026-10-18 01:40:03`。
- 三个 jobs 均 completed / success。Core 2530 tests / 2526 pass / 0 fail / 4 skipped；19 项后续验收 smoke 实际 success；显式 Docker 2/2 pass / 0 skipped；独立 smoke job 的 forge 和三项 benchmark 成功。
- 四项常规阶段 skip 为两项 Windows 专用测试及两项 Docker；Docker 随后在显式阶段实际执行通过。
- 独立完整性核验 308/308，captureComplete / identityMatches / executionAccepted 均为 true。

这里收录推送 D4 后才产生的原件。它验证 D4，不代替 D5 或其他提交的 Linux CI。

| 原件 | 用途 |
| --- | --- |
| [run-logs.zip](run-logs.zip) | GitHub 原始日志 ZIP，65 个日志条目，518060 bytes |
| [complete-stdout.log](complete-stdout.log) | `gh run view --log` 完整 stdout，1868215 bytes |
| [verified-summary.json](verified-summary.json) | 身份、步骤、字节核验与测试计数 |
| [REPORT.md](REPORT.md) | 采集器核验明细 |
| [independent-direct-zip-gh-review.json](independent-direct-zip-gh-review.json) | 跳过汇总解析器，直接复读 ZIP / gh 原件的独立结果 |
| [CAPTURE-REVIEW.md](CAPTURE-REVIEW.md) | 采集和核验边界 |

原 ZIP SHA256：`3df2ff6e4c1aaa3ce92ecb767d83326550ad8affc2af1c39f9a302b4ca8159bd`。
