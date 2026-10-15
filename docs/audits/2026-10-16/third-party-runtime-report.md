# 第三方运行时与未镜像链接观测（2026-10-16）

本次复验使用 2026-10-15 的 Vite 57 页隔离工作区，不修改仓库 `core/workspace/` 或 `core/deliverable/`。严格导出仍失败并保留候选包；本报告只验证新增的可观测性，不把这些缺口视为已解决。

## 结果

- `links.missing=23`，合并为 **20 个唯一路径**。
- `missingLinkDetails` 分类为：
  - **12 个 `source-document`**：`/config.md`、`/config/*.md`、`/guide/why.md`、`/live.md`、`/plugins.md`、`/releases.md`。
  - **8 个 `path-alias`**：`/features`、`/build`、`/api-javascript`、`/api-plugin`、`/cli`、`/rolldown`、`/using-plugins`、`/why`。
  - **0 个 `resource-link`**。
- `thirdPartyServices.unsupportedRuntimeServices=2`：
  - **CarbonAds**：54 次引用、1 个唯一脚本 URL，分类为 `advertising / unsupported-runtime`。
  - **YouTube**：2 条证据、2 个唯一目标（外部 iframe 与本地化后未解析的 `_ext` 路径），分类为 `video-embed / unsupported-runtime`。
- `strictBlockers` 新增 `unsupportedRuntimeServices=2`；同次导出仍有 `unresolved=1`、`externalAssets=54`、`missingLinks=23`、`browserUntested=57`。旧正式包保留，候选包未发布。

候选包：`%TEMP%/heimdall-public-vite-wide-c40b0b28/deliverable/.candidate-vite.dev-JTiPDD`。

## 代码行为

- `core/src/live/health.mjs` 输出 `externalRefsTop` 与 `missingLinkDetails`：
  - 外部引用记录 URL、引用次数、是否必需、来源标签和页面，查询参数不进入报告。
  - 未镜像链接按 `source-document`、`path-alias`、`resource-link` 分类，并记录引用页；查询参数在明细中脱敏。
- `core/src/live/third-party-services.mjs` 将已知运行时服务归类为 `unsupported-runtime`。当前明确识别 CarbonAds 与 YouTube；普通 CDN 静态资产不会被误报为运行时服务。
- `core/src/live/export.mjs` 把 `thirdPartyServices` 写入 `health.json`，并把 `unsupportedRuntimeServices` 加入 strict 阻断项。该字段是更清晰的失败分类，不放宽任何原有门禁。

## 验证

- 针对性测试：47 项通过，覆盖健康扫描、缺失链接分类、外部引用证据、第三方服务分类和 strict 导出保留旧包。
- `pnpm lint`：275 个文件通过。
- 真实 Vite 57 页严格导出复验：新增报告与上述结果一致；导出仍按预期失败并保留候选包。

## 下一步

1. 为 8 个路径别名建立显式解析或补页策略；不能默认把根路径别名当作已覆盖页面。
2. 提高 `capturePublicTextLinks` 的目标预算并保留优先级，验证 12 个 `.md` 源文档能否全部捕获；超限时必须报告未捕获路径分类，而不是只写 `limited=true`。
3. 为 CarbonAds 与 YouTube 保留 `unsupported-runtime` 分类；若要提供本地占位，必须作为显式降级策略并单独验证 DOM/脚本行为，不得因移除或下载脚本而宣称业务等价。
