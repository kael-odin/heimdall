# Browser 纯投影内核自身提交的 Linux CI

本目录对应 GitHub run `38988539457`，精确 head `0f90fa7cab485b82589272e55a752eaf32bab734`，由 main push 触发。运行从 2026-10-17 00:54:52Z 至 01:15:27Z 完成，即香港时间同日 08:54:52 至 09:15:27；三个 job 全部 success。仅补录已完成的运行，没有重新触发 CI。

| 检查 | 原件结果与计数边界 |
| --- | --- |
| Linux Core 正式 suite | 1841 total / 1837 pass / 0 fail / 4 skip；950781.649011 ms；Browser 投影专项 22 项已包含在总数内 |
| 主 suite 的四项跳过 | 两项 Windows 文件句柄特有场景，以及两项需要显式 Docker 开关的用例；六项 POSIX 场景在 Linux 实际运行 |
| Acceptance smoke | Core job 中 12 项全部 success，逐项名称和时间见 summary.json |
| 新 Browser source smoke | 8/8 具名检查全部 true；4 次 fresh Browser 运行、8 个选侧案例、4 个合格与 4 个拒绝、4 次确定性重查、projection fetch=0；step 用时 20 秒 |
| 独立 Docker step | 2/2 pass、0 fail、0 skip；38104.676692 ms；这两项已在正式 suite 的声明总数中，不另加两个独立测试 |
| Core job 总时长 | 20 分 33 秒，处于 30 分钟预算内 |
| Console 与原 Core smoke job | 两个 job 均 success；Console 保留既有 Graph3D 大 chunk 提示 |

[run.json](run.json)、[jobs.json](jobs.json) 和 [artifacts.json](artifacts.json) 是 GitHub API 原始响应；[run-view.json](run-view.json) 是完整 `gh run view --json` 输出。[ci.stdout.gz](ci.stdout.gz) 是完整 `gh run view --log` 输出的无损 gzip，解压后已逐字节核对原件：1405435 bytes，SHA-256 `0efe506665a71e97b82996ca5254edfe938f2669301352927e70379a3800e470`。

[summary.json](summary.json) 从上述原始元数据和完整日志提取提交身份、job、正式 suite、12 个 smoke、新 Browser 摘要与 Docker 计数；它是派生摘要，不冒充 GitHub 返回原件。[source-files.json](source-files.json) 记录六份发布副本的存储长度、原件长度、处理方式和 SHA-256。完整下载原件及 GitHub 日志 ZIP 保存在 ignored `core/workspace/_runs/browser-source-ci-main-0f90fa7/`；ZIP 为 406750 bytes，SHA-256 `df32c6c67dc9629cc1cf103afd42f5d06ca773b5b5eb8b903721ed2117b9745e`，已核对为可读取的 ZIP。

此次 `artifacts.total_count=0`。CI stdout 保留新 Browser 的八项断言、运行 ID、报告摘要和计数；该批 fresh PNG 与原始材料没有作为 GitHub artifact 上传，因此不能据此声称第三方可以下载并逐字节复算这批 CI 截图。仓库内冻结材料及此前本地 fresh 原件仍是独立证据，不能混称为本次 CI artifact。

此 run 只验证上述纯投影 head；后续 Browser 私有读取器、owner 根目录身份加固及其新增测试均不在该 head 中，不计入本次通过范围。
