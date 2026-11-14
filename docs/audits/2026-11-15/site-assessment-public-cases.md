# `site-assessment` 公开案例复核

日期：2026-11-15  
范围：本机已保存的公开只读证据；没有登录、写入或业务副作用。

## RFC Editor

命令：

```powershell
node core/src/cli.mjs site-assessment rfc-editor.org --json
```

当前摘要：

| 项目 | 结果 |
| --- | --- |
| 站点评估 | `overall=needs_human_review`，`stage=human_review` |
| 镜像与视觉 | 6/6 页有镜像，6 页多视口验证 |
| 离线交付 | `blocked` |
| 浏览器失败 | 12 条候选失败摘要 |
| 二进制缺口 | 2 个 PDF 下载链接，需要人工授权审核 |
| SEO/GEO | SEO 90（评分 v13、测量 v8），GEO 71（方法 v8），sitemap `partial` |
| 后端与 QA | API `missing`，QA `not_configured` |

这次复核证明 `site-assessment` 能把视觉、离线交付、SEO/GEO 范围、二进制分发、API 和 QA 缺口放在同一份交付计划中。它没有把 6 页视觉验证解释成后端完成，也没有把页面级 GEO 证据解释成完整站点覆盖。

## Xspark 公开案例

命令：

```powershell
node core/src/cli.mjs public-case-summary --case-path docs/cases/xspark/2026-11-04 --json
```

当前公开摘要显示 5 页、10 次页面/视口检查、QA 门禁通过、可提单 0 条、视觉回归 0 条、SEO 90.8；真实用户 PageSpeed 数据不可用，GEO 仍为 `unknown`，没有认证后台、写入流程、结账、支付或账户变更证据。

## 结论与边界

- 公开案例已经能区分“页面与 SEO 证据充分”和“后端、认证、权限、业务 QA 未知”。
- RFC Editor 仍被动态请求、外链运行时、未镜像链接和二进制审核阻断，不能作为独立离线交付通过案例。
- 同一 RFC Editor 报告已复核 `deliveryPlan.seoGeoTask`：SEO 90、GEO 71，评分和测量口径均为 `current`，sitemap 为 `partial`，任务状态为 `ready_for_ai_review`，返回 6 个脱敏 observed 行动项，`provenance.invented=0`，输出未命中 Bearer、private-value 或 super-secret。它给 AI 提供了当前优化上下文，但 sitemap 范围和真实搜索/模型引用效果仍未被证明。
- 同一评估的 `deliveryPlan.qaTask` 为 `blocked_on_qa_evidence`：QA 未配置、前端运行页数未知、后端契约为 `missing`、`invented=0`，且摘要未泄露敏感值；它正确要求先补匹配 QA 工作区，而不是把页面和 SEO 证据当成缺陷检测完成。
- Xspark 的 QA 通过只适用于其 5 页、10 次检查和声明范围，不能外推为任意站点检测准确率。
- 下一步需要获授权真实站点的登录、权限、写入、状态机和完整 QA 旅程；公开只读复核不能替代这些证据。
