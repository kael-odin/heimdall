# D6 动作回复的原生 HTTP 边界验证

本片只增强四案浏览器夹具的普通动作查询和否决回复。上游完整结束后，夹具按真实原始字节设置准确 `Content-Length`，再一次结束下游响应。生产决定存储、页面实现、四案断言、严格验证器、错误过滤和 CI 时限均未修改。本机 Windows / Linux 专项通过；新提交自身的完整 Linux CI 仍待执行，不能据此宣称原 CI 问题已经修复。

## 原失败与对照

原提交 `06e4303871d485a14b66d24318db80595a3db774` 的 CI run `39096514869`、attempt 1 以 failure 结束。完整 Core、原二十项控制台 smoke、Docker 和前端构建成功，独立 D6 四案在第一个 create 场景读取动作 GET 正文时失败。精确身份、最终日志、原验证器的不接受结果和诊断边界见[该提交 CI 记录](acceptance-defect-ticket-decision-ci.md)。

该 GET 收到 HTTP 200 后，CDP 记录 `net::ERR_ABORTED`，没有 `loadingFinished`，Playwright 正文读取失败。同期 DOM 已显示预期的 unresolved 提示并保留原确认。Playwright 附加的导航提示不是发生导航的独立证据；请求取消的发起方和完整根因尚未确认。

相同未修改脚本在 Windows Node 22 与独立 WSL Linux Node 22 均通过，Linux 原严格验证器也通过。因此本机没有复现该 CI 失败，不能把后续通过当成确定的因果定位。

## 改动与失败边界

- 只匹配合法项目 / 动作 ID 的 GET `/defect-tickets/actions/:actionId` 和 POST `/defect-tickets/actions/:actionId/deny`；其余转发继续使用原流式分支。
- 每个 UI 请求仍只创建一个原生上游请求，保持 `agent:false`，不重试、不替换为另一份 fetch 响应、不重放人工动作。
- 在上游 `end` 且 `complete === true` 后，保留真实 status、非 hop headers 与完整原始 bytes，以字节数计算长度；正文不解析后重建。日志记录完整上游结束、长度和 SHA-256。
- 单响应有效载荷预算为 32 MiB。上游 abort、声明正文截断、提前 close、超限或下游取消均保留失败记录，终止唯一上游，不把已收集的成功前缀作为完整成功返回。
- 上游结束日志只证明原生 HTTP 完整，不代替 Chromium 完成和正文读取。原 smoke 与 strict 仍必须接受真实浏览器证据，任何 `readFailure` 继续阻断。

最终夹具 SHA-256 为 `48f656b994087649101946bcd3fb0c2cc9aabddb0e951149acfa5fd797a6da6a`。新增维护测试 `core/test/defect-ticket-decision-relay.test.mjs` 通过真实原生 HTTP 客户端 / 服务端检查响应边界与失败场景，不启动 engine 或浏览器。

## 已实际执行

| 输入 / 环境 | 执行与结果 | 证据边界 |
| --- | --- | --- |
| 未修改 D6，Windows Node 22.23.3 | 四案 exit0；原 strict exit0 | 原脚本对照，本机未复现 CI 失败 |
| 未修改 D6，WSL Linux Node 22.23.3 | 四案 39.484s / exit0；原 strict exit0 | 精确 Git 源码；使用不变的 Windows 构建 bundle，仅用于诊断 |
| framing v1，Windows Node 22.23.3 | 四案 143.469s / exit0；原 strict exit0 | 独立保留的中间版本，不冒充最终 v2 |
| 最终 framing v2，Windows Node 22.23.3 | 四案 144.125s / exit0；原 strict exit0 | 四案各 17 项、全局 13 项成立，输入前后不变 |
| 最终 framing v2，WSL Linux Node 22.23.3 | 四案 34.406s / exit0；原 strict exit0 | 四案各 17 项、全局 13 项成立；不是 GitHub Linux CI |
| 最终维护 native HTTP 测试，Windows / WSL Linux Node 22.23.3 | 两端各 8 tests / 8 pass / 0 fail / 0 skipped，exit0 | 200 / 409 原始字节、真实 deny 单次转发、非动作流式正向控制、abort、截断、超限、下游取消；Linux 测试源码与维护文件逐字节相同 |
| 全量源码语法检查 | 521 files，exit0 | 不等于完整 Core 执行 |
| 受保护原八文件 | 与基线 `5006e16bf73e47f36877da24df4ac4a5c8207965` 原始 Git blob 完全相同 | 工作树、index、HEAD 与基线逐项核对 |

native HTTP 测试使用真实前缀写入屏障与显式尾部 gate；“结束前未向下游发送”的负向观察窗为 100ms，仅证明这个有界受控样例。预算限制针对有效载荷，拼接正文时 chunks 和完整 Buffer 会短暂并存，不构成全进程内存硬上限。

复验命令：

```powershell
node --test core/test/defect-ticket-decision-relay.test.mjs
node core/scripts/smoke-acceptance-defect-ticket-decisions-console.mjs <fresh-output-directory>
node core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs <same-output-directory>
```

[本机可移植诊断副本](evidence/defect-ticket-response-framing/README.md)保留实际输出、网络原件、截图与来源 SHA 清单。原 runtime / 浏览器 profile 继续留在各自本机原目录；选定的诊断副本不能替代完整原目录进行独立 strict 重放。此前封印的 D6 最终归档与发布检查原字节不变。

这次变更不新增产品能力保证，也不改变原 CI failure。只有新提交自身的完整 Linux CI、精确 artifact 身份与同次正文 / bundle 核验全部通过后，才能接续发布验收结论。
