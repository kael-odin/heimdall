# Spec 需求基线：预览、批准与选用

“项目与版本”中的需求基线为完整 Spec 合同保存明确的人工决策历史。先将已结束的 Spec 运行归属本项目版本，再创建候选、审阅完整预期、批准，最后单独选用。候选、批准与选用各有独立实体、事件和目录修订号；批准、选用与取消还要求填写理由。批准不会自动成为当前选择。

本阶段批准的是需求合同。来源运行仍显示原来的通过、发现缺陷或受阻结论。一个 `spec.approved:false`、没有发出任何请求的完整草稿可以成为候选；一个发现目标业务 BUG 的已完成运行也可以提供完整需求。expected 只从保存的规范计划与合同证据重建，目标实际响应不能变成新的期望值。

全部候选、批准与选用响应明确返回 `executionReady:false`。选用保存本项目当前认可的需求。实际运行另由[托管 Spec 专用 HTTP 入口](acceptance-managed-spec.md)接纳完整新确认；此界面尚未增加执行按钮。Browser 基线、持久 BUG 工单和自动关闭缺陷继续后续实施。

## 操作流程

1. 在“项目验收 → 项目与版本”选择项目，为完整目标 URL 登记不可变版本，并明确认领来源运行。
2. 在需求基线区选择本项目已归属的 Spec 运行，创建候选。系统按完整运行 ID 读取原件，不按“最新通过”或 URL 自动选源。
3. 打开候选预览，检查来源 ID / revision、原门禁、原 `spec.approved` 状态、全部 method / path / expected 断言和 schema，以及执行规则。超出完整展示预算时直接拒绝，不截断后让操作者批准。
4. 填写理由并确认批准。批准记录追加到历史；当前选用保持原值，首次仍为空。
5. 从批准历史明确选择一条记录，重新预览并填理由后选用。切回旧批准也要重验其来源。取消选用单独记录；来源后来缺失时仍能取消。

目录冲突或网络异常会保留文本草稿、清除本次确认，并要求刷新核对。已发送的 POST 即使没有收到响应，也可能已经提交；客户端不会自动重发。刷新后先检查历史和修订号再决定下一步。

## 来源资格与完整性

候选必须来自本项目已经绑定的版本，完整目标 URL 与该版本一致。仅支持 `mode:spec`、`sourceSide:source` 和 `status:completed` 的完整合同；来源门禁可以是 failed 或 blocked。

读取器在目录 owner 内固定根和运行目录身份，用有界文件描述符读取原始 manifest、report 和全部报告引用证据。读取前后核对 regular file、路径、inode、长度和当前 SHA-256，再次读取比对。Buffer Map 只在服务器内部传给纯投影器，不进入目录、HTTP 或旧快照响应。

纯投影器独立核对原始文件字节与快照、原 report / plan / source / contract 指纹、规范计划、完整槽位、合同文件角色、OpenAPI 文档、报告 summary、每条检查的稳定身份与当前支持的规则版本。没有 omissions、没有截断、每个合同恰有对应检查及合同证据才合格。没有 request / response 的未批准草稿不因此失去资格；报告一旦引用证据，该证据就必须核验。

旧指纹保留原算法：`planFingerprint=SHA256(JSON.stringify(manifest.plan))`，source / contract 使用 Spec runner 规范化之后的 `JSON.stringify`。新的范围、规则、oracle、环境和引用证据摘要使用带版本与用途的 canonical SHA-256。只有实际被引用并核验的索引条目进入已验证证据摘要；未引用的额外索引不会被称为已验证。

当前只接受已审阅的规则实现指纹。相同已审源码的 LF / CRLF 原摘要显式列出；未知历史版本返回 `SOURCE_NOT_ELIGIBLE`，不会仅凭报告声称的 hash 选择当前规则。将来改动 runner、schema、identity、比较器或相关验证代码时，必须复核兼容映射和固定样本。

候选创建、批准与非空选用在同一写入队列内先检查双 CAS，再重新装载当前来源、重建投影。批准和选用还与存储候选及客户端确认摘要比较；写完 rolling previous 后、正式 head 提交前再重验一次来源。预览不是后续写入的永久授权。来源损坏、缺失或内容改变时保留历史，预览显示不可核验并禁用批准 / 选用。新 expected 不会冒充旧批准的预览。取消选用不读取来源。

## API

沿用引擎鉴权、`Cache-Control:no-store`、严格字段和 16 KiB 请求体上限。所有 POST 还要求 `expectedGenerationId` 与整数 `expectedRevision`，客户端不能提交 actor、服务端摘要定义、文件路径、current 或 `selectCurrent`。

| 方法与路径 | 业务字段 | 结果 |
| --- | --- | --- |
| `POST /api/acceptance/projects/:id/baseline-candidates` | mode=`spec`、sourceRunId、sourceSide=`source` | 创建不可变候选，返回完整 preview |
| `GET /api/acceptance/projects/:id/baseline-candidates/:candidateId` | 无 | 返回存储候选及当前重验 preview / diagnostics |
| `POST /api/acceptance/projects/:id/baseline-approvals` | candidateId、contentDigest、reason | 重新核验后追加批准，current 不变 |
| `POST /api/acceptance/projects/:id/baseline-selections` | mode=`spec`、approvalId、contentDigest、reason | 重新核验批准后追加选用；取消时两个引用字段均为 null |
| `GET /api/acceptance/projects/:id` | 无 | 返回候选、批准、选用历史及派生 currentSelections |

`GET` 单个候选成功找到历史时，即使来源失效也返回该候选，并令 `preview:null`、`diagnostics.eligible:false`。历史不存在返回 404，目录或 owner 失效返回 503。项目详情只读取历史摘要，不为每条历史批量装载全部证据。

项目详情的 `currentSelections.spec` 是最后一条 selection 实体；从未选用时才是 null。取消后仍返回该取消实体，其 `approvalId:null` 表示当前没有选用需求。消费者必须检查 `approvalId`，不能只依据 selection 是否存在判断当前选用。

新增错误 `409 BASELINE_CHANGED` 表示候选内容或确认摘要改变；`409 SELECTION_UNCHANGED` 表示当前已是该批准，或未选用时重复取消。二者都不推进修订号。其他来源错误见[项目目录指南](acceptance-catalog.md)。接口错误仅投影固定原因码，不回传绝对磁盘路径或原始文件内容。

## 保存方式与边界

schema2 的 candidates / approvals / selections 是严格不可变集合；每项对应一个创建事件，实体数等于 revision 和事件数。candidate 指向同项目已绑定 release；approval 固定其 contentDigest；selection 指向批准或 null，并记录同项目上一条 selection。读取时按事件顺序重放当前选用，不修改 project、不裁剪历史、不按时间或数组顺序猜测 current。

格式升级继续沿用[目录迁移合同](acceptance-catalog.md#目录格式升级)，旧 schema1 前像与 B1 实体保持原样。B2.0 二进制仅接受空的基线集合，不能用于回写已经包含批准历史的目录。

这些保护用于本地协作进程、意外损坏和可重试失败。当前目录不是签名审计账本，管理员可同时重写磁盘和摘要；不宣称跨文件事务、断电耐久或部署内容冻结。原始运行文件由当前引擎保持终态不可变；批准能力本身只写 catalog。

## 复现

```powershell
pnpm -C console build
pnpm acceptance:baseline:smoke
```

真实 worker、浏览器、API、故障反例与文件指纹的结果见[实施验收记录](../audits/2026-10-16/acceptance-baseline.md)。
