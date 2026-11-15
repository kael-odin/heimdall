# W3C 公开站点空页面 handoff 复测

日期：2026-11-16。范围：公开、无登录、无写入，最多 3 页。

## 命令和源站结果

```powershell
node core/src/cli.mjs handoff https://www.w3.org/ --max-pages 3 --strict
```

源站返回 HTTP 403，侦察得到 0 页、0 条边；sitemap 范围为 `unavailable`，原因包含 `robots-unavailable` 和 `sitemap-request-failed`。本次没有读取凭据、Cookie、令牌或写入源站。

## 修复前后

修复前，strict 导出在空 `pages` 目录上调用 `build_live` 时抛出 `ENOENT`，handoff 没有形成可读的严格门禁结果。

修复后，`build_live` 对缺失的 `pages` 目录生成 0 页空镜像，strict 导出继续完成诊断并退出 1。交接报告明确写出没有验证结果、正式包没有生成和独立部署未执行。

| 阶段 | 结果 |
| --- | --- |
| 侦察 | 0 页，源站 403 |
| 克隆 | 0 页，队列为空 |
| 多视口验证 | 未得到结果 |
| SEO/GEO | 本次没有有效页面样本 |
| strict 离线交付 | blocked |
| 独立部署 | 未执行 |

strict 健康摘要保留 4 个阻断：`mirrorRootMissing=1`、`coverageInvalid=1`、`reconFailures=1`、`emptyBundle=1`。这些计数说明输入证据不可用和候选包为空，不能被解释成站点视觉、后端或 SEO/GEO 通过。

## 价值和边界

该案例覆盖了被防护、不可达或没有可用页面证据的公开站点。Heimdall 现在会 fail-closed 地交付阻断原因和下一步，而不是把文件系统异常当成站点缺陷或流程崩溃。

它不证明 W3C 站点内容、SEO/GEO 分数、后端行为或独立部署结果；需要有效页面证据后才能继续这些检查。

## 证据位置

- `core/workspace/w3.org/recon/atlas.json`
- `core/workspace/w3.org/handoff/README.md`
- strict 候选目录中的 `health.json`（未提交）
