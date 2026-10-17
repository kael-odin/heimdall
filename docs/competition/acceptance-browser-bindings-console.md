# Browser 来源归属工作台与 HTTP

验收工作台在项目目录中提供 Browser 历史来源归属：选择已完成的 mirror / regression 运行，明确选择 `baseline` 或 `target`，再归入当前项目的一个不可变版本。更早的运行可以填写完整 `ac-UUID`。来源侧默认不选；更换项目、运行、来源侧或版本后必须重新确认。

这一步保存来源的组织关系。它不创建 Browser 候选，不批准、选用或启动验收。Browser 托管执行继续关闭，接口明确返回 `executionReady:false`。内部实体、完整 URL 身份校验、来源重建与提交顺序仍使用[来源侧归属 store](acceptance-browser-bindings.md)，没有另建一套归属规则。

## 操作路径

1. 打开“项目验收”，展开项目目录，选择项目，并创建或选择项目版本。
2. 在“Browser 历史来源归属”选择运行、来源侧和版本，核对入口声明后确认归属。服务端比较完整 planned entry URL，包含 path、query 值和查询顺序；显示地址不能代替这项比较。
3. 在已归属历史中点击单条“核对来源”。这时才重读该来源原件，核对实际引用证据并重建完整投影。列表本身只展示已存记录。
4. 展开某条采集观察，按需查看保存截图、重复截图或原始采集详情。图片来自引擎受保护证据接口；前端验证 MIME、大小与 SHA-256 后才展示。

比较门禁失败不直接决定某一侧的资格：一个外观不一致的运行仍可能有两侧健康证据，原比较结果保持失败。检查槽位与采集观察是不同数量，例如 14 个检查槽位可以来自 4 条采集观察，界面分别展示它们。

同一 run 的两侧可以归入不同项目；同一 `(runId, side)` 全库只能归属一次。target 与旧运行归属共存时必须使用相同项目和版本。界面防止当前项目可见的重复提交，最终唯一性和跨项目约束由服务端执行。

## HTTP 合同

| 方法与路径 | 行为 |
| --- | --- |
| `POST /api/acceptance/projects/:projectId/browser-source-bindings` | 显式归属来源侧，返回 201、安全显示预览和目录事件 |
| `GET /api/acceptance/projects/:projectId/browser-source-bindings` | 只列已存摘要，不读 run、PNG 或来源投影 |
| `GET /api/acceptance/projects/:projectId/browser-source-bindings/:bindingId` | 只重核验这一条来源，保留历史实体 |

POST JSON 严格只接受五个字段：

```json
{
  "expectedGenerationId": "ag-00000000-0000-0000-0000-000000000000",
  "expectedRevision": 7,
  "runId": "ac-00000000-0000-0000-0000-000000000000",
  "sourceSide": "baseline",
  "releaseId": "ar-00000000-0000-0000-0000-000000000000"
}
```

上面的 UUID 仅用于说明格式。真实调用必须使用当前目录 generation / revision 与已有实体 ID，不接受客户端提供的 projection、preview、URL、actor、confirmed 或摘要。接口保留 16 KiB 请求上限、引擎鉴权与 owner / recovery 门禁，响应使用 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。

新响应使用 `viewVersion:1`。POST 与单条 GET 包含 `generationId`、`revision`、安全 `binding`、显示用 `preview`、`diagnostics` 和 `executionReady:false`；POST 另含白名单事件字段。collection 包含 `bindings` 与 `verification:{scope:'stored-record-only',currentSourceVerified:false}`。项目 detail 增加同一摘要数组 `browserSourceBindings` 和 `browserSourceVerification`，供工作台复用。

来源变更时，单条 GET 返回 200、历史 binding、`preview:null` 和固定变化诊断，不改目录或修复原件。owner / root 失效保留 503。POST 的非法输入、过期 CAS、归属冲突及来源不合格仍沿用目录安全错误码；错误不回传本机路径、私有异常或原始调用方内容。

## 显示与证据边界

新 DTO 的专用 URL 字段使用 `*Display` 名称，隐藏凭据、fragment 和整段 query，query 存在时显示 `?[redacted]`。步骤值、断言字面量和规则不进入组织核对预览。显示 DTO 是有意不完整的视图，不能作为批准合同、交回内部 schema 或重算原实体摘要。

页面标题、结构文字和控件描述均作为不可信文本显示。观察到的控件链接不变成可点击 href。前端自己根据已验证的 run ID 与文件名拼接受保护证据路径，不使用服务端提供的任意链接。证据流超过记录大小、MIME 不符、字节数或 SHA 不符时停止展示；关闭证据、关闭核对、切换上下文和卸载时回收 Blob URL。

原始采集详情是既有证据 API 返回的保存字节，可能包含页面文字、原始链接和断言观察；它按原始 SHA 核对后只作文本展示。这与显示 DTO 的字段裁剪是不同边界。旧 release、run、plan、report 和原始证据接口仍沿用各自合同；本片不声明全系统 URL 脱敏，也不改写历史证据。

运行列表与单条运行详情 GET 在 worker 原子发布进度时，允许展示本请求已经稳定捕获的 legacy 版本，下一次请求再读取新版本。这只影响轮询展示；来源复核、证据下载、triage 和恢复继续严格核验，不能从展示版本取得来源或写权限。[读取竞态验收](../audits/2026-10-17/acceptance-display-head-race.md)记录实现边界与失败复现。

planned entry 的组织匹配不能证明远端部署内容冻结。观测地址沿用采集时的有限记录，不能证明完整重定向链或最终完整 query。受控本地流程和冻结反例只验证本文合同，不代表外部项目或认证业务已经验收。

## 提交恢复与迟到响应

工作台复用目录的 CAS、ready、writing 和 reconcile 状态。归属成功只需一次 POST；不会因为超时、HTML 网关错误或回包丢失自动重发。错误提示保留草稿并要求先“刷新并核对目录”，刷新只读取历史，再由操作方决定下一次明确操作。

单条核对和证据请求绑定当前项目、binding、目录版本和选择轮次。关闭、切换或目录变化会取消读取并清除预览；即使发生 A→B→A，旧响应也不能恢复为当前预览。完成归属与打开保存来源是独立动作，项目列表刷新不会隐式解码所有 PNG。

## 验证入口

```powershell
node --test core/test/acceptance-browser-binding-view.test.mjs
node --test core/test/acceptance-browser-binding-api.test.mjs
node --test core/test/console-acceptance-browser-bindings.test.mjs
pnpm acceptance:browser:bindings:ui:smoke
```

实现验收、实际计数与证据路径见[工作台验收记录](../audits/2026-10-17/acceptance-browser-bindings-console.md)。Browser 完整批准预览、候选 / 批准 / 选用和固定来源执行继续作为后续能力独立建设。
