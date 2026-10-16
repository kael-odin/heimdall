# Spec / OpenAPI 阶段证据索引

本目录对应 [实施记录](../../acceptance-spec.md)。全部接口来自本机受控夹具，截图来自真实 Chromium；没有生产接口响应、账号或凭据。

| 证据 | 内容 |
| --- | --- |
| [固定基准](benchmark/benchmark.md) / [指标 JSON](benchmark/benchmark.json) / [真值](benchmark/truth.json) | 11 独立案例与 4 执行策略守卫；各案例完整报告、来源、合同、请求和响应随子目录保留 |
| [浏览器检查](console/browser-checks.json) | 17 项操作通过、两次运行 ID、390px 布局与零页面错误 |
| [手工报告](console/manual-report.md) / [OpenAPI 报告](console/openapi-report.json) / [预览](console/openapi-preview.json) | 手工批准清单、未批准候选与保留遗漏的最终结果 |
| [完整手工任务](console/run-evidence/ac-7b5a7528-617c-4032-b887-4e9d546fab66/manifest.json) | manifest、报告与扁平鉴权证据文件 |
| [完整 OpenAPI 任务](console/run-evidence/ac-5210041a-cc04-48e8-b02b-702fddd5c8a8/manifest.json) / [来源快照](console/run-evidence/ac-5210041a-cc04-48e8-b02b-702fddd5c8a8/requirement-source.json) | 完整来源文档、契约、请求、响应、遗漏、证据校验和 |
| [桌面](console/acceptance-spec-desktop.png) / [手机结果](console/acceptance-spec-mobile.png) / [手机表单](console/acceptance-spec-mobile-form.png) | 真实控制台截图 |
| [真实模型解读](console/ai-triage-configured-model.json) | 经过清洗的模型输入、解释建议、原报告 SHA-256 与未改写声明 |
| [页面回归](regression/mirror-browser-checks.json) / [页面基准](regression/mirror-benchmark.json) | Mirror 39 项结果与另一组 11 案例固定基准；完整原始页面证据仍保存在本机运行目录和上一阶段归档 |
| [质量门](quality-gates.json) | 全套 core 精确统计、原有 forge smoke 与基准运行指针 |
| [归档完整性](archive-integrity.json) | 本目录除完整性清单自身之外的文件字节数与 SHA-256，报告证据索引和规范化来源文档的核对数量 |

`outputDir`、临时端口和绝对路径是当时的执行记录；本目录的相对文件可以独立审阅。基准 JSON 内的本机路径不是长期下载链接。文档来源哈希需按对象键递归排序后重算，证据文件哈希直接按原始字节重算，两种口径不能混用。固定真值结果不能外推为真实项目检出率。
