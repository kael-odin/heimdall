# Browser 启动结果核对与永久拒绝

Browser 启动请求的响应丢失后，工作台保留原启动确认并持续只读查询。若服务端始终没有完整决定，现在可以明确永久拒绝这个操作号的迟到启动。只有核验服务端的完整接纳或拒绝证明后，页面才解除对应的本机确认。

这条流程接续[固定来源 Browser 单次验收](acceptance-browser-execution.md)。它处理启动结果未知，不会批准候选、替换目标版本或自动开始新的验收。

## 在工作台处理待核对确认

1. 打开原项目的「固定来源 Browser 验收」。响应未知的启动会显示原 `bo-*` 操作号和原确认六字段，并阻止新的启动。
2. 先使用「读取操作并核对结果」，或等待页面只读查询。已有完整接纳记录时，核验通过后解除本机确认，从操作列表继续读取原运行。
3. 确认不再允许该操作号迟到启动时，勾选「我确认永久阻止此操作号的迟到启动」，点击「永久拒绝此操作的迟到启动」。
4. 服务端已有接纳记录时返回原记录；运行继续，拒绝动作不会停止它。原启动仍在接纳中时保留待核对状态。只有安全取得新决定的条件满足时，才保存永久拒绝。
5. 拒绝响应再次丢失时，保留确认，只读查询原决定。同一页面不会自动重发拒绝或启动；同一来源、端口和真实数据根正常重启后，也通过 GET 核对持久决定。
6. 解除确认后，要继续验收，重新复核候选与目标并明确批准。新批准使用新的操作号。

查不到记录、收到普通 4xx、操作列表出现同号记录、等待超过一定时长，都不足以解除确认。部分文件、混合决定或无法核验的记录继续保留现场并阻断。拒绝不设置过期时间，操作号不回收重用。

## 浏览器本机确认

本机持久内容仅为原六字段，不包含来源全文、来源 URL、截图或输入文本。保存及精确解除均使用同一 origin、同一项目的原生 Web Locks；锁内重新读取集合、核对六字段、写入并完整回读，支持两个页面并发。

开始新验收时，检查集合为空与保存本次唯一确认在同一锁内完成。两个页面同时批准时，只允许取得空集合的页面发送启动 POST；另一页读取原确认并等待核对，不产生额外确认。

浏览器不支持 Web Locks 时仅允许只读查询。读取损坏、保存失败或完整回读不一致时阻止新提交；本页面对发生写入故障的项目保持阻断。保留原现场并核对服务端决定，不能通过清空本机数据推断未启动。

启动及拒绝 POST 的 fetch 与正文读取有独立 60 秒期限。到期只表示页面无法确认结果，服务端可能已经提交决定。

## HTTP 合同

接口沿用引擎鉴权、真实数据根 owner 和项目范围：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/acceptance/projects/:projectId/browser-executions/:operationId/resolution` | 只读核对完整接纳、完整拒绝或尚未决定 |
| `POST /api/acceptance/projects/:projectId/browser-executions/:operationId/deny-start` | 明确拒绝该原操作号未来启动；已存在的完整同键决定仅返回证明 |

拒绝 body 严格为以下结构；`request` 必须是本机保存的原确认，不能刷新 generation、revision、候选或目标字段：

```json
{
  "action": "deny-future-starts-for-operation",
  "request": {
    "operationId": "bo-<UUID>",
    "expectedGenerationId": "ag-<UUID>",
    "expectedRevision": 12,
    "candidateId": "bc-<UUID>",
    "contentDigest": "<候选内容的64位SHA-256>",
    "targetReleaseId": "ar-<UUID>"
  }
}
```

resolution 的共同字段为 `schemaVersion:1`、`kind:"browser-start-resolution"`、`projectId`、`operationId`、`observedAt`、`outcome`。三个结果严格互斥：

| outcome | 额外字段 | 页面处理 |
| --- | --- | --- |
| `recorded` | 原 `request`、`requestFingerprint`、`dispatchSha256`、严格 operation view | 核对项目、原六字段及 domain fingerprint 后精确解除；原运行不重新启动 |
| `rejected` | `rejection`、`rejectionSha256` | 核对完整拒绝记录、原六字段、domain fingerprint 和 canonical JSON 加 LF 的原件 SHA 后精确解除 |
| `unresolved` | `reasonCode:ABSENT_OBSERVED` 或 `ADMISSION_PENDING` | 保留本机确认并阻止新启动 |

新拒绝要求当前恢复就绪、项目存在、目录 generation 与原确认相同，并取得与普通运行和 Spec 共用的执行槽；目录 revision 可以已增加。已有完整同键决定优先于当前目录、来源、readiness、busy 或 closing 状态读取。不同项目返回 404，同操作号的不同确认返回冲突。

`GET resolution` 不创建目录、不恢复运行、不占执行槽、不读取候选来源、不停止任务，也不发布决定。旧 operation / report / evidence / cancel 接口只服务完整接纳记录；拒绝决定通过 resolution 专用读取。

## 持久决定与范围

决定单元仍为真实数据根的 `acceptance/browser-operations/v1/bo-*/`。完整 accepted dispatch 与单文件 `rejection.json` 互斥。新决定需要独占创建目录与私有 claim；已有目录只核验，不能向部分现场补写。拒绝原件为严格 canonical JSON 加一个 LF，最大 16 KiB，独立计算 SHA-256。完成拒绝后，同操作号的迟到原请求返回 `BROWSER_START_REJECTED`，不创建 run、task 或目标导航。

源码变化后的 D4 检查验证器与 D3 保持不可比；连续 D4 通过也不能把旧 D3 检查问题自动标为可靠复验通过。来源读取的已审兼容清单独立维护，本片不扩充它。

本片保证当前真实数据根及保留事实的正常引擎重启。备份回滚、复制数据根、删除决定和突然断电后的 exactly-once 不在保证范围。Linux 目录元数据 flush 与 Windows 文件 flush 的实际边界分别保留，不把文件 flush 等同于完整掉电耐久性。

受控真实浏览器验证入口：

```powershell
pnpm -C console build
pnpm acceptance:browser:resolution:smoke
```

该脚本保留同一未完成 HTTP body 的收包摘要、决定原件、同 origin / 端口 / Browser context 的重启恢复、两页原生锁并发和桌面 / 手机截图。原 Acceptance console、托管执行和 D3 固定来源执行门禁仍独立运行。

冻结源码、修复经过、最终门禁与证据范围见[D4 实施验收](../audits/README.md)。
