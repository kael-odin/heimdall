# 托管 Spec：合同重建、固定身份与核验读取

本阶段从项目当前明确选用的 Spec 需求重建计划，为明确目标版本保存不可变派发准备，并提供 owner 约束的固定身份存储。已完成记录现可经核验读取、下载证据及参与显式运行对比较；HTTP / 控制台也可读取安全投影。引擎启动已接入真实 owner 下的保守中断恢复；现有[需求基线界面](acceptance-baseline.md)仍返回 `executionReady:false`，托管执行入口与 worker 尚未接入。

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

envelope 中的 runId / taskId 只是预留身份，不能呈现为已经开始运行。私有 record 含完整计划和可能的 OpenAPI document；现有 HTTP 读取使用独立安全投影，不返回整个对象。

## 操作 ID 与保存方式

sidecar 使用独立 schemaVersion=1，位于 owner 根内的 `managed-spec-dispatches/v1/`，不修改 catalog schema2。每个 operationId 对应一个完整、不可覆盖的 envelope，保存原确认请求、接受时目录及项目、selection / approval / candidate、来源与目标版本、原批准事实、新计划及各自摘要。

同一 operationId 固定绑定全部原确认字段，包括原 generation / revision。相同请求只返回同一 record，即使之后取消选用、来源缺失或目录不可读也不会重新准备。任一确认字段或项目不同，返回 `IDEMPOTENCY_CONFLICT`。复用原 operationId 不是重新执行指令。

只有确认 `ENOENT` 才能视作操作不存在。损坏、未知格式、链接、权限或文件身份问题都会阻塞；不能删除原件再分配新身份。容量有明确上限，不裁剪授权历史为新操作腾位。已存记录可查询，只有新增发布需要剩余容量。

写入顺序为完整 temporary → fsync → 最后复验 → 排他 link 发布。发布完整文件是准备记录被接受的语义提交点。发布前失败不会产生可执行授权；发布后报错则可能已经接受，必须保留文件并按原 operationId 查询。不会删除已发布文件冒充回滚。temporary 不会在重开时自动升级为已接受记录。

读取使用有界文件描述符，验证 owner、根与目录身份、regular file、长度、原字节摘要及二读结果。SHA 用于关联和发现意外损坏，不是管理员无法伪造的签名；发布也不构成整个目录的断电事务。

## 固定身份存储与核验读取

内部[固定身份存储层](../audits/2026-10-17/acceptance-managed-store.md)提供实际 owner 约束的 create / progress / finish / settle：只接 operationId 与原准备字节摘要，固定 run / task / plan / 来源与目标；报告交叉核对真实 runner 的合同和证据，再以 completed manifest 作为提交点。半份报告保留为 partial，不能补成成功。

新增读取层在同一读取范围内重新核对派发 namespace、准备记录、manifest、报告及引用证据。`readAcceptanceRun` / `listAcceptanceRuns` 可读取 managed 运行状态；`readAcceptanceSnapshot` / `readAcceptanceSnapshots` 只把严格完成且通过核验的报告作为可靠快照。`completed + failed` 的真实 BUG 与 `completed + blocked` 的超时或预算受阻仍是完成事实；running partial、failed / interrupted 收尾不能作为完成快照或下载依据。

`readAcceptanceArtifact` 返回核验捕获的 bytes、SHA-256 和内容类型。JSON 下载保留原 bytes；Markdown 从同一份已核验 JSON 派生，不信任磁盘上的 `report.md`。证据下载只允许完成报告明确引用的文件，manifest、triage、sidecar、temporary 与未引用文件均不开放。比较通过批量快照在同一范围内读取双方，保留原有保守复验规则。

HTTP 列表与详情只返回安全 DTO，managed 记录明确带 `triageSupported:false`；不暴露 plan、完整 envelope、私有 receipt 或 owner nonce，基础设施错误使用脱敏说明。控制台支持查看状态、原门禁、引用证据与下载，尚不能发起托管执行。真实浏览器与故障验证见[托管读取验收](../audits/2026-10-17/acceptance-managed-reading.md)。

## 后续执行边界

引擎取得唯一 owner 后、接纳任务前，调用 `recoverOwnedAcceptanceRuns` 一次。恢复有界枚举实际 run 与预留 run 的并集，固定目录身份、dispatch namespace、manifest 和 legacy 两份 head；完整零写预检通过后，先中断 managed，再处理 legacy。只将可信的 running 收束为 `interrupted / blocked / ENGINE_RESTARTED`，不恢复请求或启动队列。

reserved managed 的恢复只消费 dispatch 和 manifest，partial report / evidence 保持不透明；坏 JSON、FIFO、链接、多硬链接和未提交临时文件不被读取或删除。completed / failed / interrupted 只核对 head 后跳过，不因历史证据损坏重写终态，也不因此获得可靠快照资格。prepared 仅在 run 目录完全不存在时跳过；空目录或缺 manifest 会阻断整轮预检。unreserved legacy 仍需读取 optional report，以排除仅报告带托管标记的降级。

恢复固定原始 manifest 的比较写入令牌，不能采用预检之后改变的新 running。上限为 1024 个 run、4096 个 root entry、4096 份捕获文件、256 MiB 捕获 bytes、每份 JSON 8 MiB、128 次收束；调用方仅可收紧。可预见的数量与终态字节预算失败在首次写入前拒绝。多 run 发布不构成事务，中途故障会保留已经提交的中断事实、准确计数与可能提交标识，并停止后续处理。

`GET /api/acceptance/recovery` 返回脱敏 readiness 和成功计数；这里的 ready 只表示启动恢复完成，不能代替仍为 false 的托管 `executionReady`。恢复受阻时保留目录诊断读取，所有验收 HTTP 写操作返回 `503 / ACCEPTANCE_RECOVERY_BLOCKED`，修复现场后需重启，运行中不自动重试。旧 root-only `recoverAcceptanceRuns` 也执行严格完整预检，只处理 legacy，不能获得 managed 写权限。实现和实际证据见[启动恢复验收](../audits/2026-10-17/acceptance-owned-recovery.md)。

执行控制基础已为私有 `runSpecAcceptance` 增加可选 `signal` 与同步 `assertActive`：控制失效停止当前请求及后续副作用，事件 callback 的等待也能取消，普通请求 timeout 保持原判定。私有 `catalog.readManagedSpecDispatch(projectId,input)` 则按完整原确认只读核对 record / null，不创建目录、不准备、不执行。null 不预留槽；新入口仍需在统一启动队列内再次核对。实现和限制见[执行控制验收](../audits/2026-10-16/acceptance-spec-execution-control.md)。

重开本阶段的 prepared 记录只允许读取。升级、重启、同键重试、来源恢复或选用变化均不能自动创建 run 或发送请求。

只读来源关联层保留严格原字节 provenance / linkage 校验。已迁移的读取入口可核验 managed 身份；普通 CLI、旧 mutation / finish / path artifact、candidate 与 triage 仍显式拒绝 managed / reserved 身份，删除 manifest / report 的托管标记也不能降级绕过。managed 完成运行仍不能经旧目录 bind 成新的需求来源。坏派发记录阻塞相关读取与恢复写入并保留原件，原隔离切片见[来源关联与隔离验收](../audits/2026-10-17/acceptance-managed-provenance.md)。

B2.2-b 后续先接持有 owner 的进程内异步 Spec executor、统一运行槽、取消 / watchdog / shutdown 与 task mirror，candidate / triage 消费者另行迁移。只有新操作当次的受控流程可以开始执行；已存在的 prepared 记录不会因为扫描而启动。恢复不自动重发已中断请求，不声称远端 exactly-once。

B2.2-c 再提供明确目标版本的执行界面与真实浏览器执行闭环。当前浏览器流程读取由显式内部 runner / writer 生成的记录，并验证启动时的保守中断；引擎 executor 尚未验收。Browser 基线、写请求、鉴权会话、持久 BUG 工单和自动关闭缺陷继续另行实施。整个阶段保持 `executionReady:false`。

实现与定向故障证据见[准备内核验收](../audits/2026-10-16/acceptance-managed-spec-preparation.md)。
