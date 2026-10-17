# Catalog schema3 精确提交 CI

GitHub run [38996824641](https://github.com/kael-odin/heimdall/actions/runs/38996824641)，attempt 1，head `db3cd3fd9efe7e46ae079cab8d529e64a14b842b`，分支 `main`，事件 `push`，结果 **completed / success**。三个 job 均成功，时间线见 `summary.json` 与原始 `jobs.json`。

- Linux Core：**2130 total / 2126 pass / 0 fail / 4 skip**，耗时 937584.349778 ms。
- Acceptance smoke：**13/13** 成功；各原始结构化摘要保存在 `summary.json`，不包含后续片 B 的 binding smoke。
- Docker 独立步骤：**2 total / 2 pass / 0 fail / 0 skip**。
- Actions artifacts：**0**。

Core 只计远端这一次完整测试；smoke 与 Docker 单独报告，不加入 Core。未使用本机测试或其他提交 CI 替代该 run。跳过项目的原始 TAP 行见 `summary.json`。

`run.json`、`jobs.json`、`artifacts.json`、`run-view.json` 和 `workflow-content.json` 是精确 gh/API 输出；`workflow-at-head.yml` 直接由 GitHub 在该 commit 返回的内容解码并验证 Git blob SHA-1。`ci.stdout.log` 为完整 gh 渲染日志；`run-logs.zip` 为 GitHub 原始 ZIP，包含 59 entries，所有 59 原日志已解压到 `extracted/` 并验证 CRC 和每个文件的字节。Linux Core 与 Docker 数量在 gh 输出及独立 ZIP step log 两边一致。

This run uploaded no Actions artifacts; exact logs and ZIP entries are preserved, but fresh remote screenshot/run trees are unavailable and are not reconstructed from local materials.

`commands/` 保存每条命令（含参数、起止时间、退出码、stdout/stderr 原字节）的全部尝试；未读取或输出认证凭据。`sensitive-scan.json` 对全部 59 份解压日志独立扫描，所列强凭据模式匹配 **0**；关键词出现次数另记，零匹配仅适用于记录的正则范围。

目录只使用 new-only 写入；`.gitattributes` 阻止原始字节行尾转换。`file-manifest.json`、`SHA256SUMS.txt` 与最后写入的 `COMPLETED.json` 组成完成校验链，缺失完成凭据代表不完整尝试。清单明确排除其自身、SHA 文本和完成凭据，以避免循环摘要。
