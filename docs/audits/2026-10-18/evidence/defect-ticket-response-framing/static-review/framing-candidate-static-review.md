# D6 framing 候选与 native HTTP 专项记录

本目录保留未应用的 v1/v2 候选及原始维护源码。此代理没有应用维护 patch；root 随后按其独立窗口分别应用并运行了 v1/v2。下述 native 专项只导入 ignored v2 副本，没有启动 engine、Chromium、Browser smoke 或额外 CI 采集。

原 Linux 对照成功及完整 CI 原失败的结论仍由 root 的独立证据负责。本候选定位为传输边界增强，不能称已确定 CI 那次取消的根因。

## 精确输入与 patch

| 文件 | SHA256 | 说明 |
| --- | --- | --- |
| relay.original.mjs | 6e6f6fb39c5635b5cdc30d8d9d584fa99dead2b3f2858758c928aed3843975a5 | HEAD 06e4303871d485a14b66d24318db80595a3db774 的原工作树字节；Git blob 3756fb53aeadf211fce89d19ba22f9f8aa0ebfcd |
| relay.framed-candidate.mjs | 5a383620ee25f74cd61f9808f592616db9519c366f958d671a85b444cb25cf02 | v1，冻结保留 |
| relay.framed-candidate-v2.mjs | 48f656b994087649101946bcd3fb0c2cc9aabddb0e951149acfa5fd797a6da6a | 本次 native 专项实际导入的 v2 |
| action-reply-framing-v2.patch | a46a390c894dc75a707087911bcb7d34d370b32112f599901b30f17231e3a1c0 | 从原 HEAD 到 v2 的完整 patch，6281 字节 |
| action-reply-framing-v1-to-v2.patch | 96339b7e36f3f24824e487b9238578a35cb59c949e97412377d380cc9f368cf1 | v1 到 v2 的单独 delta，1169 字节 |
| relay-framing-native-http.test.candidate.mjs | 7d098e051a86817c5a5b42561f1d0a4ff5df00cdbf7ae97ff3ae8e8ca8c8610e | 可提升到 core/test/ 的维护测试候选，import 指向真实维护 fixture |
| relay-framing-native-http-v2.test.mjs | b95c87df067d3911e65b6e07bfc344907d3e8da67f775a88eb4a6307b9604c56 | 已执行副本；只将一个 fixture import 改为 ignored v2，断言与行为不变 |
| browser-resolution-stream.mjs | 0c6f8079ece2cc92c1765e1f9237b9ff85ba55d249b2408c07a2f88ea88a81bd | ignored v2 的依赖原字节副本；只使用 node:http/node:crypto |

v2 唯一相对 v1 的差异：对非 action framing 路径，失败处理恢复旧的 writeHead/end 语句原样执行并 return。v1 的 `!res.destroyed` 防护只留在新 framing 分支，避免附带改变其他转发错误路径。

## 专项静态审查

- 匹配严格限定为合法项目/动作 ID 的 GET `/actions/:id` 与 POST `/actions/:id/deny`；其他方法和路径仍执行原 streaming 分支。匹配使用 pathname，合法查询串仍由原样 request URL 转发。
- 每个前端请求仍只创建一个 native `http.request`，保留 `agent:false`。没有重试、重新 fetch、请求复制或成功 fallback。
- framing 分支在真实 native `end` 前不发送下游成功 headers/body；按原始 byte 数限制 32 MiB。上限来自既有前端正文预算，没有扩大前端或旧脚本时间预算。
- 正常 `end` 必须满足 `reply.complete === true`，下游仍为未发送的新响应。实际 status 与非 hop headers 被保留，Content-Length 由完整原始 Buffer.length 计算；不做字符长度估算、不解码重编码、不拼装 JSON。
- `action-response-end` 日志记录 native 完整结束、status、字节数和 SHA。这证明上游完整，不能替代浏览器完成事件或正文读取；旧 smoke/strict 仍独立守住后者。
- upstream error、aborted、end 前 close、超限，以及下游未完成就 close，都会保留 `proxy-error` 并关闭 native 请求。未发头且下游可用时只返回普通失败 502；不会输出已缓存的成功前缀，不能伪装成受控原动作 502 的 JSON。
- `framingFailure` 仅防止同一次失败被 error/aborted/close 重复处理；首次失败日志不会丢失。旧 smoke 与 strict 的 proxy-error/readFailure 失败门禁没有修改。
- deny-response 与 denyReply 仍在完整 native end 后产生，位于 res.end 调用之后，维持旧事件顺序。调用 res.end 并不证明浏览器读完，因此旧浏览器正文与完成断言必须保留。
- 32 MiB 为单响应有效载荷预算。正常结束 Buffer.concat 会短暂同时保留 chunks 与完整 Buffer，峰值载荷内存约为预算两倍；超限在复制当前超限 chunk 前停止并释放已收集 chunks。没有宣称全进程内存硬上限。

独立 contract 代理对 v1 的短审未发现明确 fail-open，对 v2 delta 也未发现新增阻断点。随后逐项只读审阅精确 SHA 7d098... 的 native 测试候选，确认其通过真实 native 客户端/服务端断言可见传输行为、deny 使用公开控制、非 action 有真实 streaming 正向控制，未发现阻断问题。该代理同样明确 100 ms 窗口与纯 HTTP 证据的范围。其审查未应用 patch、未启动测试。

静态原件：`framing-candidate-static-checks.json` 和 `framing-candidate-v2-static-checks.json`。Node v22.23.3 `--check` 与 `git apply --check --whitespace=error-all` 均退出 0。静态检查完成时原维护源码的七项 SHA 前后相同；此时间点早于 root 后续独立应用 patch。

## 已实际执行的 native HTTP 八案

运行目录：`native-http-v2-run-20261018T045913.500955Z/`。

- Node v22.23.3；syntax exit 0；native-tests exit 0。
- TAP：8 tests / 8 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo；duration_ms 1065.9987。
- 测试进程 UTC 04:59:13.577492 至 04:59:14.705014。
- native-tests stdout SHA256：bfac622d70384203a6631d689199751c0995324275b62dab4d658148ac1bc2b3；stderr 为空。
- runner 明确绑定 ignored v2 SHA 48f656...，不以 root 的其他版本运行替代本专项。执行期间维护 relay/smoke/旧 verifier 三项 SHA 前后完全相同；当时维护 relay 已由 root 独立应用为 v2。

| 案例 | 实际断言 | 结果 |
| --- | --- | --- |
| action GET 200 | 上游 prefix 送出并保持 tail 时，下游无响应头/正文；end 后实际 UTF-8 bytes、200、非 hop headers、准确 CL 与日志 SHA 一致 | PASS |
| action GET 409 | 同样保留真实业务失败 status 与 bytes，不强改为 200/502；长度按 byte 计算 | PASS |
| 真实 held-original 后 deny POST | 使用公开 arm/originalReady/sendControlled502/finishOriginal 控制；deny upstream end 前无成功响应；完整 201/bytes/headers/CL；上游只收到一次原 POST 和一次 deny POST，两份原请求 body 一致 | PASS |
| 非 action response | upstream tail 仍被保持时，下游已经收到 prefix；end 后完整字节一致 | PASS |
| upstream abort | 不发送原成功前缀；返回完整普通 502，保留 proxy-error，无 action-response-end；只有一次 native 请求 | PASS |
| 声明正文截断 | native Content-Length 比实际长一字节时不重算为成功短正文；失败 502且无成功 end 日志 | PASS |
| 32 MiB + 1 byte | 使用真实 native 分块写入和背压；超过合同一字节即失败；无部分成功数据、无重试 | PASS |
| downstream cancel | tail 未结束前取消客户端，唯一 native upstream 被关闭；无成功 action-response-end且保留失败日志 | PASS |

结果清单：`inputs.json`、`syntax.json`、`native-tests.json`、`result.json`、各命令原始 stdout/stderr，以及 `native-http-evidence/native-relay-*/relay.jsonl`。准备时的精确文件绑定在 `native-http-v2-preparation.json`。

测试断言真实 native 客户端可见的 status、headers、正文、流式时机、连接结束和真实上游收到的次数/bytes；没有 mock http.request 或读取 fixture 私有计数。公开 arm 控制仅用于构造真实 deny 请求窗口。日志断言补充证据合同，不能单独证明浏览器语义。

held-before-end 的负向观察窗为 100 ms，配合上游真实 prefix write 完成屏障与显式 tail gate。它是确定受控样例的传输验证，不是任意调度环境下的永久无响应证明。

测试候选保留 `HEIMDALL_FRAMING_TEST_OUT`，可将日志留在指定 evidence 目录。未指定时只删除由 mkdtemp 创建、父目录和前缀均验证过的自身临时目录。所有 server/client 都在 t.after 中关闭。

以上八案验证 framing 边界，不替代本机/WSL 四案 UI、旧 strict、完整 Core 或新精确 SHA 的完整 Linux CI，也不改变原 Linux CI failure 的事实。未继续启动额外运行。
