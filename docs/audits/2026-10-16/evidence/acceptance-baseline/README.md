# Spec 需求基线证据

本批使用当前实现，在独立临时数据根真实生成完整未批准草稿与目标失败的两份 Spec 来源，再通过真实引擎、API 和 Chromium 完成需求基线复核。原始材料与统计对应[实施验收](../../acceptance-baseline.md)。最终独立复跑的来源为本机运行目录 `core/workspace/_runs/acceptance-baseline-final/`；下列文件为其归档副本。

| 文件 | 内容 |
| --- | --- |
| [browser-checks.json](console/browser-checks.json) | 13 项真实浏览器检查、视口、故障注入及 0 新请求 / 运行 |
| [ci-022f345.json](checks/ci-022f345.json) | comparison smoke 运行槽等待修复提交的独立 CI success，包含 Docker 两项通过 |
| [complete-preview.json](console/complete-preview.json) | 全部 source、expected、schema、规则与候选身份 |
| [catalog-storage.json](console/catalog-storage.json) | 不可变候选、批准、选用、取消与回退事件 |
| [project-detail.json](console/project-detail.json) | 最终项目详情与取消实体的 currentSelections |
| [browser-posts.json](console/browser-posts.json) | 16 次浏览器 POST 及确认上下文 |
| [api-cases.json](console/api-cases.json) | 原始 API 观察序列；轮询次数受本机速度影响 |
| [fixture-requests.json](console/fixture-requests.json) | 来源 worker 创建阶段的 HTTP 夹具请求 |
| [tampered-source-preview.json](console/tampered-source-preview.json) | 来源改变后的不可核验诊断 |
| [run-file-digests.json](console/run-file-digests.json) | 两个 source run 的 14 个原始文件 SHA-256 |
| [run-evidence/](console/run-evidence/) | 两份来源的完整运行、合同及请求响应证据；归档前逐文件核对原始 SHA |
| [core-tests.txt](checks/core-tests.txt) | 最终全量摘要：1269 项、1267 pass、0 fail、2 Docker skip |
| [focused-tests.txt](checks/focused-tests.txt) | 125 项最终专项检查的完整输出 |
| [lint.txt](checks/lint.txt) / [console-build.txt](checks/console-build.txt) | 339 文件语法检查与前端构建 |
| [catalog-browser-checks.json](checks/catalog-browser-checks.json) | 原项目目录 17 项真实回归 |
| [migration-browser-checks.json](checks/migration-browser-checks.json) | 目录迁移 11 项真实回归 |
| [forge-smoke.txt](checks/forge-smoke.txt) | 原克隆 / live / watch / jobs 回归；临时数据路径已脱敏 |
| [source-file-digests.json](checks/source-file-digests.json) | 验证时的实现、脚本、测试和 CI 文件 SHA-256，明确 LF 规范化 |
| [quality-gates.json](checks/quality-gates.json) | 质量门命令、实际数字与范围限制 |

截图：[桌面完整合同](console/baseline-desktop-contracts.png)、[手机深色](console/baseline-mobile-dark.png)、[手机浅色](console/baseline-mobile-light.png)、[并发冲突](console/baseline-conflict.png)、[来源缺失](console/baseline-source-missing.png)。桌面为 1440×1000，手机为 390×844；两个手机主题的 document scrollWidth 都是 390。

本批全部基线操作仍为 `executionReady:false`。真实执行只用于生成原始来源；后续复核没有请求目标或创建运行。HTTP 502、响应丢失、迟到响应及文件篡改采用定向故障注入。上述材料不能证明任意真实站点验收、真实断电耐久、Browser 基线、托管执行或持久 BUG 关闭已经实现。本机 Docker 两项按配置跳过，提交后的 CI 另行核对。
