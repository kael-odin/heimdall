# 人工动作的结果核对与永久拒绝

D6 接续[固定成员人工缺陷单](acceptance-defect-tickets.md)，处理成单或关闭请求已经发出、浏览器却没有得到完整决定的情况。操作者可以核对原动作，或明确永久拒绝这个动作号的迟到提交。只有服务端完整原件与浏览器保留的完整旧确认一致，页面才解除对应本机确认。

## 在工作台处理未知结果

1. 打开原项目的「人工缺陷单」。页面显示待核对动作的项目、单据、动作号、请求摘要和完整原确认。
2. 点击「只读核对原动作」时只发 GET。`unresolved` 表示没有查到完整决定，原确认继续保留，不能据此重新成单或关闭。
3. 若决定封住迟到请求，逐条核对完整原确认，勾选对应确认，再点击「永久拒绝此动作号的迟到提交」。页面先 GET 读取已有决定；只有仍未决定时才提交一次 deny 请求。
4. 既有成单或关闭已获胜时，返回其完整 `recorded` 原件；永久拒绝无法撤销已经记录的事件。若拒绝获胜，返回完整 `rejected` 原件，之后同动作的迟到成单或关闭只重放该拒绝。
5. 页面独立重算请求指纹、原件规范字节和 SHA-256，再在原生 Web Lock 内重核当前项目、上下文、持久集合和完整原确认，精确解除该条。拒绝结果不会被显示为成单成功或关闭成功，草稿继续保留。

deny 响应丢失、超时、5xx、4xx 或证明不完整时，原确认继续保留。再次读取仍只核对原动作，不自动重发原成单或关闭。用户主动再次选择永久拒绝时，仍先查询已有决定。普通的 GET absence 和错误响应都不是永久拒绝证明。

跨页协调限于同一前端 origin、相同 API origin 与项目。Web Locks 不可用、storage 不能安全回读或上下文发生 A→B→A 切换时，本次解除不会沿用旧权限。这里不提供手工清空未知确认或换号重试按钮。

## 决定合同

原 D5 confirmation / fingerprint v1 保持不变，不把当前目录 generation 或新数据根身份补入旧确认。拒绝原件严格包含：

```json
{
  "actionDecisionVersion": 1,
  "kind": "manual-defect-ticket-action-rejection",
  "original": "完整的 D5 version:1 原确认对象",
  "effect": "deny-late-manual-defect-ticket-action",
  "decidedAt": "ISO UTC 时间",
  "actor": { "kind": "local-operator" }
}
```

示例中 `original` 仅用文字占位，实际接口必须传入完整对象：`version`、`projectId`、`ticketId`、`kind`、`actionId`、`requestFingerprint`、`request`，且服务端与页面均独立重建指纹。额外字段、摘要不符、路径不符、旧确认内容不同均拒绝。

`recorded` 沿用原 accepted event 回执与原字节；`rejected` 包含完整 rejection 与 `rejectionSha256`。只给 outcome、摘要或动作号不足以解除确认。拒绝不写入单据事件链，不改变 revision、head、成员、处理状态或导出处理历史。

## HTTP 与持久化

新增 `POST /api/acceptance/projects/:projectId/defect-tickets/actions/:actionId/deny`，正文为 `{schemaVersion:1,confirmed:true,original}`。沿用 Token 鉴权与真实 owner，严格 application/json、UTF-8 和独立 65,536 bytes 正文上限。原 create / close 的 32,768 bytes 上限不变。

新决定需要当前项目、同步 readiness 和提交前后 guard，返回 201。已存在任意一种同指纹决定时返回 200；原 create / close 命中拒绝也返回 200 和完整 rejected 回执。同动作不同请求返回冲突。既有完整决定先于当前目录、来源、readiness 和新写队列容量核验；认证、真实 owner 与动作存储完整性仍必须通过。恢复受阻时只有精确 deny 路径可进入先读证明的逻辑，新决定仍受 readiness 阻断。

两类决定争夺同一个 `defect-tickets/v1/events/da-*.json` 物理文件，共用队列和不可覆盖发布。namespace、容量、提交前后校验包含全部决定；单据 snapshot 与事件链仅包含 accepted events。原件为 canonical JSON 加 LF，SHA-256 针对完整物理字节。

保证范围是同一真实数据根、保留不可变决定账本及正常重启。临时文件、双链接未收尾、部分目录和损坏原件会保留并阻断；不自动修补，也不承诺备份回滚、复制数据根或断电后的 exactly-once。

## 独立验证

新增浏览器入口 `core/scripts/smoke-acceptance-defect-ticket-decisions-console.mjs <freshOUT>`，以及只读独立核验 `core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs <OUT>`。四种新用例分别竞争 create / close 的 rejected / recorded 胜者；原 UI 请求正文只转发到一个上游 HTTP，前缀实际进入引擎后，浏览器收到明确的受控 HTTP 502，完整原确认保留。

拒绝先胜时，先取得拒绝原件再送完原请求尾部；事件先胜时，扣住用户真实 deny，先送完同一原请求，再转发该 deny。必须核对决定时序、唯一物理原件、完整 proof、本机精确解除、单据与导出语义，以及来源、Catalog、Browser 操作和目标请求不变。受控 HTTP 502 不代表 TCP 故障或断电测试；受控本机样例不构成任意站点保证。

本片的最终门禁、历次失败和精确提交 CI 结论以实施验收材料为准；新增脚本或源码专项通过不能代替完整浏览器链路通过。
