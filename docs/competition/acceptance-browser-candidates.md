# Browser 完整复核与持久候选

Browser 来源侧归属之后，可以在项目验收工作台打开完整合同，明确确认并保存为可重读的候选。它把“采集过某一侧”推进到“记录了哪份完整验收参考”，为每次固定来源验收建立可核对的输入。

候选接口所有响应仍为 `executionReady:false`。保存候选不会运行验收、修改原比较结论、生成批准或选用，也不会把原比较失败转换为通过。候选保存阶段的实现与证据见[D2 实施记录](../audits/2026-10-17/acceptance-browser-candidates.md)。

D3 已接入[单次批准的固定来源执行](acceptance-browser-execution.md)：另行选择目标版本并完整复核后，新的本次确认固定来源原件，只采集所选目标；完成后显式登记检查问题，并选择此前操作进行复验。全局 Browser approval / selection、业务工单最终关闭与未知不存在操作的安全解除仍待建设。候选记录继续独立保留，执行不会改写原比较门禁。

## 工作台操作

1. 在“项目验收”中打开项目目录，选择项目。先按[来源归属指南](acceptance-browser-bindings-console.md)把明确的 baseline 或 target 侧归属到本项目版本。
2. 在已归属来源行点击“完整候选合同”。普通来源预览继续隐藏查询参数和步骤字面量，不承担完整复核职责。
3. 查看项目、版本、来源侧和原比较状态；展开完整计划、组织上下文、来源投影、范围、规则、所选侧参考、证据清单、环境与限制。观察内容和截图按需展开。
4. 阅读后勾选独立确认，点击“确认记录 Browser 候选”。确认绑定当前来源内容摘要和目录版本，切换项目、关闭、目录刷新或来源变化后需要重新读取和确认。
5. 从“Browser 验收候选”列表重新打开记录。引擎重启后仍读取同一 `bc-*`；每次完整读取会重新核验当前来源。

新空引擎仍创建 Schema3，工作台会显示维护提示。Schema3 不会因点击此入口而自动升级。维护者需要停止同根引擎，按 [Schema4 显式维护指南](acceptance-catalog-schema4.md)完成预览与确认，再重启引擎。已有 Schema3 / Schema4 的普通启动都只打开当前格式。

## 完整内容与证据

完整合同保留原计划中的 URL 查询参数及其顺序、步骤值、断言字面量、规则和所选侧采集参考。来源计划摘要沿用既有 `JSON.stringify(manifest.plan)` 字节顺序语义；组织上下文与候选内容使用独立域摘要。D1 的格式和摘要公式保持不变。

完整明文只进入专用复核响应和前端内存，并作为文本节点展示。它不进入链接、路由参数、浏览器 storage、日志或 AI 输入。关闭、切换项目或记录、目录版本变化、取消读取和卸载都会清除合同与确认，撤销创建的图片 Blob URL。

每张图片均通过专用接口重新捕获并验证完整来源，再从同一次捕获的 Map 中返回所选侧 screenshot 或 repeat 的字节。前端还核对 MIME、大小和 SHA-256，核对失败不会创建图片 Blob。对侧 PNG、diff PNG、details JSON、编码或跨层文件名均不属于这些图片接口。

## 保存与异常恢复

保存请求严格为四个字段：

```json
{
  "expectedGenerationId": "ag-…",
  "expectedRevision": 7,
  "sourceBindingId": "ax-…",
  "contentDigest": "64位小写SHA256"
}
```

服务器在同一写队列内先检查目录 CAS、Schema4、项目归属、重复来源和计数容量，再重新读取完整来源。发布 previous 后再次完整核验，并检查 head 原字节 CAS。最终可返回的完整响应（包含候选、事件和目录版本）也必须在提交前通过 12 MiB 预算；不会截断内容来勉强保存。

同一 `ax-*` 最多一个 `bc-*`。并发旧版本请求返回 `STALE_REVISION`；当前版本重复保存返回 `CANDIDATE_ALREADY_EXISTS`，只附安全的 `existingCandidateId`。较晚检查失败时 previous 可能已旋转，但不得发布新 head、候选、事件或 revision。

如果成功响应丢失或 201 内容不完整，工作台保留“结果未知”状态，禁止自动重发。点击“读取候选集合并核对结果”后，先读取候选集合，按 sourceBindingId 与 contentDigest 对账，再刷新目录。确认已记录后，从列表重新读取；集合未找到时，也需要重新打开完整合同并明确确认才能再提交。

已确认的合法 201 不会因后续列表刷新失败而变成未保存。来源损坏时，集合仍能列出原候选；单条读取保留候选 metadata，返回 `review:null` 与诊断。恢复原来源字节后可重新核验同一候选。所有权、根目录和 catalog 故障仍返回 503。

## HTTP 接口

接口均在引擎鉴权和真实验收目录所有权检查之后开放，响应设置 `Cache-Control:no-store`。下表前缀为 `/api/acceptance/projects/:ap`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/browser-source-bindings/:ax/candidate-preview` | 完整、只读、重新核验的预览 |
| POST | `/browser-baseline-candidates` | 明确保存一条候选 |
| GET | `/browser-baseline-candidates` | metadata 集合，不读取来源或 PNG |
| GET | `/browser-baseline-candidates/:bc` | 读取历史并按需完整复核 |
| GET | `/browser-source-bindings/:ax/candidate-preview/evidence/:file?expectedContentDigest=…` | 预览所选侧 screenshot / repeat |
| GET | `/browser-baseline-candidates/:bc/evidence/:file?expectedContentDigest=…` | 已存候选所选侧 screenshot / repeat |

Schema3 的以上专用接口均返回 409 `CATALOG_MIGRATION_REQUIRED`，`details.reason=SCHEMA4_REQUIRED`。未知、缺失、重复 query、非法 ID、方法、编码或多余路径段会被拒绝。项目详情包含安全候选 metadata 与支持状态，旧来源展示接口的 DTO 不变。

## 本机复验

```powershell
pnpm -C console build
pnpm acceptance:browser:candidates:ui:smoke
node --test --test-concurrency=1 core/test/acceptance-browser-candidate-review.test.mjs core/test/acceptance-browser-candidate-store.test.mjs core/test/acceptance-browser-candidate-api.test.mjs core/test/acceptance-browser-candidate-ui.test.mjs
```

真实 UI smoke 使用 fresh Mirror / Regression worker、受控视觉差异、健康行为侧和 Chromium CDP。项目、版本、来源归属是明确标注的测试 setup；候选读取、确认、保存、对账和重启读取使用原生工作台控件。证据记录实际 target 请求数量，全部来源原件与失败现场保留。它覆盖本地受控场景，不声明任意网站或业务流程均已验收。
