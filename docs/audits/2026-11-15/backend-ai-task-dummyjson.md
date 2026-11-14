# B3 AI 后端任务包公开 API 实测

日期：2026-11-15。范围：DummyJSON 单个公开只读商品接口；没有登录、写入、分页或业务副作用。

## 实际输入

源站：`https://dummyjson.com/products/1`

源站请求返回 HTTP 200。临时测试工作区只保留响应中的 `id`、`title` 和 `price` 三个公开字段，写入脱敏观察型契约和一个本地观察回放适配器，再运行：

```powershell
node core/src/cli.mjs backend scaffold dummyjson.test --json
node backend-scaffold/checks.mjs http://127.0.0.1:18081
```

## 结果

| 检查 | 结果 |
| --- | --- |
| AI 任务包 | `backend-task.json`，`ready_for_ai_draft` |
| 观察端点 | `GET /products/1` |
| 观察响应字段 | `id`、`title`、`price` |
| `provenance.invented` | 0 |
| 本地检查 | `passed`，4/4：health、adapter-coverage、路由响应、adapter-gap-ledger |
| 任务护栏 | 明确要求不得从 unknowns 推断认证值、权限、状态机、持久化或副作用 |

这次实测证明生成的 AI 任务包能从真实公开 API 的有限观察输入生成可执行上下文，并且独立服务可以复现该响应的状态码、MIME 和有限 JSON 结构。任务文件没有复制请求体、认证材料或原始响应正文，也没有把推断业务规则写成 observed。

## 边界

一次公开 GET 只能证明单端点只读回放；它不能证明分页、错误分支、认证、权限、写入、持久化、并发、业务等价或源站完整后端。下一步必须用获授权的多旅程数据补充 `state-rules.json`，再分别在源站与候选后端运行同一份 `business-rules-only` 规则。
