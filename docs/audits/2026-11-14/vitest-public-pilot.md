# `vitest.dev` 公开多页克隆、SEO/GEO 与离线边界实测

日期：2026-11-14。

## 结论

本轮使用公开站点 `https://vitest.dev/` 做 3 页、单并发、无登录的只读试点。侦察发现并克隆了首页、博客页和 `api/test` 文档页，当前交接报告保留了真实的不确定性：最新一次验证完整测到 2/3 页，平均观察分 99.5%；`api/test` 在 1440×900 视口的版面持续变化而未完成，`blog` 的视觉结果存在但证据证明为 stale，只有首页的当前证明有效。

这说明视觉还原可以很高，但仍不能直接宣称独立交付。严格离线导出被 113 个阻断计数拦下，主要包括未解析资源、外链资源、未捕获链接、第三方运行时和浏览器离线失败。

## 实测结果

数据根在工作树外：

```text
D:/Github-Star/heimdall-evidence-archive/2026-11-14/public-handoff-vitest/data
```

| 项目 | 当前结果 | 证据 |
| --- | --- | --- |
| 侦察 | 3/3 页；首页、博客、文档 | `workspace/vitest.dev/recon/atlas.json` |
| 克隆 | 3/3 页；186 个文件，63 个唯一文件，硬链接去重约节省 8.2 MB | `workspace/vitest.dev/pages/`、`audit/orphans.json` |
| 当前验证 | 2/3 页完整测到；平均 99.5%；首页最差视口 98.2% | `workspace/vitest.dev/verify/verify-summary.json` |
| 未测原因 | `api/test` 的 1440×900 版面在观察窗口内持续变化 | `verify/verify-summary.json` 的 `failedPages` |
| 证据缺口 | `blog` 视觉结果生成，但当前 `measurementProof` 未被确认 | `handoff/README.md` |
| 资产 | 260 个引用，175 个本地化；视觉缺口 0；85 个元数据/追踪/设计替代缺口 | `audit/asset-gaps.json` |
| 严格离线 | blocked；113 个阻断计数 | `live-export.json`、候选包 `health.json` |
| SEO | 91.3，等级 A；16 个问题，0 critical、0 high、4 medium、1 low | `seo/seo.json` |
| GEO | 62.2；complete；高置信度；6 个 P1 行动项 | `seo/seo.json` |
| 站点评估 | `needs_human_review`；API 缺失；QA 未配置 | 外部 `site-assessment.json` |

严格导出的主要阻断为：

```text
unresolved=12
externalAssets=4
unsupportedRuntimeServices=2
missingLinks=91
browserFailed=3
privacyIncomplete=1
```

这些计数可能来自同一根因的多个证据入口，不等于 113 个独立缺陷。

## 本轮代码改进

Vitest 暴露了 `handoff` 的两个口径问题：

1. 视觉结果存在但证据证明不完整时，报告以前写成“没有验证结果”，丢失了实际测量分数。
2. 验证子进程返回 0 但证据完整性核对失败时，最终入口仍可能打印“验证门禁通过”。

现在的交接报告会保留已生成的视觉测量，逐页列出 `stale` 证据；只要证据状态不是 `verified`，入口就返回 1。现有 `handoff` 单测覆盖完整收集多个未确认页面的场景。

## 边界

- 这只是 3 页公开范围，不能代表 Vitest 全站，也不能代表任意站点。
- 页面没有可观察业务 API；认证、权限、写入、状态机和副作用保持未知。
- GEO 分数表示证据准备度启发式，不表示真实模型引用率。
- 需要修复动态资源、未捕获链接和第三方运行时后，才能再次严格导出；复杂文档页仍需稳定等待条件或明确的有界测量策略。

