# D5 公开证据独立核验记录

当前重新采集的严格公开包已完成完整独立核验：真实进程退出码 0，状态 passed。结果见 [本次独立核验报告](review-12bb561c-be6b-4566-ae0e-39bc2137e35c/review.md)、[机器摘要](review-12bb561c-be6b-4566-ae0e-39bc2137e35c/summary.json)、[真实命令与执行元数据](review-12bb561c-be6b-4566-ae0e-39bc2137e35c/execution.json)、[报告集合字节清单](review-12bb561c-be6b-4566-ae0e-39bc2137e35c/publication-manifest.json) 和 [采集与统计来源说明](review-12bb561c-be6b-4566-ae0e-39bc2137e35c/publication-context.json)。

根目录 [summary.json](summary.json)、[review.md](review.md)、[execution.json](execution.json)、[stdout.log](stdout.log) 和 [stderr.log](stderr.log) 是第一次核验的原字节副本，代表历史失败：退出码 1、状态 failed、错误 Public binary preservation attributes differ。[首次失败说明](assessment.md)、[实际属性字节证据](attribute-observation.json)、[额外只读观察](observed-facts.json) 和 [首次失败集合清单](publication-manifest.json) 原样保留；后续成功未覆盖它们。

首次失败由生成的 .gitattributes 使用 Windows CRLF（9 字节）而 verifier 要求 LF（8 字节）引起。root 完整保留原包后，仅修正 collector 该行的字节写入方式并重新采集，未放宽 verifier。[重新采集溯源](repack-provenance/collector-change.json) 保存原字节副本、变更说明与移存清单。完整旧压缩归档在本机 ignored failure 目录保留，此公共溯源子目录没有重复整套旧归档。

本次通过对应 archive-index SHA-256 为 40897db2e88dbf78419d2908e4fcdff421f6f925a674bc94c3e6933aed8822b4；56 份压缩归档、36 组含历史 gate、17 组最终 gate、归档总字节 57162268。Core 原生 Node spec 汇总为 2661 tests / 2649 pass / 0 fail / 12 skipped，629 是最终 Core 完整 before 文件数，621 是剔除 8 个 console/dist 文件后的数量。核验已检查八个既有 verifier 文件与基准 Git blob 相同、D5 十项检查、四图 SHA/尺寸/DOM，以及请求和原件完整性。

本次是只读证据核验，没有重新启动 Browser、测试或引擎。PNG 签名、尺寸、SHA 与 DOM 检查不等于人工视觉审查；丢失响应采用 route.fetch/502 模拟；浏览器请求日志覆盖 /api/acceptance 范围；受维护输入清单不涵盖每一份 Markdown。它也不证明原子多文件快照或能识别自洽的外部备份回滚。全部边界见本次原始报告 limitations。
