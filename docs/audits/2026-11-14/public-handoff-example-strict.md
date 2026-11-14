# `example.com` 一键交接 strict 与独立包复验

日期：2026-11-14。

## 结论

本轮使用 `https://example.com/` 做单页、单并发、无登录、公开只读试点。新版 `handoff --strict` 全流程退出码为 0：侦察 1/1 页、克隆 1/1 页、三视口 3/3、资产本地化 1/1、静态交付通过、严格离线交付通过。

严格导出报告为 `status=passed`、`published=true`、`blockingCount=0`；断网浏览器检查 1 页，失败 0 页，未测 0 页。之后把 live 包复制到独立目录，只从该目录启动零依赖 Node 服务，`/`、`/lm/example.com/` 和 `/__heimdall/health` 都返回 HTTP 200。

这证明公开单页样本的“侦察→克隆→还原度→strict 离线包→独立启动”链路可复核。它不证明整站覆盖、后端等价、登录业务或任意站点完整复刻。

## 运行与结果

运行数据写在仓库外：

```text
D:/Github-Star/heimdall-evidence-archive/2026-11-14/public-handoff-example-strict-20261114/
```

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\public-handoff-example-strict-20261114'
node core/src/cli.mjs handoff https://example.com --max-pages 1 --strict
```

| 环节 | 结果 | 证据 |
| --- | --- | --- |
| 侦察 | 1/1 页，范围受 `--max-pages 1` 限制 | `workspace/example.com/recon/atlas.json` |
| 克隆 | 1/1 页完成 | `workspace/example.com/pages/home/` |
| v2 还原度 | 3/3 视口，平均 100%，未测 0 页 | `workspace/example.com/verify/verify-summary.json` |
| 资产 | 引用 1 个，本地化 1 个，视觉缺口 0 | `workspace/example.com/audit/asset-gaps.json` |
| strict 离线 | `status=passed`，阻断数 0，浏览器 1/1 | `workspace/example.com/live-export.json`、live 包 `health.json` |
| 交接说明 | 写出 strict 通过与历史评分边界 | `workspace/example.com/handoff/README.md` |

独立包复验使用独立目录和本机回环地址：

```powershell
node serve.mjs --port 18142 --host 127.0.0.1 --offline
Invoke-WebRequest http://127.0.0.1:18142/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:18142/lm/example.com/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:18142/__heimdall/health -UseBasicParsing
```

三条路径均返回 200。复验目录只复制了 `example.com-live-2026-11-14` 包，没有挂载原始 workspace；脱敏检查记录在 `independent-deployment-check.json`。

## 证据边界

- 侦察只覆盖 1 页，不能推导 `example.com` 全部路径。
- 页面没有可观察 API；认证、权限、状态机、写入和副作用保持未知。
- 没有 QA 工作区；业务流程和无参照物缺陷没有完成站点评估。
- SEO/GEO 分数不属于本轮 strict 交付门禁，也不代表搜索排名或模型引用效果。
- `fidelity.csv` 是历史辅助评分；v2 多视口结果来自 `verify-summary.json`，两者不能合并。
