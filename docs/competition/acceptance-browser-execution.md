# Browser 固定来源的单次验收

保存的 Browser 候选现在可以用于一次明确目标版本的验收。系统重新核对完整来源，在独立操作中固定所选侧的截图、DOM、规则、交互和环境，然后只访问本次目标；原来源比较的门禁与证据继续保留。

这条链路沿用 [Schema4 候选](acceptance-browser-candidates.md)，不增加全局 Browser 选用状态。候选、归属及 Spec 批准接口仍返回 `executionReady:false`；执行权限来自这一次新的完整确认。

## 从工作台开始

1. 打开「项目验收 → 本地项目与版本」，选择项目。已有 Schema3 数据先按 [Schema4 显式维护指南](acceptance-catalog-schema4.md)升级。
2. 将一次 Mirror / Regression 运行的健康 baseline 或 target 侧归属来源版本，完整复核后保存 `bc-*` 候选。
3. 在「固定来源 Browser 验收」中选择该候选和本次目标版本，点击「复核本次验收合同」。完整来源只在当前页面内存中展示。
4. 核对完整来源后勾选本次确认，点击「批准并开始本次验收」。每次操作固定候选内容、来源材料、目标版本和批准时间。
5. 从操作列表读取完成报告。视觉检查可以按需读取固定来源、目标及差异图；服务端核对证据，页面再次验证 PNG 类型、大小与 SHA-256。
6. 首次运行显式登记检查问题。修复后再次验收，并在完成报告选择此前运行，再点击「登记本次问题与复验」。

同操作号的重复确认仅查询原记录。浏览器在 POST 前保存最小回执；响应未知时只查询原决定，不自动重发 POST。回执不包含完整来源、URL 查询字面量或输入文本。本机回执损坏或无法安全保存时阻止新提交。D4 已增加[启动结果核对与永久拒绝](acceptance-browser-start-resolution.md)：未知操作可明确拒绝该操作号的迟到启动，只有完整决定证明通过核验才解除本机原确认；不存在记录或等待时长不能自动解除。

启动、停止和登记的 POST 最多等待 60 秒，包含响应正文读取。到期后释放页面操作状态并将结果视为未知；服务端可能已经完成操作，仍需查询原操作或登记记录，不会因为客户端超时再次提交启动。

## 检查问题与复验

登记产生不可变的 `observations.json`。问题列表由这些已核验记录重建，粒度为一项检查；多个检查不会自动合并成一个业务工单。

显式复验固定直接此前操作及其当时已登记原件的 `beforeObservationSha256`。问题身份沿该固定链继承，因此“发现 → 通过 → 阻塞 / 缺失 → 再次可靠通过”仍保留完整历史。此前操作尚未登记时该摘要为 `null`，之后补登记不会改变旧观察；原件变化、环、超深链及容量超限均阻断重建或新登记。

| 状态 | 含义 |
| --- | --- |
| `open` | 显式登记的运行发现目标检查失败 |
| `verified_passed` | 显式前后运行中，同候选内容、检查上下文、规则、oracle、环境与验证器下可靠通过 |
| `reopened` | 曾经可靠复验通过，后续已登记运行再次发现相同检查失败 |
| `unverified` | 本次缺失、阻塞或不可比，不能作为已修复依据；保留上次可靠状态 |

环境不一致时保留本次观察并阻止可靠通过 / BUG 判定。执行中断或覆盖不完整时，已观察的通过与失败也降为环境阻塞。报告和账本的 `closesBugs:false` 表示没有宣称业务工单最终关闭；`verified_passed` 只证明该项声明检查在这次复验中可靠通过。

## HTTP 与持久记录

所有路径位于 `/api/acceptance/projects/:projectId`，沿用引擎鉴权与真实数据根 owner。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /browser-executions` | 操作元数据与共享执行槽能力 |
| `POST /browser-executions` | 新的单次批准与执行；完整同键确认仅查询原操作 |
| `GET /browser-executions/:operationId` | 原操作状态 |
| `GET /browser-executions/:operationId/report` | 完成报告与核验证据清单 |
| `POST /browser-executions/:operationId/cancel` | 请求停止，body 为 `{}`；终态以随后查询为准 |
| `POST /browser-executions/:operationId/register-result` | 首次登记 `{}`，或显式复验 `{ "beforeOperationId": "bo-…" }` |
| `GET /browser-executions/:operationId/evidence/:file?expectedSha256=…` | 完成报告中的 PNG / JSON 原件 |
| `GET /browser-bugs` | 已登记观察及检查问题状态 |

启动 body 严格为六个字段，不能传来源 URL、计划、任意文件、Spec selection 或旧运行 ID：

```json
{
  "operationId": "bo-<UUID>",
  "expectedGenerationId": "ag-<UUID>",
  "expectedRevision": 12,
  "candidateId": "bc-<UUID>",
  "contentDigest": "<完整候选的64位SHA-256>",
  "targetReleaseId": "ar-<UUID>"
}
```

新接纳返回 HTTP 202；已有完整同键确认返回 HTTP 200 和 `replayed:true`。相同操作号的其他确认返回冲突。原操作查询先于当前目录、来源及执行槽检查，所以历史 prepared / completed 不会因再次确认而启动。

持久路径为 `acceptance/browser-operations/v1/bo-<UUID>/`，其中 dispatch 固定 `br-*` run、`a-*` task、单次 approval、完整执行合同与来源关系。来源副本保存在 `evidence/source-*`，完成报告与截图在同操作内核验。旧 `ac-*` 消费者、Spec 派发、候选、AI triage 和旧报告修改入口不接受 `br-*`；当前操作列表是 Browser 的专用读取入口。

引擎启动时整批预检，再将原 running 收束为 interrupted；prepared 不启动。取消、owner 丢失、超时或关机后不再提交完成结果。Browser 与 Spec、旧运行共享一个执行槽。执行、登记和查询均不增加目录事件或修改全局选用。

## 范围与复现

仅执行候选已有的声明路由、实际视口及交互断言。默认只读请求策略、隔离上下文、稳定性与截图预算沿用原 Browser runner；未声明的业务、写请求流程、登录状态、PRD 意图与 Figma 对照仍不构成验收保证。完整来源和证据保存在本机受鉴权的验收数据根中。

当前来源验证器支持已审查的旧版和 D3 两组固定 LF / CRLF 指纹；不会把运行 checkout 的任意指纹自动纳入兼容清单。固定十文件摘要见 [D3 兼容清单](../../core/test/fixtures/browser-verifier-reviewed-d3.json)。来源与证据仍独立重算，指纹不构成签名。

原生控制台与真实目标闭环：

```powershell
pnpm -C console build
pnpm -C core acceptance:browser:execute:smoke
```

脚本使用独立本地夹具与真实 Chromium CDP，保留报告、请求日志、截图、原始来源摘要和失败现场。验证器、运行环境和产品源码发生变化时需重新执行对应门禁。
