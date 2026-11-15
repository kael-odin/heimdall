# `example.com` 当前 `handoff --strict` 全链路复验

日期：2026-11-15  
范围：公开、无登录、只读；没有写入、认证或业务副作用。

## 命令和证据

外部归档：`D:/Github-Star/heimdall-evidence-archive/2026-11-15/handoff-example-full-20261115-v1/`

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-15\handoff-example-full-20261115-v1'
node core/src/cli.mjs handoff https://example.com/ --max-pages 1 --jobs 1 --strict
```

交接报告：`workspace/example.com/handoff/README.md`  
strict 摘要：`workspace/example.com/live-export.json`

## 结果

| 阶段 | 结果 |
| --- | --- |
| 侦察 | 1 页，0 条边，退出码 0 |
| 克隆 | 1 / 1 页，退出码 0 |
| 多视口验证 | 1 / 1 页，375 / 768 / 1440 三视口，平均 100.0% |
| 资产扫描 | 1 / 1 页，视觉缺口 0，退出码 0 |
| strict 离线导出 | `passed`，`blockingCount=0`，1 页断网浏览器检查通过 |
| 最终包独立部署 | `verified`，Docker `network none`，1 条路由检查，0 失败 |
| handoff 退出码 | 0 |

这次 `live-export.json` 仍报告 `coverage.scope=recon-discovered` 和 `scopeLimited=true`。因此结果只证明当前侦察范围内的静态镜像与 strict 离线门禁通过，不能证明 `example.com` 全站全集已经发现。

交接报告已明确写出范围受限，并要求提高 `--max-pages` 后重跑；视觉分数和 strict 通过没有被包装成后端、认证、权限或业务等价。

## 独立部署证据

在 handoff 完成后，对同一最终包运行：

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-15\handoff-example-full-20261115-v1'
node core/src/cli.mjs live-verify `
  'D:\Github-Star\heimdall-evidence-archive\2026-11-15\handoff-example-full-20261115-v1\deliverable\example.com-live-2026-11-15' `
  --static --site-id example.com
```

报告：`workspace/example.com/deployment-verification.json`。报告绑定最终包校验和，在 Docker `network none` 中通过 1 条路由检查，失败数为 0。

这只证明最终静态包的独立启动和声明路由；它不证明交互包脚本、动态 import、fetch、表单或业务后端等价。

仍未知：认证、权限、写入、状态机、持久化、WebSocket、外部副作用、QA 业务检查和 SEO/GEO。

## `--all-discovered` 实际复验

为验证 AI 任务给出的范围动作，另用独立数据根运行：

外部归档：`D:/Github-Star/heimdall-evidence-archive/2026-11-15/handoff-example-all-discovered-20261115-v1/`

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-15\handoff-example-all-discovered-20261115-v1'
node core/src/cli.mjs handoff https://example.com/ --max-pages 1 --all-discovered --jobs 1 --strict
```

队列输出确认 `1 valid same-origin URLs / 1 atlas nodes` 全部进入队列；handoff 退出码为 0，strict 为 `passed`，最终包再次通过 `live-verify` 的 Docker `network none` 路由检查。

`--all-discovered` 只扩大当前 atlas 的入队范围，不能解除 `--max-pages 1` 的侦察预算。因此这次 `live-export.coverage.scopeLimited` 仍为 `true`，不能把它解释成全站发现完成。
