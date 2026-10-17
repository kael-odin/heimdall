# Browser 来源核验：证据索引

此处为 2026-10-17 本地最终验证的发布副本。原始运行、完整 fresh 采集和失败现场保存在 ignored `core/workspace/_runs/`；代码与测试使用的固定真实材料位于 [source-index.json](../../../../../core/test/fixtures/acceptance-browser-source/source-index.json)。本目录未删除或改写原运行报告、截图和门禁。

| 文件 | 能证明的范围 |
| --- | --- |
| [fresh-smoke.summary.json](fresh-smoke.summary.json) | 8/8 检查、4 个 fresh Browser runs、8 个选侧案例，4 合格/4 拒绝，4 次确定性重查；投影 fetch=0 |
| [fresh-smoke.target-preview.json](fresh-smoke.target-preview.json) | 一次真实采集 target 侧的完整公开 projection/preview，28 条规则、8 个观测槽，executionReady=false |
| [fresh-smoke.stdout.gz](fresh-smoke.stdout.gz) | 新 smoke 原 stdout，包括独立运行 ID、原 gate 和原 report 摘要 |
| [independent-final.stdout.gz](independent-final.stdout.gz) | 独立专项 22/22，无 subtests；27.295 秒 |
| [independent-first.stdout.gz](independent-first.stdout.gz) | 早一轮 19/20，缺少 PNG 比较网格预算的失败保留；不算通过 |
| [03-core-test.stdout.gz](03-core-test.stdout.gz) | Windows Core 1841 total / 1833 pass / 0 fail / 8 skip；专项已包含在总数内 |
| [gates.exitcodes.json](gates.exitcodes.json) | 全部命令、开始/结束时间、墙钟、原始 stdout/stderr 路径与退出码 |
| [cdp-real-forge.json](cdp-real-forge.json) | 原控制台真实 CDP：taskStatus=done、cloneStatus=200、pageErrors=[] |
| [cdp-console-forge.png](cdp-console-forge.png)、[cdp-clone-artifact.png](cdp-clone-artifact.png) | 原控制台与克隆产物实际截图；不是新 Browser 来源 UI |
| [source-files.json](source-files.json) | 21 份证据副本的源路径、原件/存储长度与 SHA-256、处理方式 |

`01-core-lint` 和 `02-console-build` 两组 stdout/stderr 记录语法检查 434 files OK 与 Console 构建通过，保留既有大 chunk 提示。`04-core-smoke` 记录两页 fixture 的 visual/DOM 100.0%、health unresolved=0/externalAssets=0，以及 watch/jobs 持久化通过。

`05-cdp-clone` 是首次调用包装错误，原输出路径引号导致 mkdir 失败，浏览器没有启动；`06-cdp-clone-retry` 改正调用后 29.608 秒成功。两次 stdout/stderr 均保留，不把首轮失败改为成功或计为另一次通过。前四项质量门没有因此重跑。

所有 `.gz` 是原日志字节的无损 gzip，归档前解压并逐字节核对；其余 JSON/PNG 为 exact-original。没有裁剪或脱敏处理，内容均来自本地固定测试页及正常质量门。它们证明本地受控采集和字节核验，不能证明任意外部项目、认证业务、目录归属或执行入口已经交付。
