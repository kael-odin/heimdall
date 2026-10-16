# Spec / OpenAPI 只读契约验收实施记录

日期：2026-10-16。本阶段在已有 Mirror / Regression 工作台上增加无需运行基线的 Spec 模式。操作与输入格式见 [Spec 指南](../../competition/acceptance-spec.md)，前一阶段的页面对照记录保留在[原实施记录](acceptance-workbench.md)。本文的通过结论限定于下述检查和受控样本。

## 实现与使用边界

| 能力 | 本阶段实现 |
| --- | --- |
| 需求输入 | 手工来源 ID / 版本 / 契约，或 OpenAPI JSON 3.0 / 3.1 生成未批准候选 |
| 审批 | 操作者明确批准；修改目标、来源、原文、检查或遗漏立即撤销批准；历史恢复不自动批准 |
| 只读执行 | 匿名 GET / HEAD，明确状态、MIME、JSON Pointer 与有界响应 schema，不跟随跳转 |
| 覆盖与门禁 | 不支持的操作进入 omissions 并阻断；未批准任务零请求；明确 HTTP / JSON 缺陷失败，超时或预算不足受阻 |
| 来源追踪 | 完整独立 OpenAPI JSON、规范化文档 SHA-256、契约及来源指纹、批准记录；创建运行时重新校验来源哈希 |
| 证据 | 来源文档、契约、请求、响应 JSON，报告与鉴权下载；报告实际响应值有界摘要 |
| 控制台与 CI | 三模式切换、来源编辑与预览、批准撤销、历史与手机布局；API 基准和真实 Spec 控制台 smoke 接入 CI |

JSON Schema 执行器支持严格子集与独立计算预算，不补字段、不转换类型、不静默忽略未知关键词。OpenAPI 中远程或循环引用、认证、写方法、响应头合同、webhooks、缺少明确查询样例等均产生遗漏。完整支持范围及限制见指南。

## API 固定真值基准：离线复现

冻结运行 `spec-benchmark-2026-10-16T10-52-35-812Z-07e964f1`：从 OpenAPI 生成候选，核对来源，再由基准显式批准执行。耗时 **1198 ms**。

| 指标 | 结果 | 范围 |
| --- | ---: | --- |
| 案例校验 | 11 / 11 | 独立案例，不按断言数重复统计 |
| TP / FP / FN / TN | 7 / 0 / 0 / 4 | 7 个已知 BUG、4 个非 BUG |
| 执行策略守卫 | 4 / 4 | 预览零请求、未批准零请求、遗漏阻断、写方法拒绝 |

7 个缺陷分别是 HTTP 200 但业务码错误、字段缺失、类型错误、HTTP 状态错误、MIME 错误、JSON 无法解析、302 与声明的 200 不同。非 BUG 包括健康 GET、健康 HEAD、超大响应与超时；后两项保持 `blocked / environment`，不会当作通过。重定向目的地没有被访问。

上述数据仅说明固定注入夹具的检出与归因，不能推广为真实开发项目的精确率或召回率。完整[逐案结果](evidence/acceptance-spec/benchmark/benchmark.md)、[真值](evidence/acceptance-spec/benchmark/truth.json)和[指标](evidence/acceptance-spec/benchmark/benchmark.json)随证据归档，逐案目录保留原始合同与响应供复查。

## 控制台：真实浏览器操作受控 API

执行 `pnpm acceptance:spec:smoke`，真实 Chromium 通过构建后的控制台创建手工任务和 OpenAPI 任务，**17 项操作检查通过，0 页面错误**。覆盖预览零目标请求、修改后撤销批准、明确批准才能创建、来源指纹独立重算、来源 JSON 证据、下载、刷新回填原文且不自动批准、只读请求与 390px 布局。

OpenAPI 示例运行 `ac-5210041a-cc04-48e8-b02b-702fddd5c8a8` 有 **3 条结果：1 通过、1 确认 BUG、1 写接口遗漏受阻**，测量覆盖 **2 / 3**，门禁 `failed`。此处不能称为整份文档通过或 3 / 3 完整覆盖。手工运行 `ac-7b5a7528-617c-4032-b887-4e9d546fab66` 也按植入缺陷失败。

手机视口 390px，文档宽度 390px，结果内容宽度 368px。“查看结果”只滚动工作台内部，头部仍可见。证据见[浏览器检查](evidence/acceptance-spec/console/browser-checks.json)、[桌面](evidence/acceptance-spec/console/acceptance-spec-desktop.png)、[手机结果](evidence/acceptance-spec/console/acceptance-spec-mobile.png)、[手机表单](evidence/acceptance-spec/console/acceptance-spec-mobile-form.png)。两个已完成任务的完整 manifest / report / 证据文件均在归档 `console/run-evidence/` 中；旧失败调试运行仍保留在本机忽略目录，未混入本次最终证据。

## 配置模型解读与数据边界

使用本机已有 `deepseek-flash` 对上述 OpenAPI 报告的 **2 条非通过结果**进行独立解读，返回 `completed` 和 2 条有效建议。输入只含经过现有清洗器处理的报告摘要，没有来源文档或原始响应文件。调用后报告字节 SHA-256 未变，原门禁保持 `failed`。

这是受控报告上的真实模型调用，仍不证明真实业务的诊断准确性；建议不改变实测结论。[模型输入、输出与报告指纹](evidence/acceptance-spec/console/ai-triage-configured-model.json)可供复核。完整有界响应 JSON 仅保存在鉴权证据；报告的字符串、对象和数组实际值使用类型、长度及哈希摘要，数值、布尔和 null 保留。

本次模型建议仍有局限：一条复验 URL 粘连了中文说明并被编码到路径，另有“无 Location 头”的额外检查超出原合同；这些文字仅供人工参考，没有成为执行断言或新增 BUG。后续需要进一步约束和校验模型建议中的地址与复验条件。

## 实现中发现并修复的问题

- Windows 控制台闭环曾遇到 manifest 的 `EPERM rename`。新增同目录临时文件、单次 rename 与共享冲突有界重试；没有先删除旧 manifest。真实 PowerShell 子进程用不允许删除的共享句柄持锁，约 180ms 释放后写入成功，等待期间旧 manifest 保持完整。永久失败保留原因并清理本次临时文件。该反例已进入自动测试。
- 响应值可能通过 assertions、schemaFailures 和 mismatches 三条路径进入报告；三条路径统一摘要，并增加泄漏反例。
- 后续 schema 预算耗尽不能抹掉已确认的 JSON 断言缺陷；现在保留 `failed / bug`，另记 `evaluationLimited`。没有确定失败的预算超限保持受阻。
- HEAD 的响应头合同、webhook 和嵌套未知 schema 约束必须产生遗漏，不能只给 warning 后放行。
- HTTP JSON 请求体按 Buffer 合并后一次解码，避免 UTF-8 跨 chunk 被拼坏；OpenAPI 和完整运行清单各有明确上限。

最终独立只读复核未发现阻断项，另行探测嵌套 format、callback、可选 query 无样例、循环 response ref、外部 PathItem ref、HEAD headers 和 webhook，均保持 `complete=false` 与明确遗漏。

## 质量门与页面功能回归

| 检查 | 结果 |
| --- | --- |
| `pnpm -C core test` | **982 项，980 通过、0 失败、2 跳过**，225.158 秒；跳过项是既有 Docker 条件测试 |
| `pnpm -C core lint` | 311 文件语法检查通过 |
| `pnpm -C console build` | 通过 |
| 工作台 helper 测试 | 14 / 14 通过 |
| `pnpm -C core smoke` | 原有侦察、克隆、视觉 / DOM、SEO、交付、watch 与任务持久化通过 |
| `pnpm acceptance:benchmark` | 页面固定基准 11 / 11；TP7 / FP0 / FN0 / TN4 |
| `pnpm acceptance:smoke` | 原工作台真实浏览器 39 / 39 完整测量，36 通过、3 个植入行为失败、0 受阻，门禁按预期 failed |
| `pnpm acceptance:spec:benchmark` | API 基准 11 / 11，策略守卫 4 / 4 |
| `pnpm acceptance:spec:smoke` | 17 项操作检查通过，0 页面错误 |

本次 Windows 文件锁修复后，Mirror 与 Spec 控制台重叠复验均成功，未再次出现该落盘错误。这只验证本次复现条件，不推断所有并发环境均无波动。归档的[质量门摘要](evidence/acceptance-spec/quality-gates.json)和[页面回归摘要](evidence/acceptance-spec/regression/mirror-browser-checks.json)保留实际运行 ID。提交后还需单独核对本提交的远端 CI，不能从本机通过推断 CI 已通过。

## 证据治理与下一阶段

证据按[目录索引](evidence/acceptance-spec/README.md)归档，包含文件级字节 SHA-256、报告索引核对与独立文档哈希核对。OpenAPI 文档指纹是排序对象键后的完整 JSON 哈希；它不等于包装证据文件的字节哈希。运行端口已经关闭，旧 URL 只用于复现记录；本阶段没有删除历史证据或运行数据。

仍未覆盖真实认证、写入、数据库对账、完整 OpenAPI / JSON Schema、任意业务状态机、PRD 自动拆解或 Figma 意图。批准目前是操作者声明，不是组织权限或签名系统。下一阶段优先建设项目与版本基线、稳定问题指纹、复验及关闭记录，再用获授权的真实项目校准行为和视觉判据。
