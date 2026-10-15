# 浏览器探针运行时服务归类

日期：2026-10-16

## 背景

Vite 57 页样本在 `--remove-carbonads --replace-youtube --allow-unsupported-external-redirects` 后，静态扫描已经达到 `unresolved=0`、`externalAssets=0`、`unsupportedRuntimeServices=0`，但真实断网浏览器探针 57/57 页失败。旧版 `thirdPartyServices` 只看静态引用，报告没有解释这些失败来自哪些运行时服务。

## 变更

- `core/src/live/third-party-services.mjs` 现在同时读取静态引用与 `browserProbe.failures` 中的 `externalRequest`。
- 已知服务保留语义分类：
  - CarbonAds：`advertising`
  - YouTube：`video-embed`
  - Iconify 三个 API：`icon-api`
  - `sponsors.vite.dev`：`sponsorship-widget`
- 未登记的外部 origin 会保守归类为 `external-runtime`，不会因为不认识域名而漏报。
- 每个服务在出现浏览器证据时增加 `browserReferences` 与 `browserPages`；本地 404 仍留在 `browserProbe`，不伪装成第三方服务。
- 浏览器探针同时输出完整的外部 origin 聚合 `runtimeOrigins`；失败明细被截断时，报告顶层写 `browserEvidenceTruncated: true`，但 `browserReferences` 仍来自完整聚合。
- `core/src/live/export.mjs` 在浏览器探针完成后重建 `health.thirdPartyServices`，并同步 `strictBlockers.unsupportedRuntimeServices`。

## Vite 当前证据

复跑命令为同一 Vite 数据根下的 57 页 strict 导出（`--remove-carbonads --replace-youtube --allow-unsupported-external-redirects`）。候选包保留在 `deliverable/.candidate-vite.dev-cXtutk/`；浏览器探针 57/57 页失败、共 287 条失败证据。完整 origin 聚合后归为 5 类运行时服务：CarbonAds 54 次、Iconify 171 次、Vite sponsors 55 次、YouTube 1 次、GitHub 外部请求 2 次（`github.com` 与 `www.github.com` 合并）。

浏览器探针发现的外部运行时来源：

- `https://api.iconify.design`
- `https://api.simplesvg.com`
- `https://api.unisvg.com`
- `https://sponsors.vite.dev`
- `/team/` 页的 `github.com` / `www.github.com` 外部请求
- 运行时创建的 `cdn.carbonads.com` 请求
- `/blog/announcing-vite6/` 上的 YouTube 外部请求

另外首页有 3 个 `.riv` 资源返回本地 404：

- `/assets/563_x_420_rich_features.Gwgw8IXl.riv`
- `/assets/640_x_300_flexible_plugin.DzLLIuId.riv`
- `/assets/641_x_629_vite_masthead.CJXD3cz6.riv`

## 结论

该变更只改善失败报告的可解释性，不放宽 strict 门禁。Vite 交付包仍不得发布；下一步必须为 Iconify、sponsors、运行时 CarbonAds、YouTube 运行时请求和 `.riv` 资源制定显式策略，并复跑 57 页断网浏览器探针。
