# D6 四脚本独立复核与校验器修复

日期：2026-10-18。工作树：`C:\Users\44548\.codex\worktrees\ci-small-runner-concurrency\heimdall`。

本轮最初只读审查 smoke、relay、ingress、verifier 四文件。随后按根代理明确指示，仅修改 `core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs`，修复当前输入门禁和已证实的 ingress 快照、时间校验缺口。其余三文件、生产 UI、原验收断言未改；未启动 Browser、engine 或 Core 测试，不占用唯一 Browser 窗口。

## 1. 实际运行证据与当前门禁的区分

复核对象为 `../defect-ticket-decisions-console-smoke-20261018T093910120/`（第七轮）。其原始 summary 为 passed=true，13 个全局检查、A/B/C/D 各 17 个业务检查；本代理实际运行当时冻结的独立 verifier，exit0。完整 `relay.jsonl` 中 `fixture-error`、`proxy-error`、`original-upstream-error` 均为 0。第六轮的 2 个 teardown proxy-error 不计为严格通过。

该轮运行前后输入清单一致。第一次独立重算当前输入时，12 份指定源码与其清单一致，但当前 `console/dist` 已变化：例如旧 `Atlas-BzmHPBZE.js` 为 492685 bytes，新 `Atlas-SgWAog6v.js` 为 494310 bytes，`index.html` SHA 亦变化。原 verifier 仍 exit0，确证它没有核验当前构建。此时的重算原件保留在 [current-inputs-recomputed.json](current-inputs-recomputed.json)。

因此第七轮仅能证明其冻结源码和冻结 bundle 的真实业务流程；它不替代修复后当前输入门禁的新 Browser 运行。修复后原第七轮证据被当前门禁拒绝为预期行为，也因为 verifier 自身已改变。

原 verifier 留档：[verifier-before-current-inputs.mjs](verifier-before-current-inputs.mjs)，SHA256 `6ed1be2e9f654aa5e5bb79d576446fc6bcac096c920b120577c17cd383340f58`。

## 2. 已证实并修复的两项问题

### A. 输入清单相等不代表是当前实现

旧 verifier 只做 before==after，并检查 sources 的键数量是 12；没有冻结明确 path 集合，没有检查 bytes/SHA 的形状，也没有读取当前源码及 dist。将两份 manifest 的 store SHA 同时改成 64 个 0，原 verifier 仍 exit0。

修复位于新 verifier 第 12、53、63、77 行附近：固定 12 个明确相对路径；每条记录只能含 `bytes` 和 `sha256`；bytes 必须是非负安全整数，SHA 必须是 64 位小写十六进制；before/after 必须一致；实际重算 12 份当前源码及当前完整 dist 文件树后再精确比较。当前门禁默认为必须匹配，没有加入跳过当前源码检查的选项。

### B. prefix 快照和时间未与实际 ingress 日志完整绑定

旧 verifier 检查前缀 hash、完整 body hash、relay 数组中的决定次序，但没有强制 prefix/deny-ack 快照精确等于完整 ingress 对应 trace 的前缀，也没有核对 ingress 前缀实际发生在 controlled 502 前。把 A 案 request/data 的时间一致改成 2099 年、同时更新各 ingress 快照及 jsonl，旧 verifier 仍 exit0。

修复位于新 verifier 第 26、166、172、176、181 行附近：所有相关时间必须是精确 ISO；同一 ingress、relay、原始请求 CDP 流内时间不许倒退；prefix、deny-ack、held-deny 快照必须精确等于对应实际 ingress 流前缀；最后 prefix data 时间不得晚于 controlled 502；同时强制 `original-tail-release <= ingress end <= original-upstream-response`。保留原始字节、canonical JSON+LF、SHA、四案赢家和错误门禁，未将它们改成自报结果。

## 3. 已执行的独立反例和修复后验证

[probe-results.json](probe-results.json) 和对应 stdout/stderr 保留旧 verifier 的真实结果：原第七轮 exit0；双 manifest 的 store SHA 置零仍 exit0；普通 GET 的 ERR_ABORTED 改为 ERR_CONNECTION_RESET 仍 exit0；prefix 时间改 2099 年仍 exit0。变异均只改证据副本，真实第七轮目录未改。

修复后执行两个 ignored 离线程序：

- [verify-current-inputs-cases.mjs](verify-current-inputs-cases.mjs)：13 项。包含 1 个离线有效输入正例、真实旧运行的当前输入拒绝、过期源码 SHA/bytes、保留 12 数量但换 path、无效 SHA、负数/小数 bytes、多余记录字段、过期/缺失/空 bundle、before/after 不一致。结果全部符合预期，见 [current-inputs-cases-results.json](current-inputs-cases-results.json)。
- [verify-ingress-order-cases.mjs](verify-ingress-order-cases.mjs)：10 项。包含 1 个离线正例、prefix/deny-ack/held-deny 快照不一致、2099 年反例、prefix 晚于 502、end 早于 tail、end 晚于上游响应、非规范 ISO、同流时间倒退。结果全部符合预期，见 [ingress-order-cases-results.json](ingress-order-cases-results.json)。

合计 23 项预期匹配：2 个离线正例、21 个拒绝对照。两个正例复制真实旧 artifacts 后，人工把副本 manifest 绑定到当前代码，仅用于隔离校验器分支；这些目录已经在程序和结果中明确标为 offline，不能冒充当前 bundle 的真实 Browser 验收。

最终 `node --check core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs` exit0，目标文件 `git diff --check` exit0。冻结 SHA256：`c6017f8c608131cc577619d8fc515ef50c5457eee5cf4c191138f2989d9e993b`。已通知根代理可立即使用此冻结版本运行最终 Core 和新 OUT。本代理后续不再改该维护文件。

## 4. 原始证据重算能力核对

当前 verifier 并非只相信 summary 的 true：它独立重算原始 UI body SHA 和 requestFingerprint、deny envelope、canonical decision JSON+LF、decision disk bytes/SHA，以及 original/deny/GET 三份完整决定证明；逐案核原始 POST 唯一性、完整引擎 ingress hash、单一请求/连接、末尾结束、真实 CDP/PW 正常完成、deny 请求、只读 unresolved 与决定赢家；还核源文件原件、事件目录唯一新增、最终 ticket 和截图 PNG 尺寸。

relay 的普通转发在 `pendingRequests` 集合跟踪；第七轮 teardown 先关闭 Browser/Chromium 停止新流量，保持 engine 可用并等待普通转发排空，再 abort held、停止 engine、关 server。smoke finally 在完整退出之后再扫描全部 relay 错误并纳入 passed；verifier 也读完整 jsonl 拒绝三类错误。未引入按错误文字广泛忽略的过滤。

## 5. 保留的明确边界

普通 GET 不属于“所有请求零失败”承诺。真实第七轮有 2 个初期 `browser-executions` GET 的 ERR_ABORTED（发生在首次受控原动作前），还有退出阶段 2 个普通 GET 在采样中未标 finished。其生命周期取消/退出边界与 D6 原始 POST、deny 正常完成分别核对。旧 verifier 能接受把普通取消改为 CONNECTION_RESET，确证普通 GET 不在当前严格错误类型门禁内；根代理明确要求本轮不扩此承诺，也不加入允许错误过滤。

本报告未把该普通 GET 变异称为真实产品发生连接重置，亦未将 2099 年变异称为真实时钟异常。它们都是独立校验器反例。

本轮没有重新视觉审查四图、没有重新执行当前 Browser 业务流程，也没有以源码推断 CI 旧超时的具体内部停点。当前最终验收仍需根代理的新 OUT 真实运行与严格 verifier。

