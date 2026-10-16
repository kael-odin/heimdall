# 项目验收目录升级证据

本批以已提交的 B1 `8353595` 真实产物为只读夹具，复制到独立临时数据根，通过真实引擎与 Chromium 验证迁移。原始报告见[实施记录](../../acceptance-catalog-migration.md)。这里没有重新复制原 run 的 18 个文件；它们继续保存在[前一批真实运行证据](../acceptance-catalog/console/run-evidence/)，摘要和当前副本结果在本目录。

| 文件 | 内容 |
| --- | --- |
| [fixture-provenance.json](console/fixture-provenance.json) | B1 来源提交、目录及 18 个原文件指纹 |
| [catalog-v1-input.json](console/catalog-v1-input.json) | 精确原始 B1 head 字节 |
| [catalog-after-migration.json](console/catalog-after-migration.json) | 新 generation、revision 13、旧历史前缀与全局迁移 |
| [catalog-after-restart-1.json](console/catalog-after-restart-1.json) / [第二次](console/catalog-after-restart-2.json) | 两次真实重启的相同目录内容 |
| [catalog-after-b1-writes.json](console/catalog-after-b1-writes.json) | 迁移后继续创建项目、版本与归属，revision 16 |
| [migration-preimage.json](console/migration-preimage.json) | 原始字节与排他归档 SHA-256 一致 |
| [run-file-digests.json](console/run-file-digests.json) | 原件、主迁移副本与独立缺来源副本的逐文件摘要 |
| [migration-checks.json](console/migration-checks.json) | 11 项真实检查、布局和错误列表 |
| [api-cases.json](console/api-cases.json) | 12 项真实 API 观察与状态码 |
| [missing-source-scenario.json](console/missing-source-scenario.json) | 仅在独立副本省略一个 run 的诊断 |
| [target-attempts.json](console/target-attempts.json) | 针对旧夹具 origin 的请求记录，空数组 |
| [focused-tests.txt](checks/focused-tests.txt) | 77 项 schema / migration 文件系统与纯校验测试 |
| [core-tests.txt](checks/core-tests.txt) | 正式全量 core 最终摘要，1155 项、0 fail |
| [source-file-digests.json](checks/source-file-digests.json) | 验证时的实现、脚本和测试 SHA-256 |
| [quality-gates.json](checks/quality-gates.json) | 本机质量门命令、数字及实际范围 |
| [catalog-browser-checks.json](checks/catalog-browser-checks.json) | 原 B1 目录真实流程回归 |
| [forge-smoke.txt](checks/forge-smoke.txt) | 基础克隆流程结果，临时路径已脱敏 |

真实浏览器截图：

- [桌面目录](console/migration-catalog-1440.png) / [桌面归属](console/migration-binding-1440.png) / [桌面原失败报告](console/migration-failed-report-1440.png)
- [手机目录](console/migration-catalog-390.png) / [手机归属](console/migration-binding-390.png) / [手机原失败报告](console/migration-failed-report-390.png)
- [独立缺来源目录](console/migration-missing-source-390.png) / [独立缺来源归属诊断](console/migration-missing-source-binding-390.png)

所有新候选、批准和选用集合保持为空。上述记录不能证明候选批准、托管执行、Browser 冻结来源或持久 BUG 关闭已经实现。
