# 双核测试调度修复本机证据

这是 Windows / Node 25 的本机结果，不替代修复提交自身的 Linux / Node 22 CI。

- [完整 Core 统计](core-stats.json)：2661 total、2649 pass、0 fail、0 cancelled、12 skipped、0 todo；实际命令使用文件并发 2。
- [冻结门禁记录](gates.json)：Core、lint、docs 真实 exit 0，维护输入前后相同；[构建](build.json)在该轮完成后另行执行。
- [调度检查](policy.json)：11 组实际维护 driver 调用，核对 P 映射、显式参数、唯一调用、真实 229 文件集合及退出码；ESM loader 只替换 CPU 查询和子进程调用，不冒充完整测试。
- [独立静态复核](review.md)与[归档索引字节核验](archive-index.json)：旧八 verifier、229 文件集合及失败原件保持。
- [维护输入前像](inputs-before.json)与[后像](inputs-after.json)固定本轮运行代码；源码改动仅调度 driver，报告文字和证据索引不属于这些运行输入。
- [运行时](runtime.json)记录实际本机版本；[文件清单](manifest.json)逐项保留来源、长度与 SHA256。

source/test-core.mjs、loader 和 Python 文件是本轮工具/输入快照。重跑 policy 或 gates 时，把 validate.py 与 policy-loader.mjs 放回仓库 ignored core/workspace/_runs/ci-small-runner-20261018/，从仓库根执行 python core/workspace/_runs/ci-small-runner-20261018/validate.py policy 或 gates。这里的 source 快照不作为新的测试发现根。

本机统计的 12 个跳过与 Linux 的 4 个跳过分别核对，不相互替代。CPU 查询替身仅用于策略检查，完整 Core 使用真实子进程与真实 Browser；该次并发 2 耗时不是跨平台提速证明。

原始 JSON 的 CRLF 保持不变，目录属性仅将 CR 识别为行尾，继续展示 JSON 文本 diff；原始 log 与带结尾空行的静态审查记录按二进制 diff 保存。其余文件继续使用正常文本 diff。
