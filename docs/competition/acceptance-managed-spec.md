# 托管 Spec：合同重建与派发准备

本阶段交付 B2.2-a 的私有准备内核：从项目当前明确选用的 Spec 需求重建计划，并为明确目标版本保存不可变派发准备记录。现有[需求基线界面](acceptance-baseline.md)仍返回 `executionReady:false`。本阶段没有新增托管 HTTP 端点、执行按钮、worker 或运行恢复。

## 已实现的准备合同

服务器内部的 `catalog.prepareManagedSpecDispatch(projectId,input)` 只接收 operationId、原目录双 CAS、selectionId、contentDigest 和 targetReleaseId。客户端不能提供计划、预期值、URL、批准标志或执行预算。首次准备必须核对项目、精确当前 selection、approval、candidate、来源归属与明确目标版本；取消选用的记录不具备执行依据。A → B → A 的重新选用会产生新的 selection，旧确认不能再次作为当前依据。

合同重建重复执行来源的完整原始字节验证，与存储候选的全部投影相比较。新 plan 继承已验证的 source、OpenAPI document、检查顺序、完整 expected / schema、omissions 与预算，只由服务器生成名称、取目标 release 的 URL，并将本次计划的 approved 设为 true。该布尔值来自目录批准；原 sourceSpecApproved 单独保存，原草稿仍是 false，原报告和门禁不变。实际响应不参与 expected 的构建。

来源版本与目标版本分别保存。candidate.source.releaseId 标识需求原件的归属，targetRelease 标识本次准备的执行目标。相同 URL 的两个版本不合并；跨项目的目标即使 URL 相同也拒绝。

准备操作与目录写入使用同一个串行队列。临时派发文件写完后、排他发布前，再核对 owner、目录原字节、当前选择和完整来源，避免把过期预览当作永久授权。准备不会修改 catalog revision / event，不创建新 run 目录、manifest 或任务，也不会请求目标。

返回值明确区分准备状态：

```js
{
  record,                 // 仅服务器内部：envelope / 原字节 / SHA-256
  replayed: false,         // 同一操作查询时为 true，不写入不可变记录
  state: 'prepared',
  runCreated: false,
  executionReady: false
}
```

envelope 中的 runId / taskId 只是预留身份，不能呈现为已经开始运行。私有 record 含完整计划和可能的 OpenAPI document；后续 HTTP 需要独立安全投影，不能直接返回整个对象。

## 操作 ID 与保存方式

sidecar 使用独立 schemaVersion=1，位于 owner 根内的 `managed-spec-dispatches/v1/`，不修改 catalog schema2。每个 operationId 对应一个完整、不可覆盖的 envelope，保存原确认请求、接受时目录及项目、selection / approval / candidate、来源与目标版本、原批准事实、新计划及各自摘要。

同一 operationId 固定绑定全部原确认字段，包括原 generation / revision。相同请求只返回同一 record，即使之后取消选用、来源缺失或目录不可读也不会重新准备。任一确认字段或项目不同，返回 `IDEMPOTENCY_CONFLICT`。复用原 operationId 不是重新执行指令。

只有确认 `ENOENT` 才能视作操作不存在。损坏、未知格式、链接、权限或文件身份问题都会阻塞；不能删除原件再分配新身份。容量有明确上限，不裁剪授权历史为新操作腾位。已存记录可查询，只有新增发布需要剩余容量。

写入顺序为完整 temporary → fsync → 最后复验 → 排他 link 发布。发布完整文件是准备记录被接受的语义提交点。发布前失败不会产生可执行授权；发布后报错则可能已经接受，必须保留文件并按原 operationId 查询。不会删除已发布文件冒充回滚。temporary 不会在重开时自动升级为已接受记录。

读取使用有界文件描述符，验证 owner、根与目录身份、regular file、长度、原字节摘要及二读结果。SHA 用于关联和发现意外损坏，不是管理员无法伪造的签名；发布也不构成整个目录的断电事务。

## 后续执行边界

重开本阶段的 prepared 记录只允许读取。升级、重启、同键重试、来源恢复或选用变化均不能自动创建 run 或发送请求。

B2.2-b 将接入持有 owner 的进程内异步 Spec executor，并补齐统一运行槽、取消 / watchdog / shutdown、不可变 manifest / report provenance 及中断恢复。只有新操作当次的受控流程可以开始执行；已存在的 prepared 记录不会因为扫描而启动。恢复不自动重发已中断请求，不声称远端 exactly-once。

B2.2-c 再提供明确目标版本的界面与真实浏览器闭环。Browser 基线、写请求、鉴权会话、持久 BUG 工单和自动关闭缺陷继续另行实施。当前新增内核不能被描述成托管执行已经可用。

实现与定向故障证据见[准备内核验收](../audits/2026-10-16/acceptance-managed-spec-preparation.md)。
