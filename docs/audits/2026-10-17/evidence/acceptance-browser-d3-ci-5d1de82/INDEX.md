# 5d1de82 hotfix 自身 CI 原件

精确提交 `5d1de82ac31fa48ef45ed0746591fbd0c710d264`，run `39044519602`，attempt 1；工作流及三个 job 均 success。

完整 Core：2461 total / 2457 pass / 0 fail / 0 cancelled / 4 skipped；18 组 acceptance smokes 全部 success，D3 执行 smoke 原日志为 16 checks passed；显式 Docker 为 2/2、0 skipped。

`run.json`、`jobs.json` 为完整 API 响应；`complete-stdout.log` 为 gh 完整日志；`run-logs.zip` 为 GitHub 原始日志包，`logs/` 为逐成员原字节展开。`verified-summary.json` 从原日志和 API 交叉提取结果。`INDEX.json` 为每个原件、可读副本及辅助文件记录 bytes/SHA；索引自身不自引用。

两个 Windows 专用用例在 Linux 跳过；完整 Core 内两项 Docker 未启环境也跳过，后续显式 HEIMDALL_DOCKER_TEST=1 步骤两项实际通过。条件性失败诊断上传步骤因成功而 skipped，不属于测试跳过或上述18项smokes。

此目录只追加本次 hotfix CI；此前 e3cc0ee failure 和既有 D3 ZIP 保持原样，不嵌套旧69MB包。不代表 D4 尚未提交改动或将来提交的 hosted CI。
