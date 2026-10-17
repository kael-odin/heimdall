# 固定来源的人工缺陷单

人工缺陷单把同一次已完成、已显式登记的 Browser 验收失败固定为一组待处理检查。成员、原始来源和原件摘要成单后保持不变。最新的一次登记必须覆盖全部成员并可靠通过，才符合明确关闭条件。关闭后再登记可靠失败，缺陷单显示为重新打开；后来再次通过仍需重新明确关闭。

D5 接续 [Browser 固定来源验收](acceptance-browser-execution.md)。检查账本仍保存原来的检查级事实，人工缺陷单使用独立存储，不修改目录格式、比较门禁或旧验证器。入口位于「项目验收」的当前项目下。

## 在工作台操作

1. 在「项目验收」展开项目目录，选择项目。先在固定来源 Browser 验收中完成一次检查，并显式登记结果。
2. 在「人工缺陷单」展开创建表单，选择参考候选和一次登记操作。只有可靠失败可以选择；同一张单关联 1–24 项检查。
3. 填写标题、严重度、问题说明和复现步骤，勾选确认后创建。成员、来源操作、报告 SHA、登记 SHA 和证据索引一起固定。
4. 在原 Browser 流程完成修复后的验收，显式选择此前操作并登记复验。缺陷单的「处理状态」与「当前核验」分别展示。
5. 打开缺陷单，点击「预览最新登记复验」。工作台先重新读取单据，再自动使用该单据当前最新登记操作生成预览。处理说明可提前编辑；全部固定成员在同一次复验可靠通过时，才允许勾选确认并明确关闭。只修复部分成员、空登记、未覆盖成员、条件变化和原件损坏都会阻止关闭。
6. 后续可靠失败会派生重新打开状态。再次通过只更新核验结果；再次明确关闭会追加一条新的处理事件。
7. 下载 Markdown 或 JSON，交给开发者复查固定来源、逐项结果及处理历史。

刷新、读取列表、预览、导出与动作核对都不会开始验收、登记结果、请求目标站点或修改检查账本。此人工流程不代表整个项目已修复，也不推断未声明的页面和业务流程。

关闭预览不会持续自动更新，也不能在界面手选旧操作绕过最新登记。预览后单据或验收事实变化时，服务端会拒绝旧确认，需重新读取并预览。

## 两组状态

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `processingStatus` | `open` | 已成单，尚无明确关闭事件 |
| `processingStatus` | `closed` | 已有明确关闭，之后未发现已核验的可靠失败 |
| `processingStatus` | `reopened` | 关闭后又登记可靠失败；再次通过不会自动关闭 |
| `verificationStatus` | `verified_passed` | 最新同范围登记一次可靠通过所有成员 |
| `verificationStatus` | `partially_passed` | 只有部分成员可靠通过 |
| `verificationStatus` | `still_failed` | 最新登记仍有可靠失败 |
| `verificationStatus` | `incomparable` | 条件、检查身份或验证器不同 |
| `verificationStatus` | `unverified` | 最新登记未完整复验固定成员 |
| `verificationStatus` | `integrity_blocked` | 当前来源无法完整核验；可信处理历史继续保留 |

历史关闭与当前核验独立。因此原件后来受损时，可同时显示历史处理已关闭与当前核验受阻，导出中的 `repairVerified` 为 false。显示历史关闭不等于声称当前证据已经证明修复。

“最新”指同项目、candidateId 与 contentDigest 内按 `acceptedAt`、`recordedAt`、`operationId` 排序后的最后一项已登记操作。后来登记一个较早接纳的旧操作，不会让旧通过覆盖较新的失败。

## 动作与响应丢失

每次明确成单和关闭都有新的 `da-*` 动作号。提交前，页面在原生 Web Locks 排他锁内把完整请求确认写入 localStorage，并完整回读确认集合。创建确认包含所选成员 checkId 和人工文字，关闭确认包含处理说明、单据 head、成员与预览摘要；完整成员身份和证据保存在服务端原事件中。

浏览器协调限于同一前端 origin、相同 API origin 和项目的页面。锁内仅在待核对集合为空时保存新确认，保存成功后才派发原 POST。Web Locks 不可用或本机确认无法完整保存、回读时，提交入口暂停；列表与详情读取独立保留，原确认仍可完整读取时可只读核对。

响应丢失、网络超时、5xx、正文无效或证明不完整时，保留完整原确认，只允许 GET 查询原动作。查不到记录的 `unresolved` 不代表提交失败，不能据此清空确认、换号重试或自动 POST。重载后，原确认仍可完整读取时同样只读核对。只有 GET 返回完整 `recorded` 原件，并与原确认、事件 SHA 和请求摘要逐项核对成功后，才在锁内解除对应本机确认。

只有原 POST 收到严格匹配的固定 4xx 错误和显式 `outcomeUnknown:false`，才可确认本次请求被拒绝，并在锁内解除这一条本机确认。当前组件中的草稿继续保留，错误保持到上下文重置；确认勾选和关闭预览会失效。后续提交需要操作者重新读取、预览并明确点击。

草稿仅在当前组件内存中按项目保存，不保证刷新或卸载后恢复。持久化的是请求原确认，重载后显示为待核对记录，不自动回填成可再次发送的草稿。未知结果没有人工清空按钮；D5 尚未提供永久拒绝迟到人工动作的服务端决定。[D4 的永久拒绝](acceptance-browser-start-resolution.md)仅适用于 Browser 启动操作，不能用于此处的 `da-*` 人工动作。

服务端接口已有同动作、同请求的原件时，精确重放优先于当前来源可用性并返回原回执，不重复写入。界面不会因此自动重发请求。不同请求使用同动作号返回冲突。正常重启保留原事件；备份回滚、复制数据根、删除原件和突然断电后的 exactly-once 不在本片保证范围。

## HTTP

沿用引擎 Token 鉴权、真实数据根 owner 和项目范围。`sources` 与 `actions` 是固定路由名，优先于单据编号。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/acceptance/projects/:projectId/defect-tickets` | 项目缺陷单列表 |
| `POST /api/acceptance/projects/:projectId/defect-tickets` | 从一次登记的可靠失败创建固定成员缺陷单 |
| `GET .../defect-tickets/sources?candidateId=bc-…` | 核验该候选的登记来源和可成单成员 |
| `GET .../defect-tickets/actions/:actionId` | 只读核对原动作；absence 返回 unresolved |
| `GET .../defect-tickets/:ticketId` | 原事件历史和当前核验投影 |
| `GET .../defect-tickets/:ticketId/close-preview?afterOperationId=bo-…` | 核对指定 after 是否为当前最新登记；旧 after 不具备关闭资格 |
| `POST .../defect-tickets/:ticketId/close` | 按完整预览摘要、单据 head 与成员摘要明确关闭 |
| `GET .../defect-tickets/:ticketId/export.md` | Markdown 下载 |
| `GET .../defect-tickets/:ticketId/export.json` | JSON 下载 |

成单 body 包含 `ticketId`、`actionId`、`sourceOperationId`、`memberCheckIds`、`title`、`severity`、`description`、`reproduction`。关闭 body 包含 `actionId`、`afterOperationId`、`expectedRevision`、`expectedHeadSha256`、`memberSetDigest`、`factsDigest`、`previewDigest`、`resolution`、`confirmed:true`。服务端独立重建来源、预览和事件，HTTP 不能传入 store、facts 或 owner。

写请求正文必须为 application/json，最多 32 KiB，使用严格 UTF-8；未知字段、重复查询、未知查询、错误 ID 和错误方法均拒绝。创建新事件返回 201，同动作精确重放返回 200。错误只返回固定公开文本，不回传内部路径、底层消息或原始错误详情；写入后无法确认结果时返回 `outcomeUnknown:true`。

## 存储、读取预算与导出

事件位于真实验收根的 `defect-tickets/v1/events/da-*.json`。每个动作保存一个 canonical JSON 加 LF 原件；原字节 SHA 连接连续 revision，关闭固定此前事件 SHA。独占发布、全命名空间校验与提交前同步 guard 阻止覆盖、分叉、符号链接和部分现场修补。遗留临时文件或混合原件继续保留并阻断。

默认最多 256 张缺陷单、4096 条事件、单事件 64 KiB、事件总量 16 MiB、写队列 32。来源单次捕获默认最多 1024 个 Browser 操作、16384 个条目、32 MiB JSON、256 MiB 证据及 1 GiB payload 读取工作预算；预算只能降低。来源累计预检包含项目其他候选的 completed 原件，先检查元数据和累计预算，再读取证据。一次项目列表共享一个已核验批次，各候选在批次内选择，不重复读取整个账本。模型完整单次输入最多 32 MiB，列表累计模型输入最多 128 MiB，超限明确返回 CAPACITY，不截断成单成员或伪造通过。

来源 fence 固定文件身份、名称集合、正向原字节及可选文件不存在状态，返回前和发布前重新核验；这是同步前后检查，不能称为多文件原子快照或回滚检测。一次 capture 的 `batchReadUpperBound` 只计算该次 payload 读取；owner 锁、目录和 stat 工作另有界，每次后续 guard 的 payload 另按 `guardPayloadReadUpperBound` 计算。

导出只包含人工说明、固定成员、来源原件摘要、逐项结果和处理历史；不复制截图、原始报告、网络记录或 AI 原文。URL 查询、fragment、userinfo 及已识别的 authorization、cookie、token、API key、password、secret 字段会省略。Markdown 人工文字按纯文本引用并转义 HTML、链接和分隔符。存储原件保持不变；任意人工秘密无法保证自动识别，共享前仍应检查人工文字。

## 验证入口

```powershell
pnpm -C console build
pnpm acceptance:defect:tickets:smoke
```

该 smoke 入口检查真实本地 Chromium 中的新捕获来源、视觉与行为两成员成单、部分修复阻断、全量修复后的显式关闭、退化重开、响应丢失后的只读核对、正常重启和桌面 / 手机布局。[D5 提交前本机验收记录](../audits/2026-10-18/acceptance-defect-tickets.md)保存源码专项、历次失败与修复、本机 17 组门禁和完整 Chromium 10/10 结果；完整 Core 为 2661 项、2649 pass、12 skip。推送后的精确新 SHA Linux CI 由主任务另行采集并在下一片归档，D4 档案只证明 D4。

公开材料见[证据阅读说明](../audits/2026-10-18/evidence/defect-tickets/README.md)、[完整归档索引](../audits/2026-10-18/evidence/defect-tickets/archive-index.json)及[独立核验导航](../audits/2026-10-18/evidence/defect-ticket-publication/README.md)。重新采集后的包已完整独立核验 exit 0、`passed`，索引 SHA256 为 `40897db2e88dbf78419d2908e4fcdff421f6f925a674bc94c3e6933aed8822b4`；首次因 CRLF 属性字节失败的原包、报告和精确修正溯源继续保留。核验确认源报告 14 项检查，人工缺陷单固定其中 2 个成员；四图的字节、尺寸与 DOM/布局核验不等于人工目视验收，受控 502 响应丢失模拟不代表 TCP 中断或断电测试。请求日志限于已记录的验收 API，证据与平台边界按导航中的原始报告阅读。
