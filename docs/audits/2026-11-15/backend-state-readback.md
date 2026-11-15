# B3 写入后读回状态一致性实测

日期：2026-11-15。范围：现有受控本地 B3 夹具；没有使用生产账号，也没有宣称完整状态机等价。

## 实际流程

同一套 `state-rules.json` 同时包含两类写入规则：

1. `create-item`：执行 `POST /api/items`，只检查创建响应；
2. `read-created-item`：执行相同的创建，再从响应中的动态 `id` 请求 `/api/items/{id}`，并核对详情响应的 `id`。

检查器按最后一次写入后是否声明了 `GET` 或 `HEAD` 读回分类。只有声明流程全部通过时才写入 `stateConsistency=passed`；只有写入没有读回时写入 `incomplete`。动态 ID 仍只在进程内存中使用。

## 结果

| 流程 | 结果 |
| --- | --- |
| 写入后动态资源读回 | `stateConsistency=passed` |
| 只有写入没有读回 | `stateConsistency=incomplete` |
| 状态摘要 | 1 passed，1 incomplete |
| 站点评估 | 传递 `backendCompletion.stateConsistency` 和 `qaTask.scope.backend.completion.stateConsistency` |

定向 B3 测试 6/6 通过，站点评估测试 23/23 通过，语法检查 774 个文件通过。

## 边界

该证据只覆盖声明流程中的响应和后续读回。它不能证明重启后的持久化、事务回滚、重复提交、并发隔离、限流、消息、支付、Webhook 或其他未声明状态转换。
