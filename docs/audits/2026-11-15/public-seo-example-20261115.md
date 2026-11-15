# `example.com` 公开 SEO/GEO 任务包实测

日期：2026-11-15  
范围：公开、无登录、只读；使用当前 `handoff --all-discovered` 归档中的 1 个页面。

## 命令和证据

外部归档：`D:/Github-Star/heimdall-evidence-archive/2026-11-15/handoff-example-all-discovered-20261115-v1/`

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-15\handoff-example-all-discovered-20261115-v1'
node core/src/cli.mjs site-assessment example.com --json
```

来源报告：`workspace/example.com/seo/seo.json`  
任务包：`site-assessment` 输出中的 `deliveryPlan.seoGeoTask`

## 结果

| 指标 | 结果 |
| --- | --- |
| SEO | 52；评分方法 v13；测量 v8；两者均为 `current` |
| GEO | 28.1；方法 v8；状态 `complete`；证据置信度 `high` |
| GEO 页面覆盖 | 1 页；1 页已评分；0 页不可用 |
| GEO 检查权重 | 96 / 96；比例 1 |
| SEO/GEO readiness | SEO `needs_follow_up`；GEO `needs_follow_up` |
| observed 行动 | 14 条总量，返回 11 条；`truncated=true` |
| medium advisory | 1 条总量，返回 1 条；`truncated=false` |
| 总体评估 | `needs_human_review` |

本次改动后，AI 任务包同时输出：

```text
scores.geoConfidence = high
coverage.geo.pages = 1
coverage.geo.pagesScored = 1
coverage.geo.pagesUnavailable = 0
coverage.geo.observedWeight = 96
coverage.geo.totalWeight = 96
coverage.geo.ratio = 1
coverage.geo.confidence = high
```

这证明当前页面的 GEO 检查证据已完整进入任务包。它不证明全站覆盖、搜索排名、收录、流量或真实模型引用命中率。

行动列表被安全截断，AI 必须继续读取同一份脱敏 SEO 报告。当前可见的代表性行动包括 `content-description-missing`、`content-h1-missing`、`content-js-dependent`、`geo-answer-server-visible`、`geo-answer-title`、`geo-entity-type`、`geo-extract-structure`、`geo-extract-sections`、`geo-answer-headings`、`geo-extract-canonical` 和 `geo-entity-ownership`。

## 边界

`geo.status=complete` 只表示这 1 个已采集页面的 GEO 检查权重完整。`coverage.geo` 的页面统计与站点的 sitemap、侦察和克隆范围是不同证据；本归档仍保留 `scopeLimited=true`，不能把页面级完整解释成整站完成。

认证、权限、写入、状态机、持久化、WebSocket、外部副作用、QA 业务检查、搜索结果和真实模型引用实验仍未验证。
