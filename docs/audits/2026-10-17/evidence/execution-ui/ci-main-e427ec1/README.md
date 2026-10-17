# 执行工作台自身提交的 Linux CI

来源为 GitHub run `38982028983`，精确 head `e427ec1f4b9d7b6d2b6bc4b2760a3fd262bbf1ed`，触发为 main push；2026-10-16 23:33:04Z 启动，23:50:11Z 完成（香港时间 2026-10-17 07:33:04 至 07:50:11）。三个 job 均 success。这里补录已完成的运行，没有重新触发 CI。

| 证据 | 结果 |
| --- | --- |
| Core 正式 suite | 1819 total / 1815 pass / 0 fail / 4 skip；六项 POSIX 场景在 Linux 实际通过 |
| 执行 UI smoke | 16/16 具名检查全部 true，该 step 用时 27 秒 |
| 独立 Docker step | 2/2 pass；对应主 suite 已登记用例，不额外增加总测试数 |
| Acceptance smoke | Core job 中 11 项全部 success |
| Core job 总时长 | 17 分 04 秒，处于 30 分钟预算内 |

[run.json](run.json)、[jobs.json](jobs.json)、[run-view.json](run-view.json) 和 [artifacts.json](artifacts.json) 是下载原件。[ci.stdout.gz](ci.stdout.gz) 为完整 `gh run view --log` 的无损 gzip，已逐字节解压往返核对；原件长度 1380037 bytes，SHA-256 `414074280342708f5ef2158d21aae8ac7eba577ca603968e2e98ca7251e25598`。全部文件的原件/存储副本长度与摘要见 [source-files.json](source-files.json)。完整下载目录与原始 ZIP 留在 ignored workspace；ZIP SHA-256 为 `55da46d08c25def76ca3c1f81937a98432bdfe369abf227e206d98656c44486a`。

本次成功运行 `artifacts.total_count=0`。CI stdout 直接证明 UI 16 项检查通过；本地真实 CDP 的 8 cases、执行/恢复目标请求 8/0、模型请求 0/0 仍属于此前本地原件，不能称为本次 CI 可独立复算的计数。两次 Console build 均保留既有 Graph3D 大 chunk 提示。
