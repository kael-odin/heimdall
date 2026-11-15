# 公开站点评估摘要复核

日期：2026-11-16。范围：仓库已有的三个公开站点 workspace 证据。命令只读取站点评估摘要，不代表重新抓取源站，也没有使用登录态、Cookie、令牌或写入操作。

## 当前结果

| 站点 | 总状态 | SEO | GEO | sitemap | 后端 | QA |
| --- | --- | ---: | ---: | --- | --- | --- |
| `example.com` | `needs_capture` | 52 | 28.1 | `not_found` | `needs_observation` | `needs_human_review` |
| `rfc-editor.org` | `needs_capture` | 96 | 71.9 | `partial` | `needs_observation` | `needs_human_review` |
| `vitest.dev` | `needs_capture` | 90.7 | 65.6 | `not_found` | `needs_observation` | `needs_human_review` |

三个摘要都保留 `clone-not-captured`、`offline-delivery-not_recorded`、`api-contract-missing` 和 `qa-not-configured`。真实搜索/收录和模型引用实验也都保持 `unknown`。`rfc-editor.org` 额外保留 `seo-sitemap-scope-limited`，没有把页面级 GEO 完整误报成整站完整。

## 验证命令

```powershell
node core/src/cli.mjs site-assessment example.com --json
node core/src/cli.mjs site-assessment rfc-editor.org --json
node core/src/cli.mjs site-assessment vitest.dev --json
```

结果证明当前摘要能同时输出分数、范围、下一步和未知项。它不证明三个站点当前源站可访问，也不证明克隆、独立部署、后端等价或 QA 缺陷检出率。
