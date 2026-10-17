# D5 提交前本机验收记录

本片把同一次登记验收中的可靠失败转成固定成员的人工缺陷单，支持明确关闭、退化重开、未知写入结果核对及脱敏导出。第三轮完整本机门禁 17 组全部通过，Core 为 2661 项、2649 pass、12 skip，真实本地 Chromium 的 D5 闭环为 10/10；重新采集后的公开包也完成完整独立只读核验。首轮 D5 浏览器失败、前两轮完整批次失败、首次公开包核验失败及各自修复经过继续保留。本文记录提交前的冻结输入和本机结果，结论限于已声明检查及本地受控流程。

- 证据读取截止：2026-10-18 05:28:38（Asia/Hong_Kong，UTC+08:00）。只记录此时已落盘的结果。
- 实施工作树：`codex/defect-ticket-closure-d5`；起点提交：`5006e16bf73e47f36877da24df4ac4a5c8207965`。该起点不是待验收变更的最终提交。
- 产品操作及字段合同见[固定来源的人工缺陷单指南](../../competition/acceptance-defect-tickets.md)。本记录区分源码专项、离线构造、真实本地引擎 HTTP 与真实本地 Chromium 流程。
- 本机门禁、源码专项和修正后的完整浏览器结果分别列出。各批次存在重叠，不合并为一个测试总数；推送后精确提交的 Linux CI 按文末安排另行采集。

## 产品合同与实施范围

操作者从同项目、同一次已经完成且显式登记的 Browser 操作中，选择 1–24 项可靠失败创建单据。原始来源、candidateId、contentDigest、成员身份、成员集合摘要及证据索引成单后固定；标题、严重度、问题说明、复现步骤与关闭说明进入人工历史。事件使用独立追加命名空间：`<acceptance-root>/defect-tickets/v1/events/da-UUID.json`。

单据将人工处理与当前核验分别投影：

| 维度 | 状态 | 约束 |
| --- | --- | --- |
| `processingStatus` | `open`、`closed`、`reopened` | 关闭必须是明确人工动作；关闭后的可靠失败派生重开；后来通过仍需再次明确关闭 |
| `verificationStatus` | `verified_passed`、`partially_passed`、`still_failed`、`unverified`、`incomparable`、`integrity_blocked` | 当前事实独立于人工历史；原件受损时，历史关闭可以保留，但 `repairVerified` 不得声称通过 |

“最新”限于同项目、candidateId 与 contentDigest，按 `acceptedAt`、`recordedAt`、`operationId` 排序。界面先重新读取单据，再自动使用 `currentOperationId` 请求关闭预览；不能选择旧 after 覆盖最新登记。预览是当时快照，后续单据 head、成员或验收事实变化会使原确认失效。

只有全部固定成员在同一次最新登记中可靠通过，才允许勾选确认并明确关闭；处理说明可提前编辑。部分通过、空登记、成员缺失、检查身份或条件变化、来源损坏都不能关闭。单据仅覆盖所选成员，不代表整个项目或未声明业务流程已经修复。

读取列表、详情、来源、关闭预览、动作核对与导出，以及人工成单、关闭本身，不会启动 Browser、登记验收结果、请求目标站点或改写原检查账本。实现集中在 `core/src/acceptance/defect-ticket-*.mjs`、`console/src/AcceptanceDefectTickets.vue`、`console/src/acceptance-defect-tickets.js`，由引擎 API 与项目目录接入。

## 未知结果与恢复限制

创建和关闭在派发 POST 前，先在原生 Web Locks 排他锁内把完整请求确认写入 localStorage，并完整回读确认集合。创建确认固定所选 checkId 与人工文字；关闭确认固定 resolution、单据 head、成员摘要、事实摘要和预览摘要。完整成员身份和证据保存在服务端事件。协调范围是同前端 origin、同 API origin 和项目。

网络中断、超时、5xx、无效正文或证明不完整时，原确认持续保留，入口阻止另一笔提交；只允许 GET 查询原动作。`unresolved` 或查无记录不能证明请求被拒绝，不能清空、换号重试或自动 POST。只有完整 `recorded` 事件与原确认、范围、请求 fingerprint、canonical 事件 SHA 证明全部匹配，才在锁内解除对应确认。

只有原 POST 返回严格匹配的固定 4xx 错误且显式 `outcomeUnknown:false`，才释放这一笔已知拒绝。当前组件内的草稿和错误继续保留，确认勾选与关闭预览失效，操作者需重新读取、预览并明确提交。草稿只在当前组件内存按项目保存；刷新后保留的是待核对原确认，不自动恢复成可再次发送的可编辑草稿。

D5 没有永久拒绝迟到 `da-*` 人工动作的服务端决定，也没有未知记录人工清空按钮。D4 的永久拒绝仅属于 Browser 启动，不可套用到人工动作。服务端支持同动作、同请求精确重放原回执，但界面不自动重发。正常保留数据根重启可读取原事件；备份回滚、复制数据根、删除原件、突然断电后的 exactly-once 均不在此片保证范围。

owner、证明或原件完整性失败时阻断写入；未知临时文件与部分现场保留，不自动清理修补。Web Locks 不可用或本机确认无法完整保存、回读时暂停提交，独立读取仍保留。

## 存储、预算与导出边界

| 项目 | 默认预算或行为 |
| --- | --- |
| 人工事件 | 256 张单、4096 个动作、单动作 64 KiB、原事件命名空间 16 MiB、写队列 32 |
| 来源捕获 | 1024 个操作、16384 个条目、32 MiB JSON、256 MiB 证据、1 GiB payload 读取工作预算；只能降低 |
| 模型投影 | 单次输入 32 MiB；项目列表累计输入 128 MiB；超限明确返回 CAPACITY |
| 来源范围 | 预检包括项目其他候选 completed 原件；同次列表共享一个已核验批次，在内存中按候选选择 |
| 来源 fence | 固定身份、名称集合、正向原字节及可选文件不存在状态，返回前与发布前重新检查 |
| 导出 | 人工历史、固定来源摘要及逐项判定；省略原始报告、截图、网络记录和 AI 原文 |

来源 fence 是同步前后检查，不是多文件原子快照或回滚检测。`batchReadUpperBound` 只计一次 capture 的 payload；每次后续 guard 的读取另按 `guardPayloadReadUpperBound` 计算，owner 锁、目录与 stat 工作也有独立边界。

JSON/Markdown 会省略 URL query、fragment、userinfo，以及已识别的 authorization、cookie、token、API key、password、secret 字段。裸 `token=` 的脱敏已补入实现与专项。随后静态审查还发现 `{"token":"SECRET"}` 等带引号键名会绕过旧正则；现已支持配对引号键名及含转义引号的完整字符串值，避免留下秘密后缀。Markdown 人工文字按纯文本引用并转义 HTML、链接和分隔符。原事件不改写；任意人工秘密无法保证自动识别，共享前需检查人工文字。

引号修复新增用例逐一覆盖 `token`、`password`、`secret`、`api_key`、`api-key`、`access_token`、`refresh-token`、`Authorization`、`Cookie`，在 description/reproduction 与 Markdown/JSON 两种导出中检查双引号 JSON、单引号值、转义引号后缀、同行多个字段及原输入不变。主任务报告该测试文件 5/5 通过，但未单独保存冻结 runner 输出；此处保留这一执行反馈及静态复核边界。第二轮与第三轮完整 Core 均已包含该新增用例，各为 2661 项、2649 pass、12 skip；第三轮覆盖了候选夹具再次修正后的冻结输入。

## 已有专项结果

以下为各自证据快照中的统计，不代表最终批次，也不能相加。通过行的 fail、cancelled、skipped、todo 均为 0；有失败、超时或漂移的行明确保留。

| 证据编号 | 范围 | 落盘统计 | 证据判断 |
| --- | --- | --- | --- |
| U01 | schema/model | 21/21 通过，exit 0 | 该次专项通过；8 个旧验证器字节未变 |
| U02 | store | 17/17 通过，exit 0 | 该次专项通过；8 个旧验证器字节未变 |
| U03 | chain/listing 边界 | 2/2 通过，exit 0 | 原事件 16 MiB 限制未提高；3034 动作原字节 16,776,545，包装后 17,037,470 字节仍可验证 |
| U04 | source，早期 24 项 | 24/24 通过，exit 0，`unchanged:true` | 该版本专项通过 |
| U05 | source，新增批次选择用例后 | 24 通过、1 失败，exit 1，`unchanged:true` | 保留失败；失败用例报 `CATALOG_UNAVAILABLE`，不能写成 25/25 |
| U06 | service/report | 8/8 通过，exit 0，`unchanged:true` | 该次专项通过 |
| U07 | source/service/report 定向复核 | 7/7 通过，exit 0，`unchanged:true` | 包含批次选择、预览选择与导出等定向用例；不替代完整 suite |
| U08 | backend 六组组合 | 75/75 通过，exit 0，`unchanged:false` | 运行期间两个测试文件变化；不是冻结通过证据 |
| U09 | API 后续专项 | 14/14 通过，exit 0，`sourceStable:true` | 覆盖此前 13/13 批次；不重复计数 |
| U10 | API + 真实引擎，首轮 | 15 通过、4 失败，exit 1 | 4 个引擎用例报 `BASELINE_CHANGED`，该次失败保留 |
| U11 | API + 真实引擎，第二轮 | `timedOut:true`，exit null | 无完整终态测试统计；不得计为通过 |
| U12 | API + 真实引擎，后续轮 | 19/19 通过，exit 0，`sourceStable:true` | 该轮冻结源码在当次独立核验时无漂移；后续脱敏与夹具变更由第三轮完整 Core 和本机门禁覆盖 |
| U13 | 前端 helper | 29/29 通过，exit 0 | 执行源码和 8 个旧验证器字节未变；以显式 TAP 统计为准 |
| U14 | 实际 Vue 组件状态 | 7/7 通过，exit 0；同次生产构建 exit 0 | 组件状态、生产构建通过，拥有文件与 8 个旧验证器字节未变 |
| U15 | 最终批次前独立 lint | exit 0，`unchanged:true` | 发生在 D5 停服夹具修正前，不替代最终批次 lint |

U08 中变化的是 `core/test/acceptance-defect-ticket-engine.test.mjs` 和 `core/test/console-acceptance-defect-tickets.test.mjs`，不是用 75/75 推定所有最终字节均已覆盖。U05 的后续定向复核通过，提交前完整冻结结果见第三轮 Core 与 17 组门禁。

U12 的独立核验读取 677 个证据文件，确认 19 项统计、原 stdout/stderr 与该轮源文件快照。`currentSourceMatches:true` 是当时的核验结果；随后 `defect-ticket-report.mjs` 先补充裸 token 字段，再修复引号键名与转义引号值的导出脱敏，本记录不把旧轮结果当作最终全部字节的验收。四个真实本地引擎 HTTP 场景分别记录如下；启动连接探测与业务请求分开保存，不并入测试数：

| 场景 | 已完成 HTTP | 来源文件未变 | 目标请求 | 场景核验 |
| --- | --- | --- | --- | --- |
| owner-lost | 13 | true | 0 | 通过 |
| read-only | 31 | true | 0 | 通过 |
| recovery-blocked | 14 | true | 0 | 通过 |
| ticket-lifecycle | 25 | true | 0 | 通过 |

这些 HTTP 场景还检查没有新增 jobs/acceptance runtime、响应头和业务传输失败列表。它们验证本地固定夹具与真实引擎边界，不能扩展成任意外部站点验收已通过。

## 首轮真实 D5 浏览器 smoke：整体失败

首轮外层运行 `browser-fa0f5e52-c414-45d8-a671-97a1f1a11c03` 于 2026-10-18 02:41:52.629 开始、02:52:20.527 结束（UTC+08:00），exit 1、`unchanged:true`。内层 `passed:false`，落盘 8 个已完成 true 检查，不能称为整轮 8/8 通过。

已记录的八个检查涉及：真实捕获与已登记视觉/行为失败；固定成员成单及丢失创建响应后的刷新 GET 核对；部分修复阻止关闭；全部成员通过后的显式关闭及丢失关闭响应核对；可靠失败重开且后续通过不自动关闭；旧预览的明确 409 保留草稿并要求新预览；两种下载保留历史与已识别秘密脱敏；正常重启后精确读取单据且不启动或登记 Browser 工作。

最终控制台错误断言遇到以下未允许的错误，导致整轮失败：

```text
Failed to load resource: net::ERR_CONNECTION_REFUSED
http://127.0.0.1:57457/api/acceptance/runs
```

测试故意停止引擎时，仍把带轮询的控制台页面挂在浏览器中。原证据记录 `pageErrors:[]`、6 条 console message、3 个 controlled reply；不能用没有 page error 覆盖该控制台错误。四张 open/reopened 桌面及手机截图已落盘，但最终布局、来源完整性和控制台总断言尚未全部走完。

已修正的是新 D5 smoke 的停服夹具：先 `page.goto('about:blank')` 离开轮询视图，保留同一浏览器 context/localStorage，再停止并在相同根、origin、端口重启引擎，重新打开控制台读取单据。该做法与 D4 停服夹具一致。首轮失败原件保留；修正后的完整通过结果单独列于下文。

控制台过滤仍只接受与预先记录 controlled reply 的精确路径及 HTTP 状态文本匹配的 error。没有把 `ERR_CONNECTION_REFUSED` 加入允许列表，也没有放宽旧 Browser 门禁。新增 smoke 还明确等待未知响应错误可见且 `aria-busy=false` 后核对，检查实际渲染的处理/核验文字、部分通过数量，以及 409 后草稿保留、确认取消和关闭按钮禁用。

## 旧完整门禁批次：candidates 失败停止

旧批次 `batch-fb039ae7-5270-48bb-a1bf-adfa75a05e31` 于 2026-10-18 02:53:26.807 开始、03:27:14.471 结束（UTC+08:00），终态 `passed:false`。build、Core、original、managed、d3、d4 已完成，随后 candidates exit 1，余下门禁未执行。不能把此前完成的门禁拼接为整轮通过。

| 门禁 | 旧批次已保存结果 | 证据判断 |
| --- | --- | --- |
| build | exit 0 | 该轮构建通过；不替代后续源码的构建 |
| core | tests 2660、pass 2648、fail 0、cancelled 0、skipped 12、todo 0；exit 0、`unchanged:true` | 以 stdout 显式统计为准；runner totals 为 null，后续引号脱敏修复不在该轮冻结字节内 |
| original、managed、d3、d4 | 各 exit 0、无 signal/error、`unchanged:true` | 旧轮各自通过；后续夹具修改仍需新批次覆盖 |
| candidates | exit 1、`unchanged:true` | 除预设 POST 502 外出现后台 GET `/api/acceptance/runs` 409，原错误断言失败 |
| bindings、recovery、cdp、browser、forge、benchmark、specbenchmark、comparisonbenchmark、lint、docs | 该批次未执行 | 不得计为通过 |

诊断轮 `candidates-6c4fb653-4366-46ba-adca-2d8c4c3b5085` 于 03:34:54.903–03:35:48.543 执行，exit 1、`unchanged:true`。该轮加入时间插桩，用于定位旧 smoke 中故意修改来源报告与后台列表轮询的交叠，不能记作原门禁通过。`browser/diagnostic-events.jsonl` 记录 `after-intentional-report-edit` 为 03:35:41.124，GET 409 于 03:35:41.133 收到，正文为 `MANAGED_RUN_INTEGRITY_FAILED`；`after-report-restore` 为 03:35:42.419，随后 03:35:43.636 的列表响应恢复为 200。以上时间均为 2026-10-18、UTC+08:00。

旧 candidates smoke 的夹具已修正：在故意修改报告前，仅将后台无 query 的运行列表 GET 排队，并等待已转发请求排空；恢复并确认原报告字节后，让排队请求继续真实请求并等待响应。候选诊断仍在损坏窗口读取原件。原断言、timeout 及错误过滤未放宽，也没有把 GET 409 加入允许列表。

修正后的独立预检 `candidates-8f79b0ec-086b-454b-9fff-2bc85b17eb62` 于 03:39:34.226–03:40:28.521 执行，13 项检查均为 true，exit 0、无 signal/error、`unchanged:true`，stderr 为空。该结果是候选 smoke 预检通过，不替代新的 17 组完整门禁。

## 第二轮完整门禁批次：候选夹具异常退出

第二轮 `batch-7d8cb478-4a11-4ecc-b82a-822306276bdf` 于 2026-10-18 03:42:38.902 开始、04:15:35.513 结束（UTC+08:00），终态 `passed:false`。build、Core、original、managed、d3、d4 已完成，candidates 因未处理的异步路由异常 exit 1，余下门禁未执行。第一次候选预检通过没有消除这一竞态，失败现场继续保留。

| 门禁 | 第二轮已保存结果 | 证据判断 |
| --- | --- | --- |
| build | exit 0 | 该轮构建通过 |
| core | tests 2661、pass 2649、fail 0、cancelled 0、skipped 12、todo 0；exit 0、`unchanged:true` | stdout 显式统计包含新增引号脱敏用例；不是整轮门禁通过 |
| original、managed、d3、d4 | 各 exit 0、无 signal/error、`unchanged:true` | 该轮各自通过 |
| candidates | exit 1、`unchanged:true` | stderr 记录 `route.continue: Route is already handled!`，Node 因未处理的 Promise 异常退出 |
| bindings、recovery、cdp、browser、forge、benchmark、specbenchmark、comparisonbenchmark、lint、docs | 该批次未执行 | 不得计为通过 |

Core、original、managed、d3、d4 及失败 candidates 的 `maintainedSourceSha256` 均为 `cf559df6b4e2e27e701f18bf5ba633b4e7b67858442a472d6c1a287f69c93dee`。候选运行 `candidates-ade3b66e-fa99-44f3-ae1f-2e476e74cb1e` 的外层 runner 于 04:14:53.280–04:15:35.503 执行；内层保留原始 runtime 和已经产生的截图等现场，但没有 `failure.json`、`browser-errors.json`、`checks.json` 或完成 summary。不能补造内层最终断言，也不能把异常退出前的画面当作通过。

此次修正将排队请求的恢复从 `release(); page.unroute(...)` 改为 `release(); await page.unrouteAll({ behavior: 'wait' })`，等待正在执行的路由 handler 完成后再移除，并继续等待排队请求的真实响应。没有使用 `ignoreErrors`，原 HTTP 错误断言、console 过滤及 timeout 继续保留。

第二次独立预检 `candidates-fe8d1943-a03a-4da6-8e9b-4da22ad33503` 于 2026-10-18 04:20:29.127–04:21:21.803（UTC+08:00）执行，13 项检查均为 true，exit 0、无 signal/error、`unchanged:true`，stderr 为空，`maintainedSourceSha256` 为 `74e38eb0b61df5158fe7b66c9b10b491c5cc65920225e9013c020f4cfe9c4a50`。该预检确认本次夹具修改能够完成原断言；仍不替代完整 17 组批次。

## 第三轮完整本机门禁：17 组通过

第三轮为 `batch-d616f4c9-f7a7-422b-8236-50ba987818b2`，于 2026-10-18 04:23:10.241 开始、05:09:52.815 结束（UTC+08:00），终态 `passed:true`。下表完成时间来自批次调度摘要；逐组 runner 均为 exit 0、无 signal/error、`unchanged:true`。

| 门禁 | 本机结果 | 完成时间（UTC+08:00） |
| --- | --- | --- |
| build | 通过 | 04:23:13.175 |
| browser | 通过；D5 完整 Chromium 闭环 10/10 | 04:33:36.988 |
| core | tests 2661、pass 2649、fail 0、cancelled 0、skipped 12、todo 0 | 04:57:42.462 |
| original | 通过 | 04:58:10.747 |
| managed | 通过 | 04:59:42.310 |
| d3 | 通过 | 05:04:13.561 |
| d4 | 通过 | 05:05:18.094 |
| candidates | 通过 | 05:06:11.943 |
| bindings | 通过 | 05:07:09.162 |
| recovery | 通过 | 05:07:18.792 |
| cdp | 通过 | 05:07:49.684 |
| forge | 通过 | 05:08:25.809 |
| benchmark | 通过 | 05:08:51.061 |
| specbenchmark | 通过 | 05:08:53.088 |
| comparisonbenchmark | 通过 | 05:09:29.245 |
| lint | 通过 | 05:09:51.661 |
| docs | 通过；当次 256 个文件、972 个本地目标 | 05:09:52.814 |

本轮仍执行全部 17 组，D5 浏览器闭环先于 Core。Core 原生 stdout 记录耗时 `1444466.7163 ms`；runner 的 totals 字段为 null，以上测试统计以 stdout 显式结果为准。每组 runner 保存命令、stdout/stderr、执行前后清单、源文件副本和 SHA。

16 组非 build 门禁均捕获 629 个输入（含 console/dist），`maintainedSourceSha256` 一致为 `74e38eb0b61df5158fe7b66c9b10b491c5cc65920225e9013c020f4cfe9c4a50`。build 捕获 621 个非 dist 输入，其摘要为 `61adbce7f3be2d5ac572e24d1820c7b77445cb77f0c5d02dc438b28aad93bef3`。这些计数是受验输入清单，不是全仓库文件总数。

`staged-source-review-20261017T205852.102572Z.json` 返回 `passed:true`，逐一核对 621 个非 dist 输入，全部 `matchesFrozenSource:true`、`workspaceMatchesFrozenSource:true`；其引用的 Core 摘要 SHA256 为 `86b4ba4fd8d4fd8f8f4539a152c81231823010bbf44cc01115ed151e7a70ed90`。console/dist 的 8 个生成文件独立保留在 629 项冻结运行输入中，不作为暂存索引源码匹配项。

本文和指南在完整批次结束后整理；docs 行记录的是该批次执行时的链接检查结果。后续报告文字与证据链接的静态复核单独进行，不改变原门禁输出。

## 修正后完整 D5 浏览器 smoke：通过

外层运行 `browser-443e598a-9d5a-44d8-a579-42fb0010c5ee` 于 2026-10-18 04:23:14.451–04:33:36.977（UTC+08:00）执行，exit 0、无 signal/error、`unchanged:true`，冻结输入摘要与上述 `74e38…` 一致。内层真实本地 Chromium 于 04:23:14.954–04:33:31.867 执行，`passed:true`、10 项检查全部为 true。

10 项分别覆盖新捕获来源及登记的视觉/行为失败、固定成员成单与丢失创建响应后的刷新 GET 核对、部分修复阻止关闭、全员通过后的明确关闭及丢失关闭响应核对、可靠失败重开且后来通过不自动关闭、旧预览 409 保留草稿并要求新确认、Markdown/JSON 历史与已识别秘密脱敏、保留原数据根重启后精确读取、桌面/手机实际渲染及来源完整性，以及控制台错误仅来自预设受控 HTTP 回复。

`pageErrors:[]`，console 共 3 条，分别是丢失创建响应的 502、丢失关闭响应的 502 和旧事实确认的 409，与 3 个 `controlledReplies` 的路径、状态逐一匹配。该结果不把这些注入错误写成零错误，也未放行首轮的 `ERR_CONNECTION_REFUSED`。

四张图覆盖 open/reopened 的桌面与手机状态：桌面为 1440×1000、手机为 390×844，分别交叉使用明暗主题。`layouts.json` 中页面宽度均等于视口宽度，组件 `scrollWidth` 等于 `clientWidth`。通过结论来自完整 smoke 的布局、来源、目标请求及控制台总断言，不由截图或八个旧局部检查推定。

## 提交后精确 SHA 核验安排

本记录冻结提交前已完成的本机验收事实。推送后，主任务按新提交的精确 SHA 采集该提交自身 Linux CI 的 workflow、run、门禁与测试结论，证据写入 ignored `core/workspace/_runs/d5-ci-20261018/`，由下一片归档并向用户报告实际结果。CI 与远端发布证据随其实际完成时点记录，避免将报告提交本身造成的 SHA 变化反复写回同一提交。D4 档案只证明 D4，不作为 D5 新提交自身 CI 的证据。

## 公开证据与完整独立核验

[公开证据阅读说明](evidence/defect-tickets/README.md)介绍归档范围和读取方法；[完整归档索引](evidence/defect-tickets/archive-index.json)绑定批次、门禁、普通文件、特殊条目及来源摘要。[独立核验导航](evidence/defect-ticket-publication/README.md)分别指向首次失败原件、本次成功报告、真实执行元数据与重封包溯源，根目录的旧 `summary.json` 和 `review.md` 仍代表首次失败。

首次公开包独立核验于 2026-10-18 05:15:44.274024–05:16:09.306802（UTC+08:00）执行，真实进程 exit 1，[失败摘要](evidence/defect-ticket-publication/summary.json)为 `failed`，唯一已到达的失败点是 `Public binary preservation attributes differ`。当时 collector 用 `write_text` 生成 `.gitattributes`，Windows 转换得到 9 字节 `* -text\r\n`，hex 为 `2a202d746578740d0a`；verifier 精确要求 8 字节 LF。主核验止于此断言，后续 Core 原生统计、八个旧 verifier raw Git blob 与 D5 强检查阶段没有执行；额外只读观察不能算作该轮完整核验通过。详见[首次失败说明](evidence/defect-ticket-publication/assessment.md)。

完整旧包 88 个文件原样移存至本机 ignored `core/workspace/_runs/d5-gates-20261018/failed-publication-crlf-20261017T2119Z/`，移存清单记录 `filesUnchanged:true`，旧索引 SHA256 为 `d9abae28dbafad19ea80950989e2d70b5c21727fd99ff0b174e706b0e8342ef4`。[重封包溯源](evidence/defect-ticket-publication/repack-provenance/collector-change.json)公开保存旧索引、9 字节属性、collector 新旧原字节和全部 88 个文件的移存 SHA 证明，未重复整套旧 tar。修复仅将 collector 生成属性的一行从 `write_text` 改为 `write_bytes`，得到 `2a202d746578740a`；`onlyExpectedReplacement:true`，verifier 字节未改，产品输入和已完成的 17 组结果未改。

新包的[完整独立核验报告](evidence/defect-ticket-publication/review-12bb561c-be6b-4566-ae0e-39bc2137e35c/review.md)、[成功机器摘要](evidence/defect-ticket-publication/review-12bb561c-be6b-4566-ae0e-39bc2137e35c/summary.json)及[真实执行元数据](evidence/defect-ticket-publication/review-12bb561c-be6b-4566-ae0e-39bc2137e35c/execution.json)记录：进程于 2026-10-18 05:25:02.330462–05:25:27.553311（UTC+08:00）执行，exit 0、状态 `passed`，stderr 为空；执行前后索引和 verifier 摘要一致。它完成了首次失败后未执行的阶段，确认 Core 2661 tests / 2649 pass / 0 fail / 12 skip、629 项输入等于 621 非 dist 加 8 dist，以及八个既有 verifier 与基准 Git blob 原字节一致。

| 公开包项目 | 核实结果 |
| --- | --- |
| 压缩归档 | 56 份，归档内 9959 个普通文件、6 个特殊条目 |
| 直接阅读副本 | 30 个 |
| 门禁历史 | 36 组，含最终 17 组 |
| `archiveBytes` | 57,162,268 字节，仅为压缩归档字节之和，不是整个目录大小 |
| D5 强检查 | 10 项、4 张 PNG、0 page error、3 条受控 console |
| 已记录的验收 API 请求 | 缺陷单 POST 4 次、原动作 GET 核对 2 次、Browser execution POST 6 次、登记 POST 6 次 |
| 来源和成单范围 | 原来源 14 项检查；缺陷单只固定其中 2 个成员 |

以上请求数是所保存 `/api/acceptance` 范围内的 HTTP 日志计数，不是全部浏览器网络，也不是成功事件数。四图已核验签名、尺寸、SHA 和 DOM/布局，未作人工目视审美验收。丢失响应由 `route.fetch()` 后受控 502 模拟，不是 TCP 中断或断电试验。特殊条目按不跟随的 Symlink/Junction 元数据保存，不重建可执行链接；完整维护输入清单不覆盖每一份 Markdown。该核验不证明多文件原子快照，也不检测自洽的外部备份回滚。

| 固定文件 | 本轮直接读取核对的 SHA256 |
| --- | --- |
| 严格公开包 `archive-index.json` | `40897db2e88dbf78419d2908e4fcdff421f6f925a674bc94c3e6933aed8822b4` |
| 成功报告 `summary.json` | `ded17b86e58f6942b8872cc0bac23cc4519764538ec148501f47e938ff1787ae` |
| 成功报告 `review.md` | `6fe5a4b5382db1e788bdfcc579adbc9102030b89fec2e40f75d9c9910ec4b3b3` |
| 修正后 `collect.py` | `cc02dfb4162fa5af4517336e2796d27b4d2836e830b8d5121279b1182d548f17` |
| 保持原字节的 `verify-public.py` | `9b998bc3f622cc505f12c52f1ec0db692ce1fea594af1296999cc20c20c4f33d` |

公开包独立核验只读取原件和证据，没有重新启动测试、Browser 或引擎。其成功不替代推送后精确新 SHA 的 Linux CI，仍按前述安排独立采集。

## 本地证据索引

下面路径均相对仓库根，位于忽略的 runtime 工作目录；不作为发布仓库内可下载附件链接。各运行的 `summary.json`、stdout/stderr、源码快照与额外证据应一并保留。

| 编号 | runtime 路径 |
| --- | --- |
| U01 | `core/workspace/_runs/d5-schema-model-20261018/run-062619fe-7c63-4d9f-94b8-7c1f665b24e4/` |
| U02 | `core/workspace/_runs/d5-store-20261018/run-2c289111-ffe1-4778-b355-0756ec11efe6/` |
| U03 | `core/workspace/_runs/d5-chain-boundary-20261018/run-e39c4e94-469b-43ef-a40b-b3d8198f002f/` |
| U04 | `core/workspace/_runs/d5-source-validation-20261018/run-7e3fe681-f89b-4d7f-91c8-e1bf1b082c99/` |
| U05 | `core/workspace/_runs/d5-source-validation-20261018/run-8046505d-254c-4912-a7f9-95fc1cb7db43/` |
| U06 | `core/workspace/_runs/d5-service-validation-20261018/run-c214d84d-9f3b-4c04-82fd-a1db494518c3/` |
| U07 | `core/workspace/_runs/d5-backend-freeze-20261018/run-d0ed17e4-70a7-4352-b5db-645de88e9e6f/` |
| U08 | `core/workspace/_runs/d5-backend-freeze-20261018/run-870c0b47-c223-4422-98fc-6af0e5107e27/` |
| U09 | `core/workspace/_runs/d5-api-20261018/run-20261017T180242.871531Z/` |
| U10 | `core/workspace/_runs/d5-engine-20261018/run-20261017T181630.063396Z/` |
| U11 | `core/workspace/_runs/d5-engine-20261018/run-20261017T181830.304615Z/` |
| U12 | `core/workspace/_runs/d5-engine-20261018/run-20261017T183258.330241Z/`；独立核验 `core/workspace/_runs/d5-engine-20261018/verification-20261017T183929.209634Z/` |
| U13 | `core/workspace/_runs/d5-console-helper-20261018/run-8dff5220-74de-4c5b-a4f3-b95b21a0fcb0/` |
| U14 | `core/workspace/_runs/d5-console-state-build-20261018/run-142d5a72-4eca-4128-a60c-e12f6e1c8f0b/` |
| U15 | `core/workspace/_runs/d5-gates-20261018/lint-25dcfd0d-88b3-44f2-bfc0-8447fef5788b/` |
| 首轮 Browser | `core/workspace/_runs/d5-gates-20261018/browser-fa0f5e52-c414-45d8-a671-97a1f1a11c03/`；内层 `browser/` 保存 failure、checks、layouts、browser-errors 及截图 |
| 旧完整批次 | `core/workspace/_runs/d5-gates-20261018/batch-fb039ae7-5270-48bb-a1bf-adfa75a05e31/summary.json`；Core 为同根 `core-c01869d1-47da-481a-952b-a44fbed3294c/`，失败 candidates 为 `candidates-e737b267-1b49-49f4-bb0b-f3c3560e3cbc/` |
| candidates 诊断轮 | `core/workspace/_runs/d5-gates-20261018/candidates-6c4fb653-4366-46ba-adca-2d8c4c3b5085/`；精确损坏/恢复窗口见 `browser/diagnostic-events.jsonl`，该轮含诊断插桩 |
| candidates 修正预检 | `core/workspace/_runs/d5-gates-20261018/candidates-8f79b0ec-086b-454b-9fff-2bc85b17eb62/` |
| 第二轮完整批次（失败） | `core/workspace/_runs/d5-gates-20261018/batch-7d8cb478-4a11-4ecc-b82a-822306276bdf/summary.json`；Core 为同根 `core-5401b73b-129e-4c1f-b6f8-73252ba278c4/`，失败 candidates 为 `candidates-ade3b66e-fa99-44f3-ae1f-2e476e74cb1e/` |
| candidates 路由修正预检 | `core/workspace/_runs/d5-gates-20261018/candidates-fe8d1943-a03a-4da6-8e9b-4da22ad33503/` |
| 第三轮完整批次（通过） | `core/workspace/_runs/d5-gates-20261018/batch-d616f4c9-f7a7-422b-8236-50ba987818b2/summary.json`；本轮 D5 smoke 为同根 `browser-443e598a-9d5a-44d8-a579-42fb0010c5ee/`，Core 为 `core-5a20bdee-ed8b-42bf-b5de-4813d5251d51/` |
| 暂存源码独立核对 | `core/workspace/_runs/d5-gates-20261018/staged-source-review-20261017T205852.102572Z.json` |
| 首次公开包独立核验（失败） | `core/workspace/_runs/d5-gates-20261018/independent-public-review-59df8ca2-ae60-4a6a-b0d3-5098a6603293/`；旧包原样保留在同根 `failed-publication-crlf-20261017T2119Z/` |
| 新公开包完整独立核验（通过） | `core/workspace/_runs/d5-gates-20261018/independent-public-review-12bb561c-be6b-4566-ae0e-39bc2137e35c/`；公开原字节副本由上文独立核验导航索引 |

旧验证器保护范围是 `browser-operation-schema.mjs`、`browser-operation-store.mjs`、`browser-fixed-contract.mjs`、`browser-fixed-runner.mjs`、`runner.mjs`、`identity.mjs`、`report.mjs` 与 `core/src/verify/compare.mjs`。已有专项记录其原字节未改；本轮只读 diff 再次确认这些文件相对起点提交没有变化。
