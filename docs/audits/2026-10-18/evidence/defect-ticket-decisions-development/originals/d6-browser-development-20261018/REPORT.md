# D6 Browser 开发验证与失败现场索引

日期：2026-10-18。工作树 `codex/defect-ticket-decisions-d6`，基线 `41c359a62ecbb67ac15f38c51c95fa983a7492d3`。

这份报告记录开发阶段的实际执行。第七轮通过当时的 runner 和独立 verifier，但使用的是 01:00:10 UTC 构建的 console/dist，不含约 01:20 UTC 冻结的 Catalog 四文件改动。root 后续统一 build、增强 verifier 并重新执行完整门禁；本记录不能替代最终构建、最终源码和精确提交 SHA 的门禁。

## 第七轮实际结果

- OUT：`../defect-ticket-decisions-console-smoke-20261018T093910120/`。
- runner：2026-10-18T01:39:10.574Z 至 01:41:37.764Z，exit 0，`passed:true`；13/13 全局检查、4 案各 17/17 检查。
- 独立 verifier：真实执行 exit 0；原输出 `../d6-browser-build-20261018T090008180/attempt-7-strict-verifier.log`。
- 当时 verifier SHA-256 可查该 OUT 的 `implementation-inputs-before.json`；其与 after 完全一致。后续 root 分配的当前输入匹配强化属于新的 verifier 版本，需要由最终新 OUT 重新证明。
- 完整 relay 日志含 teardown：4 条受控 HTTP 502、0 条 `proxy-error` / `fixture-error` / `original-upstream-error`。
- `pageErrors=[]`；只出现 4 条精确绑定当前原 POST 的预期 502 console error，没有增加宽泛错误过滤。
- Playwright 1.63.0；Chromium `Chrome/153.0.8010.12`；Node v25.2.1，Windows x64。

| 案例 | 原动作 / 赢方 | 实际顺序及结果 |
| --- | --- | --- |
| A | create / rejected | engine 已接 prefix 且未 end；真实 deny 201 rejected，UI 解除精确 pending 后才释放原尾；迟到原请求 200 rejected；该 ticket 不存在 |
| B | 新 create / recorded | 真实 preflight unresolved；relay 暂存真实 deny；原尾先达且原请求 201 recorded、磁盘 event 可读，然后唯一 deny 转发得到 200 recorded；ticket revision 0/open |
| C | close / rejected | healthy Browser 同次可靠复验两个固定成员后，真实 deny 201 rejected；UI 解除 pending 后释放原尾，原请求 200 rejected；ticket 原修订、head、状态、成员、history 不变 |
| D | 重新预览的新 close / recorded | 原请求 201 recorded 并落 accepted event 后才转发已收到的唯一 deny；deny 200 recorded；同 ticket revision 1/closed，两个成员均 verified_passed |

每案真实 UI 原 raw body 与 relay 接入字节、唯一上游 prefix/full-body SHA、localStorage 完整原确认、deny raw body、完整决定原件、磁盘 SHA、action GET 都逐项绑定。A/B 新动作及 ticket 不复用；C/D 为同 ticket 的不同全新动作。真实 source capture 一次，bad/healthy Browser 各一次；source capture 后禁止重新访问来源入口。案例前后 catalog/Browser/source 原件和目标请求数保持一致，唯一允许的决定目录变化是该 actionId 的一个不可变原件。

## Chromium completion 对照

同一启动方式使用真实 Chromium/CDP，不改产品 helper，也不代替四案验收。

| 目录 | 实际观察 |
| --- | --- |
| `../d6-fetch-body-probe-20261018/` | 8 案：HTML 空 CL0 未读/抛 MIME 时毫秒级 ERR_ABORTED；读取均 finished；非空 HTML+精确 CL+close 在该样例未读/抛 MIME 时 finished；显式 cancel 为 failed |
| `../d6-fetch-helper-probe-20261018/` | 6 案：同 95 bytes HTML+no-store 下，native、完整 fetch 选项、abortable、真实 helper、真实 button helper 均收到 502，但两秒观察期无 finished/failed；因此不能用第一个简化 fetch 推广到完整产品场景 |
| `../d6-fetch-cache-probe-20261018/` | 6 案：同 HTML95、真实 helper/完整原生 fetch 选项；未给响应 cache 头或 public,max-age=0 均 finished，响应 no-store 均未 finished。仅是本 Chromium/样例的对照事实 |
| `../d6-fetch-json-probe-20261018/` | 真实 helper 与 button helper 两案：完整 JSON502+no-store，固定未知 code=D6_CONTROLLED_HTTP_502、outcomeUnknown=true；PW/CDP 均 finished，无 failed |

最终新 relay 使用完整 JSON502 固定未知错误，保留 no-store、精确 Content-Length、Connection:close。产品按原 bounded reader 消费完整响应后保留未知结果；未改产品超时、MIME 逻辑或错误口径。原 POST 必须同时满足 PW requestfinished/failed=null、CDP loadingFinished 且无 loadingFailed，正文在完成后才被被动读取并与 fixture raw bytes 比较。原生 relay finish/close、完整字节 SHA 和两层完成时间均保存，不把普通 HTTP 受控回复说成真实断网。

## 七轮原现场

原输出统一保存 `../d6-browser-build-20261018T090008180/attempt-N-*.txt|log`；所有失败 OUT 均保留，没有重写 summary 或补造结果。

| 轮次 | OUT 后缀 | 实际结论 |
| --- | --- | --- |
| 1 | `20261018T090039779` | exit 1，A 的 HTML 受控回复 completion 门禁失败 |
| 2 | `20261018T090517875` | exit 1，A 的空 CL0 completion 门禁失败 |
| 3 | `20261018T090925486` | exit 1，A 的空 CL0+close completion 门禁失败；保存 CDP/PW/relay 诊断 |
| 4 | `20261018T091823020` | exit 1，A 的 HTML95+精确 CL+close completion 门禁失败；精确时间戳证明 502/relay finish 后 65 秒仍无完成事件 |
| 5 | `20261018T092814450` | 四案各 17 checks 完成，但真实普通 `/execution`、`/runs` 轮询出现四条 ECONNRESET/额外502，总门禁 exit 1；没有放宽过滤 |
| 6 | `20261018T093345261` | agent:false 消除运行中普通代理错误，主体 13+4x17 通过；但 finally 先 abort 普通轮询造成两条 socket hang up，原 runner summary 为 true；独立 verifier 正确拒绝，exit 1 (2!==0)。不能当严格通过 |
| 7 | `20261018T093910120` | 修复关停顺序，先停止 Browser/Chromium 流量，engine 保持运行等普通 forward drain，之后 abort held、停 engine；finally 再查完整错误日志。runner 与当时独立 verifier 都 exit 0 |

普通 forward 使用 agent:false，每个请求独立 socket，没有失败后重发。第5轮未记录 reusedSocket，因此不得把 pooled idle socket 假设宣称为已确认的唯一根因；新日志含 method/path/reusedSocket。第6轮 teardown 错误则由具体代码顺序和时间戳直接确认，新顺序已由第7轮全日志零错误验证。

## 四图实际视觉检查

以下均为第七轮实际 PNG，已逐张打开；PNG 尺寸与布局 JSON 同时由 verifier 核验。

- `A-create-unknown-desktop-light.png`：1440×1000，原确认摘要、只读核对、永久拒绝说明和未勾选 checkbox 清楚，按钮处于禁用态，无水平溢出。
- `B-recorded-create-mobile-light.png`：390×844，工单名称、open/still_failed、0/2 和两固定成员可读，正常换行，无水平溢出。
- `C-close-unknown-mobile-dark.png`：390×844，原关闭确认与摘要可读，无水平溢出。长 pending 需要纵向滚动；本图底部仅显示 checkbox 首段，deny button 位于下方折叠线外。四案中的真实 check/click 已执行，不能据此声称整张卡一屏可见。
- `D-recorded-close-desktop-dark.png`：1440×1000，明确关闭、verified_passed、2/2、revision 1 与处理说明可见，无水平溢出。

## 实现范围与交接

本代理新增四个维护文件：

```
core/scripts/smoke-acceptance-defect-ticket-decisions-console.mjs
core/scripts/fixtures/defect-ticket-decision-relay.mjs
core/scripts/fixtures/defect-ticket-decision-ingress.mjs
core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs
```

未改旧 D5/D4 smoke、旧 verifier、原八工具、原20 CI smoke、package/workflow 或原 capture/stream fixture。root 在自己的授权范围负责 CI 接线和最终 verifier 强化。本代理已明确释放 Browser 串行窗口，后续只写本 ignored 报告，不再启动 Browser 或修改冻结实现。

此前 schema/store 专项 50/50（含12个真实 SIGKILL边界）另见 `../d6-schema-store-final-20261018T084028628/REPORT.md`。本证据仅保证相同真实数据根和保留的不可变动作账本之内的受控样例，不宣称断电、备份回滚或跨根 exactly-once。
