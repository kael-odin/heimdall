# `example.com` 公开站点三能力复测

日期：2026-11-16。范围：公开、匿名、只读；侦察上限 5 页，纳入当前侦察发现的全部同源 URL。

## 命令

```powershell
node core/src/cli.mjs handoff https://example.com/ --max-pages 5 --all-discovered --strict
node core/src/cli.mjs seo-audit https://example.com/ --max-pages 1
node core/src/cli.mjs probe contract --site example.com --json
node core/src/cli.mjs site-assessment example.com --limit 5 --json
```

## 克隆、交付和部署

| 检查 | 结果 |
| --- | --- |
| 侦察 | 1 页，0 条边；`maxPages=5`，深度上限未触发 |
| sitemap | `not_found`；robots 返回 404 |
| 多视口还原度 | 1/1 页完整测量，375/768/1440 三视口均 100% A |
| 视觉资产缺口 | 0；引用 1 个，本地化 1 个 |
| strict 离线导出 | 通过；0 个阻断 |
| 最终包断网验收 | 通过；Docker `network none`，1/1 路由，重启通过 |
| 断网浏览器 | 1/1 检查，失败 0，未测 0 |
| 交付范围 | `recon-discovered`，`scopeLimited=false` |

该结果证明当前侦察发现范围内的页面可以克隆、验证、导出并在独立断网包中运行。它不证明源站全集已发现，也不覆盖认证、写入、持久化或实时业务。

## SEO/GEO

| 指标 | 结果 |
| --- | --- |
| SEO | 52，等级 C；3 条 high、1 条 medium、3 条 low、6 条 info |
| GEO | 28.1；置信度 high；1/1 页、96/96 权重完整 |
| GEO 维度 | 可回答性 33.3、可抽取性 16、实体清晰度 20、引用准备度 50 |
| 观察到的行动 | 14 条，摘要返回 11 条并明确标记截断 |
| 真实搜索/收录 | unknown |
| 真实模型引用 | unknown |

后端观察型契约为 B0：0 个接口、0 个响应 schema，唯一未知项为 `no-observed-api`。这表示本次公开页面没有可判定的同源 API 证据，不表示源站没有后端。

主要整改证据包括缺少 meta description、缺少 H1、正文依赖客户端渲染，以及 GEO 的服务端正文、标题、分段、实体和结构化数据线索。分数只代表本次方法版本和采集范围。

## 站点评估结论

`site-assessment` 返回 `needs_human_review`：

- clone：多视口和独立部署 `verified`；
- SEO/GEO：报告可用，但有 3 条 high SEO 问题和 11 条 GEO 行动；
- backend：观察型契约为 B0，`no_observed_api`；认证、权限、状态机、写入和副作用保持 unknown；
- QA：`not_configured`，不能从页面无报错推断前后端没有缺陷。

证据位置：`core/workspace/example.com/handoff/README.md`、`core/workspace/example.com/live-export.json`、`core/workspace/example.com/deployment-verification.json`、`core/workspace/example.com/seo/seo.json`。这些运行产物被忽略，不进入提交。
