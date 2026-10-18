# Defect-ticket response framing 诊断证据包

这是 action GET / deny POST 响应 framing 的边界增强证据。维护实现仅在真实 native upstream 正常完整结束后发送完整原始 bytes 与准确 Content-Length；错误、截断、超限和下游取消均保留失败证据。非 action streaming 保持原行为。

**原 Linux CI 中动作 GET 被取消的触发机制仍未复现、尚未定位。** 原 SHA `06e4303871d485a14b66d24318db80595a3db774` 的 CI run `39096514869` / attempt 1 / job `117583999059` 仍为失败记录。其 action GET 曾出现 HTTP 200 后 `net::ERR_ABORTED`、无 loadingFinished、Playwright 正文读取失败；DOM 同时已显示期望 unresolved notice，不能据此宣称产品 reconcile 失败。通用 navigated-away 文案不能证明发生导航。原 CI 的正式 failure 原件见相邻 `../defect-ticket-decision-ci/`。

本包的 `original-linux-control/` 是后续**通过的原 Linux 对照**，没有复现该 CI 故障。`v1-windows-control/` 也是通过的中间候选对照。两者仅收录 summary、implementation inputs、CDP/正文取证诊断记录；`browser-errors.json` 中的受控 HTTP 502 需结合场景合同判断，不能一概标成新增故障。final v2 的 Windows 与 WSL artifacts 则保留所选 portable 范围全部文件。

| 运行 | 四场景 smoke | 原 strict verifier |
| --- | --- | --- |
| 原 Linux 对照 | 39.484 s / exit 0 | exit 0 |
| framing v1 Windows 对照 | 143.469 s / exit 0 | exit 0 |
| framing v2 WSL Linux | 34.406 s / exit 0 | exit 0 |
| framing v2 Windows | 144.125 s / exit 0 | exit 0 |

候选 v2 native HTTP 八案和提升后的维护测试均为 8 pass / 0 fail；原始 TAP、命令 wrapper、输入 SHA 与 relay 原件分别在 `native-candidate-run/`、`wrappers/v2-maintained-native-http/` 和 `native-maintained-artifacts/`。八案覆盖 GET 200/409、真实 deny POST、非 action streaming、上游 abort、Content-Length 截断、32 MiB + 1 byte 和下游取消。100 ms 的受控观察窗仅证明本次受控传输边界。

这些结果不替代新提交精确 SHA 的完整 Linux CI；**新提交的完整 CI 仍待验**。本证据包制作阶段仅执行清单、原字节复制和 SHA 核验，没有启动 engine、浏览器或新增测试。

版本绑定：原 relay raw SHA256 `6e6f6fb39c5635b5cdc30d8d9d584fa99dead2b3f2858758c928aed3843975a5`；v1 `5a383620ee25f74cd61f9808f592616db9519c366f958d671a85b444cb25cf02`；v2 `48f656b994087649101946bcd3fb0c2cc9aabddb0e951149acfa5fd797a6da6a`。v2 只相对 v1 收窄共享错误分支，使非 framing 路径恢复旧错误处理。候选、patch、delta、静态审查和 manifests 位于 `static-review/`，都是原字节副本。

**归档不含各 artifacts 根级 `runtime/` 与 `chromium-profile/`。这是可移植诊断副本，不能脱离原 runtime 独立运行旧 strict verifier。** wrapper 中保留的原绝对路径与原运行时 SHA 是来源证据，归档没有改写旧 inputs、summary 或脚本来假装可重放。`sources.json` 列出每个来源绝对路径、目标相对路径、原始 bytes/SHA256、复制后来源与目标核验值，以及完整选择/排除范围。

预览在正式目录创建前完成：源文件 403 个 / 4,781,517 bytes，连同保守元数据上限 5,433,293 bytes，小于 10 MiB (10,485,760 bytes)。复制后全部逐文件 raw bytes 与 SHA256 相同。`sources.json` 为 326,061 bytes；源副本与 manifest 合计 5,107,578 bytes，README 自身另计。

| 来源组 | 文件数 | 原始 bytes |
| --- | ---: | ---: |
| native-candidate | 24 | 15,549 |
| native-maintained-artifacts | 16 | 7,802 |
| original-linux-control | 11 | 98,239 |
| static-review | 32 | 107,876 |
| v1-windows-control | 11 | 152,220 |
| v2-linux | 132 | 1,479,540 |
| v2-windows | 132 | 1,548,389 |
| original-linux-smoke | 5 | 155,907 |
| original-linux-strict | 5 | 149,406 |
| v1-windows-smoke | 5 | 156,092 |
| v1-windows-strict | 5 | 149,487 |
| v2-linux-smoke | 5 | 155,865 |
| v2-linux-strict | 5 | 149,377 |
| v2-maintained-native-http | 5 | 150,170 |
| v2-windows-smoke | 5 | 156,090 |
| v2-windows-strict | 5 | 149,508 |

## Linux 维护版 native 八案附加原件

父代理在首轮清单冻结后完成 Linux 维护版测试，因此另建 `sources-linux-native.json`，保留首轮预览与 `sources.json` 不变。WSL Linux 与 Windows 的维护版 native 测试均为 **8 tests / 8 pass / 0 fail / 0 skipped**，wrapper exit 0。Linux 的准备三件、命令三件和八案 relay/scope 原件分别位于 `linux-native-preparation/`、`wrappers/v2-linux-maintained-native-http/`、`native-maintained-linux-artifacts/`。本附加制作仍仅复制与校验，没有新增测试。

附加 22 个源文件 / 12,177 bytes；基础加附加共 425 个源副本 / 4,793,694 bytes，全部逐文件校验 raw bytes 与 SHA256。创建正式包前两份预览的保守合计上限为 5,512,030 bytes，仍低于 10 MiB。运行时排除限制与新精确 SHA 完整 CI 待验口径继续适用。
