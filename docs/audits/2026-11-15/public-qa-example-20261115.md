# `example.com` 公开 QA 与站点评估实测

日期：2026-11-15  
范围：公开、无登录、只读；请求策略为 `writes=block`。

## 命令和证据

测试工作区位于仓库外，归档在 `D:/Github-Star/heimdall-evidence-archive/2026-11-15/qa-example-20261115-v1/`。配置只声明 `example.com/` 一个页面。运行使用 1440px 与 390px 两个视口，并关闭跨运行视觉基线。

```powershell
$env:HEIMDALL_QA_WORKSPACE = 'D:\Github-Star\heimdall-evidence-archive\2026-11-15\qa-example-20261115-v1'
node core/src/cli.mjs qa run web --workspace $env:HEIMDALL_QA_WORKSPACE --viewports 1440,390 --no-baseline --json
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-15\handoff-example-full-20261115-v2'
node core/src/cli.mjs site-assessment example.com --qa-workspace $env:HEIMDALL_QA_WORKSPACE --json
```

## 结果

| 指标 | 结果 |
| --- | --- |
| 页面/视口 | 2 / 2，均可导航 |
| 检测器 | 运行 2 页，0 页失败 |
| 检测发现 | 1 条，`a11y-heading` |
| 建议提单 | 0 条 |
| 可容忍观察 | 1 条 |
| QA readiness | `ready` |
| QA AI 任务 | `ready_for_ai_review` |
| 业务检查点 | `not_declared`，0 条；交付计划新增 `qa-business-checks` |
| 后端契约 | `missing`，仍未知 |

`site-assessment` 现在在脱敏 `qa.latest.coverage.detection` 中返回检测页数、发现数、失败页数和 detector 名称。`qaTask` 同时提醒 AI：检测发现仍需读取 finding 证据并完成人工裁决，不能直接当作已确认 bug。

本次复验还返回 `qaTask.scope.backend.completion.status=blocked_on_observation`、`currentLevel=B0_or_lower`、`observedEndpoints=0`，并保留 authentication、permissions、state-machine、business-rules 和 side-effects 五类未知；页面 QA 因此没有升级为后端完成。

后端复测摘要同时为 `businessRules=not-tested`、`businessRuleComparison=not_run`、`adapterEgress=unknown`、`operationProbe=not-tested`；这些状态让 AI 能直接选择补业务规则、候选等价对照、服务端外联验收或浏览器操作计划。

由于本次 QA 没有声明业务检查点，任务包还要求补充 PRD、业务流程和接口响应断言。页面 QA 的 `ready` 只表示已声明的页面检查完成，不表示业务后端已验收。

这次结果只证明公开页面的导航和无参照物检测链路完成。它不证明认证、权限、API、状态机、写入、持久化、外部副作用或完整站点没有缺陷。
