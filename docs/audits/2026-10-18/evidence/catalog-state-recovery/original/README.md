# Catalog 无期限 busy 的离线证据与修复

本目录验证实际 `AcceptanceCatalog.vue` script setup 中的 Vue refs、computed、watchers 与真实 Catalog transport helper。网络与服务端实体由可控 DTO 模型代替，未启动 Browser、engine 或 HTTP 服务。该证据确认一个独立的产品韧性缺口，**没有证明 CI run 39082419484 的具体停点或同一根因**。

## 修复前

`catalog-before-repro.mjs` 使用保留的 `AcceptanceCatalog.before.vue` 与 `acceptance-catalog.before.js`，两者为精确 baseline `41c359a62ecbb67ac15f38c51c95fa983a7492d3` 的对应文件。输入 SHA 与状态见 `before-results.json`；原输出和 exit0 见 `before.stdout.log`、`before.stderr.log`、`before.result.json`。

- 正常对照：A 的 POST 延迟交付时切 B、填写 B 草稿，响应完整结算后 A 版本已登记、B 选择与草稿保持、只发一次 POST。
- 故障对照：模型中 A 的版本已提交并交付 201 实体，随后 list GET 不结算，实际状态稳定为 `listLoading=true`、`detailLoading=false`、`writing='release'`、`notice=''`、`error=null`、`ready=false`。80ms 后状态相同；旧 helper 源码不存在期限，因此需要人工释放测试 gate 才能完成。
- 人工释放 GET 后正常完成，进一步排除该受控场景中的确定性项目/草稿覆盖问题。

## 修复语义

- 默认每次请求共用 60000ms，一个 timer 与内部 AbortController 同时覆盖 fetch 响应头和完整 `response.json()`。此预算与现有人工缺陷单 console helper 的默认预算一致，给本地文件核验留出时间；它是**每个请求**的预算，list 与 detail 的顺序读取各有独立预算，并非整条用户动作只用 60 秒。
- 即使 fetch/JSON promise 不遵循 signal，也通过 race 按期结束；主动 GET abort 继续表现为 `AbortError`，期限耗尽为可见 `REQUEST_TIMEOUT`。内部 race 完成后再次核对 abort，避免同 tick 的完成/取消竞态。
- POST 已发送后期限或主动中断均保持 `writeMayHaveCommitted=true`，不能由不完整错误正文的 400/409/503 状态推导为确定拒绝。未知结果保留草稿、阻止继续写入，人工恢复只发 GET。GET/POST 均不自动重试。
- 清理取消不 await；取消本身永不结算也不能延长 busy。迟到 fetch 响应尝试取消正文，不读正文、不交回已结束调用。
- 已经过既有实体验证的写响应在刷新前立即显示已确认文案。目录读取失败后保留已提交事实与人工核对提示，finally 释放界面 busy；仅未知 POST 使用“可能已提交”的边界。
- 实际 Vue 用例覆盖 `mutate(project/release)` 与读取生命周期。`writeBaseline`、`writeBrowserBinding`、`writeBrowserCandidate` 的 ACK 提前位置只做静态核对，**不宣称本目录对这三条写路径完成了实际 Vue 操作验收**。本次没有扩展旧 Browser candidate 的全部卸载行为。

## 修复后

`catalog-after-repro.mjs` 使用当前实际组件与 helper，并以 35ms 注入预算加速同语义离线验证。`after-results.json` 保留精确输入 SHA、fetch/body stall 两案的刷新中状态、超时后状态与只读恢复状态。原输出与 exit0 见 `after.stdout.log`、`after.stderr.log`、`after.result.json`。

两个案均为：ACK 文案在刷新仍 busy 时已可见 → 到期 `writing=''`、`listLoading=false`、`detailLoading=false`、`requiresReconcile=true` → 明确保留“版本已登记/写入已确认” → 人工 GET list+detail 核对恢复 ready。全程一 POST；body 案的取消也永久等待，仍不延迟到期退出。

## 最终专项与界限

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| Catalog helper 专项 | 24/24，0 fail，0 skipped，exit0 | `helper-final.stdout.log` / `helper-final.stderr.log` / `helper-final.result.json` |
| 实际 Vue 状态专项 | 16/16，0 fail，0 skipped，exit0 | `state-final.stdout.log` / `state-final.stderr.log` / `state-final.result.json` |
| 修复前与正常对照 | exit0 | `before-results.json` |
| 修复后 fetch/body stall 与只读恢复 | exit0 | `after-results.json` |
| 四文件 diff whitespace | exit0 | `diff-check-final.result.json` |
| 原 Catalog smoke 相对精确 baseline 未变 | exit0 | `unchanged-smoke.result.json` |
| Impeccable targeted detector | exit2，仅一个既有 warning | `ui-detector-final.stdout.log` / `ui-detector-final.result.json` |

detector 的唯一 warning 为 `.catalog-boundary { border-left: 2px solid var(--accent-dim) }`。冻结 before 与当前源码均含同一声明，本次未修改 CSS，也不为清空既有 warning 扩大本轮范围。

专项覆盖不合作 fetch、完整 JSON body、永久等待取消、统一预算、listener/timer 清理、迟到响应、POST 未知只读恢复、写 ACK 后 list/detail fetch/body stall、项目 A-B-A、项目创建 ABA 与相关卸载场景。未运行原 Catalog Browser smoke、engine 或 Core 全套；旧 smoke 的断言、25 秒等待、error 过滤均未修改。当前 60 秒产品期限不会自动证明旧 25 秒 smoke 失败已修好，仍需独立 Browser / CI 复核。

最终四文件 SHA 见 `frontend-final-sha256.txt`；组件/helper 修复后副本另存 `AcceptanceCatalog.after.vue`、`acceptance-catalog.after.js`。
