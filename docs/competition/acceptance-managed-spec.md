# 托管 Spec：合同重建、真实执行与核验结果

本阶段从项目当前明确选用的 Spec 需求重建计划，为明确目标版本保存不可变派发准备，并由持有 owner 的引擎执行真实只读 API 检查。完成记录可经核验读取、下载证据及参与显式运行对比较；控制台可查看运行进展、原门禁与中断结果。专用 HTTP 执行入口已接入“项目与版本 → 执行已选需求验收”；现有[需求基线界面](acceptance-baseline.md)的候选、批准、选用响应仍返回 `executionReady:false`，这些动作不会自动执行。

## 从工作台启动

1. 打开“项目验收 → 项目与版本”，选择项目。在需求基线中核对完整 Spec 候选，记录批准并明确选用。
2. 在“执行已选需求验收”点击“核对本次执行合同”。这里读取当前选用对应的候选，不沿用需求基线面板正在浏览的草稿。
3. 明确选择待验收目标版本，核对完整目标 URL 与登记的构建引用，勾选本次确认，点击“启动需求验收”。目录修订、选用或目标发生变化时，本次确认失效，需要重新核对。
4. “本机操作记录”显示原操作编号和状态；可请求停止运行，或打开运行与报告。执行完成与验收通过分别展示：正常完成的运行仍可能检出 BUG。

客户端先把不可变确认写入当前浏览器本地存储并读回，再发送一次启动 POST。每次请求只带 operationId、目录双 CAS、selectionId、contentDigest 和 targetReleaseId，计划和预期由引擎重建。恢复只查询原 project / operationId；网络失败、非 JSON 响应、启动失败或单次 404 都不能触发自动重发。只有明确的前置拒绝成功保存独立拒绝记录后，才允许重新核对并确认新操作。prepared 只有查询，没有继续执行入口。

当前浏览器同一项目仍有未知、未核对、prepared 或 running 操作时，暂停新确认。跨标签页新记录会清除确认；点击前再读本地记录。记录按引擎 origin、目录世代、项目及操作编号隔离，旧世代原操作仍可只读查询；不保存 token、plan 或 expected。关闭目录或隐藏页面会暂停轮询；未知 / prepared 自动核对有次数上限，之后可手动查询。停止响应丢失时，当前页面继续查询原运行，不能把停止请求当作中断已经完成。

本地存储不可用、损坏或达到每项目 100 条记录上限时阻止新启动并保留原记录。跨浏览器、人工清除浏览器数据和远端 exactly-once 不在该凭据机制的保证范围；操作归档管理继续后续实现。运行 head 只确认执行状态，完整报告与证据仍经既有读取接口核验。

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

HTTP 列表与详情只返回安全 DTO，managed 记录明确带 `triageSupported:false`；不暴露 plan、完整 envelope、私有 receipt 或 owner nonce，基础设施错误使用脱敏说明。控制台支持查看状态、原门禁、引用证据与下载；读取切片的真实浏览器与故障验证见[托管读取验收](../audits/2026-10-17/acceptance-managed-reading.md)。后续接入的明确版本启动、原操作恢复与停止见[执行工作台验收](../audits/2026-10-17/acceptance-execution-ui.md)。

## 启动恢复与执行边界

引擎取得唯一 owner 后、接纳任务前，调用 `recoverOwnedAcceptanceRuns` 一次。恢复有界枚举实际 run 与预留 run 的并集，固定目录身份、dispatch namespace、manifest 和 legacy 两份 head；完整零写预检通过后，先中断 managed，再处理 legacy。只将可信的 running 收束为 `interrupted / blocked / ENGINE_RESTARTED`，不恢复请求或启动队列。

reserved managed 的恢复只消费 dispatch 和 manifest，partial report / evidence 保持不透明；坏 JSON、FIFO、链接、多硬链接和未提交临时文件不被读取或删除。completed / failed / interrupted 只核对 head 后跳过，不因历史证据损坏重写终态，也不因此获得可靠快照资格。prepared 仅在 run 目录完全不存在时跳过；空目录或缺 manifest 会阻断整轮预检。unreserved legacy 仍需读取 optional report，以排除仅报告带托管标记的降级。

恢复固定原始 manifest 的比较写入令牌，不能采用预检之后改变的新 running。上限为 1024 个 run、4096 个 root entry、4096 份捕获文件、256 MiB 捕获 bytes、每份 JSON 8 MiB、128 次收束；调用方仅可收紧。可预见的数量与终态字节预算失败在首次写入前拒绝。多 run 发布不构成事务，中途故障会保留已经提交的中断事实、准确计数与可能提交标识，并停止后续处理。

`GET /api/acceptance/recovery` 返回脱敏 readiness 和成功计数；这里的 ready 只表示启动恢复完成。执行接纳状态另由 `GET /api/acceptance/execution` 返回。恢复受阻时保留目录诊断读取，所有验收 HTTP 写操作返回 `503 / ACCEPTANCE_RECOVERY_BLOCKED`，修复现场后需重启，运行中不自动重试。旧 root-only `recoverAcceptanceRuns` 也执行严格完整预检，只处理 legacy，不能获得 managed 写权限。实现和实际证据见[启动恢复验收](../audits/2026-10-17/acceptance-owned-recovery.md)。

执行控制基础已为私有 `runSpecAcceptance` 增加可选 `signal` 与同步 `assertActive`：控制失效停止当前请求及后续副作用，事件 callback 的等待也能取消，普通请求 timeout 保持原判定。私有 `catalog.readManagedSpecDispatch(projectId,input)` 则按完整原确认只读核对 record / null，不创建目录、不准备、不执行。null 不预留槽；新入口仍需在统一启动队列内再次核对。实现和限制见[执行控制验收](../audits/2026-10-16/acceptance-spec-execution-control.md)。

重开本阶段的 prepared 记录只允许读取。升级、重启、同键重试、来源恢复或选用变化均不能自动创建 run 或发送请求。

只读来源关联层保留严格原字节 provenance / linkage 校验。已迁移的读取入口可核验 managed 身份；普通 CLI、旧 mutation / finish / path artifact、candidate 与 triage 仍显式拒绝 managed / reserved 身份，删除 manifest / report 的托管标记也不能降级绕过。managed 完成运行仍不能经旧目录 bind 成新的需求来源。坏派发记录阻塞相关读取与恢复写入并保留原件，原隔离切片见[来源关联与隔离验收](../audits/2026-10-17/acceptance-managed-provenance.md)。

B2.2-b 已接持有 owner 的进程内异步 Spec executor，与普通验收共用一个运行槽。只有新操作当次准备正常返回、且仍持有原接纳许可的调用链可以开始执行；旧 prepared、查询、重试和重启均不能启动。取消、总时限、无进展时限和 shutdown 共用停止通道；runner 的完成事件只是进展，严格 writer 发布 completed manifest 后才形成完成事实。BUG 报告仍保留 failed gate，同时任务正常结束为 done。

## 专用 HTTP 执行合同

| 接口 | 用途 |
| --- | --- |
| `GET /api/acceptance/execution` | enabled / ready、busy、closing、blocked、运行槽身份及启动恢复状态；methods 表示允许目标请求 GET / HEAD |
| `POST /api/acceptance/projects/:projectId/spec-executions` | 对完整新确认接纳一次执行；首次返回 202，已存在操作只读返回 200 / replayed |
| `GET /api/acceptance/projects/:projectId/spec-executions/:operationId` | 读取 prepared / running / completed / failed / interrupted；不会重试、恢复或补发 |
| `POST /api/jobs/:taskId/cancel` | 请求停止，返回 cancelRequested；最终状态由执行结束和受控收尾决定 |

POST 只接以下确认，不接 plan、URL、expected、approved、runId / taskId 或预算。body 上限 16 KiB，必须是严格 UTF-8 JSON 对象；query 只允许单个鉴权 token，鉴权也可沿用请求头或会话。

```json
{
  "operationId": "ao-<uuid>",
  "expectedGenerationId": "<当前目录 generationId>",
  "expectedRevision": 1,
  "selectionId": "<当前 selection id>",
  "contentDigest": "<candidate contentDigest>",
  "targetReleaseId": "<明确目标版本 id>"
}
```

相同 operationId 的完整确认核对先于 busy 检查，因此占槽期间仍可查询旧操作。同进程并发同键合并；不同确认返回 409 / IDEMPOTENCY_CONFLICT。只有确认记录不存在时才预留槽；其他新验收返回 409 / ACCEPTANCE_BUSY。目录队列首行、准备前和最终发布均核对原接纳许可，队列内撤销不能偷偷准备。

固定 taskId 在 run 创建前核对内存与可用任务库，冲突或查询故障不能被当作空位。任务库和 SSE 仅为可降级投影；`/api/jobs` 的 store 为 null 时表示仅内存。重启只从核验过的运行事实对齐任务历史：完成 BUG 对应 done，取消对应 cancelled，重启中断对应 interrupted。绑定、报告或证据无法核验时，任务投影标记 failed / MANAGED_MIRROR_UNAVAILABLE；原运行不被改写。

不确定发布不重复 finish / settle，也不放行新验收。引擎先仅读 manifest，只有完整完成快照核验后才投影完成，blocked latch 保留到重启。owner 或原目录 / dispatch / head 身份丢失停止副作用；丢失 owner 不进行收尾写入。shutdown 先关闭接纳、停止请求与子进程，再等待同一 finished，最后关闭 jobs 与退出；超出宽限直接退出整个进程。

完整请求 body 已被接纳后，HTTP 断连不会取消执行。响应丢失应携带原 operationId 查询；不完整 body 不接纳。此机制不承诺远端 exactly-once。实现与真实 HTTP / CDP 证据见[托管执行验收](../audits/2026-10-17/acceptance-managed-execution.md)。

B2.2-c 已接入明确目标版本的执行界面、原操作只读恢复与请求停止。Browser 基线、写请求、鉴权会话、持久 BUG 工单、操作归档管理和自动关闭缺陷继续后续实施；candidate / triage 仍隔离，原 source 草稿、报告和门禁保留。

实现与定向故障证据见[准备内核验收](../audits/2026-10-16/acceptance-managed-spec-preparation.md)。
