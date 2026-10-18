# D6 独立校验器离线对照证据

本目录逐字节归档 2026-10-18 独立审查原件：原报告、脚本、原 verifier、输入摘要、结果 JSON，以及全部 stdout/stderr。`source-file-digests.json` 逐项记录源路径、归档路径、bytes、SHA256 和复制后相等检查；所有原件保持原始字节，局部 `-text` 防止换行转换，局部 ignore 只保留本目录证据日志。

23 个修复后离线控制均符合预期：2 个正例、21 个拒绝反例。正例人为重绑证据副本 manifest，仅隔离测试校验器，不能视为当前 bundle 的真实 Browser 运行。真实第七轮仅证明其旧冻结 bundle，修复后的当前输入门禁会拒绝该旧运行。普通 GET 取消未扩展为全请求零失败承诺。

为避免重复提交，六个含 Browser/runtime 的完整证据副本目录不在此归档；其来源绝对路径与变异操作保存在原报告和程序中，主真实 Browser 原件由独立 D6 浏览器报告负责归档。这里的原件完整性范围为本目录 manifest 明列的审查文件，不包含新 CI 结果。

先读 `originals/README.md`，再看 `originals/current-inputs-cases-results.json`、`originals/ingress-order-cases-results.json` 和相应原始日志。维护 verifier 冻结 SHA256 为 `c6017f8c608131cc577619d8fc515ef50c5457eee5cf4c191138f2989d9e993b`。
