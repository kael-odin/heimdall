# RFC Editor 公开 handoff 复测

日期：2026-11-16（北京时间；运行日志为 2026-11-15T21:14Z）。范围：公开、无登录、无写入的三页样本。

## 命令和范围

```powershell
node core/src/cli.mjs handoff https://www.rfc-editor.org/ --max-pages 3 --strict
```

侦察命中 sitemap 的 10,000 URL 上限，本次实际发现并交付范围为 `/`、`/about/contact` 和 `/about/rfc-editor` 三页。没有读取凭据、Cookie、令牌或写入源站。

## 结果

| 阶段 | 结果 |
| --- | --- |
| 侦察 | 3 页，范围受限 |
| 克隆 | 3/3 完成 |
| 多视口验证 | 3/3 页 × 375/768/1440，平均 100% A |
| 视觉资产缺口 | 0 |
| 资源引用本地化 | 81/155，52.3%；其余为元数据、追踪或设计替代引用 |
| 严格离线交付 | blocked；正式包没有被候选覆盖 |
| 独立断网部署 | 未执行；strict 未生成可验收的正式包 |

## 阻断归因

候选健康报告记录 133 个阻断计数：

- 1 个未审核的外部运行时服务：`analytics.ietf.org`，三页各观察到一次。
- 3 页各有一个本地 Nuxt 元数据 `fetch` 返回 404，路径为 `/_nuxt/1.168.1/builds/meta/dc498535-f2f5-4600-9f95-61553e39e02f.json`。
- 129 个当前三页范围外的链接。

静态资源 `unresolved`、动态缺口、外部资源和缺页计数均为 0。三页视觉 100% 不能覆盖运行时请求、整站范围或后端等价。

## 只读数据对照

源站对该 Nuxt 元数据路径返回 `200 application/json`，三页 HAR 都记录了相同的 88 字节响应。默认导出不会分发动态 JSON；随后为该精确路径写入 `read-data-plan.json` 并重跑 `--include-readonly-data`，计划本身通过校验，但三份请求都带 Cookie，清洗器按安全策略拒绝响应正文。最新健康摘要为 `readOnlyDataMissing=1`、`readOnlyDataConflicts=3`、`readOnlyData.rejected.authenticated=3`；这里的 `authenticated=3` 只表示三份当前证据带认证或 Cookie 边界，不推断业务私有性。

这确认当前缺口不是路径改写错误。`authenticated` 只是证据分类，不能成为放宽清洗策略的理由。要继续补齐，应在无认证、无 Cookie 的干净匿名上下文重新捕获，或提供明确授权且可公开分发的只读证据；不能把带 Cookie 的 HAR 当作公开数据回放。

## SEO/GEO 上下文

本次 handoff 没有重新运行 SEO 审计。当前 workspace 中可读取的报告为 SEO 96、GEO 71.9，GEO 页面覆盖完整；sitemap 因 10,000 URL 上限为 `partial`。真实搜索、收录、模型引用、API 契约、认证、权限和业务旅程仍未知。

## 证据位置

- `core/workspace/rfc-editor.org/handoff/README.md`
- `core/workspace/rfc-editor.org/live-export.json`
- `core/workspace/rfc-editor.org/recon/atlas.json`
- `core/workspace/rfc-editor.org/read-data-plan.json`（实验用的精确公开 GET 许可）

这些运行产物在工作区外部证据目录中，仓库只提交本摘要。
