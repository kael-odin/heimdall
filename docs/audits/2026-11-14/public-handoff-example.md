# `example.com` 公开站点一键交接与离线部署实测

日期：2026-11-14。

## 结论

本轮使用保留域名 `https://example.com/` 做单页、单并发、无登录的公开只读试点。`handoff` 全流程退出码为 0：侦察 1/1 页、克隆 1/1 页、三视口验证 3/3、资产本地化 1/1、交付包生成。

同一数据根上的严格离线导出也通过：未解析资源、外链资源、缺页和浏览器离线失败均为 0。把交付包移出 Heimdall 工作区后，用包自带的离线服务启动，并从 `127.0.0.1` 请求 `/` 得到 HTTP 200 和 `Example Domain`。这证明当前公开静态样本的“抓取→验证→离线包→独立启动”链路可复核。

这不是任意站点或后端等价性的证明。侦察上限只有 1 页，站点评估明确保留 `api-contract-missing` 和 `qa-not-configured`；SEO/GEO 也仍有整改项。

## 实际命令与结果

执行目录：`D:/Github-Star/heimdall`。运行数据写在工作树外：

```text
D:/Github-Star/heimdall-evidence-archive/2026-11-14/public-handoff-example/data
```

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\public-handoff-example\data'
node core/src/cli.mjs handoff https://example.com --max-pages 1 --jobs 1
node core/src/cli.mjs live example.com --offline --strict --root mirror --rebuild
node core/src/seo/audit.mjs https://example.com --max 1
node core/src/cli.mjs site-assessment example.com --json
```

| 环节 | 结果 | 证据 |
| --- | --- | --- |
| 侦察 | 1 页，0 条边；范围因 `--max-pages 1` 受限 | `workspace/example.com/recon/atlas.json` |
| 克隆 | 1/1 页完成 | `workspace/example.com/pages/home/` |
| v2 多视口验证 | 3/3 视口，平均 100%，`bounded=0`，`untested=0` | `workspace/example.com/verify/verify-summary.json` |
| 资产扫描 | 1/1 引用本地化，视觉缺口 0 | `workspace/example.com/audit/asset-gaps.json` |
| 严格离线导出 | `status=passed`，阻断数 0，浏览器 1/1，运行探针 3/3 | `workspace/example.com/live-export.json`、交付包 `health.json` |
| 独立部署 | 离线服务 `/` 返回 HTTP 200，正文含 `Example Domain` | `deliverable/example.com-live-2026-11-14/` |
| SEO | 52 分，13 项问题，0 critical、3 high | `workspace/example.com/seo/seo.json` |
| GEO | 28.1 分，证据完整，但有 11 项行动项 | `workspace/example.com/seo/seo.json` |
| AI 站点评估 | `needs_human_review`；离线交付已观察通过 | `site-assessment.json` |

独立部署检查使用：

```powershell
node serve.mjs --port 48123 --offline
Invoke-WebRequest http://127.0.0.1:48123/ -UseBasicParsing
```

响应为 HTTP 200，`Content-Type` 为 `text/html; charset=utf-8`，正文长度为 5159 字节，页面标题文本可见。

## 评分口径修正

本次发现交付包的 `fidelity.csv` 为旧的像素、DOM、数据辅助评分，单页历史总分为 91；`verify-summary.json` 的 100% 是当前 v2 三视口门禁结果。两者来源和用途不同，不能合并成一个分数。

因此交接说明已改为明确写出“历史辅助评分”，`deliver` 的终端日志也改为 `avg historical fidelity`。现有 `handoff` 回归测试已覆盖这条口径，避免把 `fidelity.csv` 误读为 v2 多视口门禁分数。

## 未完成边界

- 只测到 `example.com` 的 1 页，不代表保留域名的全部路径，更不代表任意站点全集。
- 页面没有可观察 API，因此后端能力保持 B0；认证、权限、状态机、写入和副作用没有证据。
- 没有 QA 工作区，业务流程和无参照物缺陷没有完成站点评估。
- SEO/GEO 分数只表示当前规则、当前页面和当前证据；不等于搜索排名、模型引用或真实流量效果。
- `example.com` 是低风险公开样本，不能替代授权登录站点、动态 SPA、认证后端、实时连接和复杂资源站点的验收。

## 证据位置

完整原始输出、交付包、`health.json`、`live-export.json`、SEO 报告和站点评估 JSON 保存在：

```text
D:/Github-Star/heimdall-evidence-archive/2026-11-14/public-handoff-example/
```

