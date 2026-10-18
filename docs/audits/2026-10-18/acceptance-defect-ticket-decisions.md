# D6 人工动作决定与 Catalog 状态恢复

本片为人工成单、明确关闭增加永久拒绝决定，并修复 Catalog 已收到提交回执后、刷新请求长时间不结算时的状态恢复。实施起点为 `41c359a62ecbb67ac15f38c51c95fa983a7492d3`，开发工作树为 `codex/defect-ticket-decisions-d6`。冻结后的完整 Core 与 27 阶段 Browser 已通过；发布后的精确提交完整 Linux CI 仍须独立核验，本机结果不能替代该发布门禁。

后续状态：原发布提交 `06e4303` 的完整 Linux CI 已终态为 failure，Core、原二十项 smoke、Docker 与前端构建成功，独立 D6 四案正文取证失败。精确原件和原验证器的不接受结果见[原提交 CI 记录](acceptance-defect-ticket-decision-ci.md)；[后续动作回复边界增强](acceptance-defect-ticket-response-framing.md)保留本机对照与待验边界。

## 产品行为

人工动作响应未知时保留完整旧确认。操作者可以只读核对，或逐条复核后明确拒绝同动作号的迟到提交。原 accepted event 和 rejection 竞争同一个不可覆盖决定文件；先发布的决定获胜。已成单或关闭的决定不会被后来拒绝撤销，拒绝先胜后原业务请求只返回同一个完整拒绝。

页面独立核验完整请求、fingerprint、决定原件规范字节及 SHA，再在原生 Web Lock 内重新核对项目、上下文、storage 集合和完整旧确认，精确解除这一条。GET absence、HTTP 状态或摘要本身都不足以解除。拒绝不进入单据事件链，不改变单据 revision、成员、人工处理历史或导出。

新决定要求真实 owner、当前项目、同步 readiness 和提交 guard。完整旧证明优先于当前 Catalog、来源和新写容量核验；恢复屏障只为精确 deny 路由开放先读证明，新写仍受屏障约束。原 D5 confirmation / fingerprint v1 与 accepted event 字节合同保持不变。

操作、接口、预算及保证范围见[人工动作决定指南](../../competition/acceptance-defect-ticket-decisions.md)。保证限于保留不可变账本的同一真实数据根与正常重启，不覆盖数据根复制、备份回滚或断电后的 exactly-once。

## 专项与证据边界

下列各行是各自执行时的专项结果，存在重叠，不合并为总测试数；它们不替代当前冻结输入的完整门禁。

| 范围 | 已保存结果 | 证据级别与限制 |
| --- | --- | --- |
| D6 schema / store | 50/50 pass，含 12 个真实 SIGKILL 子进程场景 | 本地文件系统与真实子进程；不是断电测试 |
| D6 前端 helper / 实际 Vue 状态 | 分别 35/35、23/23 pass | 源码专项与实际 Vue refs / watchers 状态测试 |
| Catalog helper / 实际 Vue 状态 | 分别 24/24、16/16 pass | 离线复现的提交 ACK 与刷新 stall；不证明旧 CI 同根因 |
| D6 Browser 开发第七轮 | 四案各 17 项、全局 13 项成立，runner exit0；当时 verifier exit0 | 真实本地 Chromium / HTTP；使用旧 bundle，须由最终新 OUT 接续 |
| 新 D6 verifier 对照 | 2 个正例、21 个拒绝反例均符合预期 | 离线检验校验器；不等于重新执行 Browser |

开发四案分别是 create / close 的 rejection 先胜与 accepted event 先胜。真实 UI 原正文只进入唯一上游请求；引擎被动记录前缀后，浏览器收到明确标记的受控 HTTP 502。拒绝先胜时取得完整证明后才送完旧请求尾部；事件先胜时扣住真实 UI deny，先送完旧请求，再只转发一次 deny。这里没有把 HTTP 502 叫作 TCP 断线，也没有伪造 GET 查询结果。

第六轮曾出现 runner summary 为 true、但 teardown 追加代理错误的假绿，独立 verifier 实际 exit1。第七轮修正新夹具的关闭顺序后，全量日志含 teardown 无意外代理错误。前六轮、四组完成事件探针和旧 verifier 的三个漏检反例均保留。第七轮截图无水平溢出；手机长确认卡需要纵向滚动，截图不代表整卡同屏。

增强后的 verifier 严格冻结 12 个路径，重算当前源码和完整 console bundle；还要求相关 ingress 快照是完整日志的真实前缀，并核对规范时间及 prefix、502、tail、end、upstream response 的先后关系。旧 bundle、伪造摘要和未来时间不能当作当前验收通过。

## Catalog 修复与旧 CI

独立离线复现确认：版本 POST 已得到完整 201 实体后，后续 list GET 永不结算，会让旧 Vue 持续保持 writing / listLoading，且没有及时展示 ACK。产品现在对每个请求设定 60,000ms 预算，fetch 与完整 JSON body 共用该预算；不响应 abort 的实现也会退出等待。顺序执行的 list / detail 各有自己的预算，并非整个动作总共 60 秒。

完整提交 ACK 在刷新前可见。刷新失败保留已提交事实和草稿，释放忙碌状态，并要求只读核对；结果不完整时继续按未知处理，不自动重新 POST。项目切换、草稿变化、A→B→A 与卸载保护均保留。实际 Vue 专项覆盖项目与版本 mutate 及读取；其他 ACK 分支仅做静态复核，不扩称四路均有实际状态测试。

精确旧提交 `41c359...` 的 CI run `39082419484` / attempt1 仍为 failure：Core 2661 tests、2657 pass、0 fail、4 skipped；前 3 个 acceptance smoke 成功，Catalog smoke 超时，后续 16 个 smoke 和 Docker skipped。原 capture / verifier 结论仍为 `captureComplete:false`、`executionAccepted:false`、`passed:false`。旧日志只确认 release POST201 / route.fulfill，无法确定具体网络停点；本片修复不能反推同一根因。

历史 WSL `source-operations.test.mjs` 的 17/17 是对精确 `41c359...` 源码的单文件 Linux 专项，独立保留；它不替代该提交完整 CI，也不验收当前 D6。

## 冻结验证与发布安排

原 20 个 Core 浏览器 smoke、原 deadline、错误过滤、兼容 allowlist、Docker 与旧 CI verifier 保持。新 D6 四案及 strict verifier 放入独立 smoke job，并将同次运行证据与同次构建的完整 `console/dist` 上传到同一 artifact。下载后还需绑定精确 run、head、attempt 和 artifact ID，校验原 ZIP、源码 Git blob、bundle 原字节，再执行同 head 的新 verifier。

本机完整验证串行执行 Core 与 Browser，保存每阶段 argv、cwd、环境差量、原始 stdout / stderr、退出码、耗时和维护输入前后摘要。第一次新 Core 在起步阶段被操作者停止，以便先补齐 CI bundle 上传；该现场保留并标注中止，不计为通过。修订配置后的静态检查已通过。

首轮完整 Core `final-core-20261018T020327.749384Z` 在 02:03:28–02:29:30 UTC 执行，exit1，维护输入前后不变：2751 tests、2738 pass、1 fail、0 cancelled、12 skipped、0 todo，原生统计耗时 1,561,934.8615ms。唯一失败是新增 `D6 native HTTP close: rejected wins the same action while original body tail is held`。原竞争、完整拒绝与单据不变等断言已经完成，后续 line381 的迟到重放 `fetch` 报 `ECONNRESET`。不把其余通过拼成完整通过。

新 HTTP 测试夹具的普通 POST 现使用 `http.request` 的 `agent:false`，每个断言对应一个新连接，仍是一次真实 HTTP、完整正文和原 30,000ms 绝对预算，没有重试或放宽断言。生产实现不因此改动。修订后四案专项 `native-http-fresh-connection-20261018T023415.953722Z` 实际为 4/4 pass、0 fail / skipped、exit0，维护输入前后不变。独立 Node 25 keepalive 最小实验未复现该错误，晚请求实际使用了新连接；原失败未保存连接 ID，既不能确认也不能排除连接相关原因。再次冻结的完整 Core 与之后 Browser 批次继续独立验收。

第二轮完整 Core `final-core-20261018T023741.233470Z` 在 02:37:41–03:04:25 UTC 完成，exit0，维护输入前后不变：2751 tests、2739 pass、0 fail、0 cancelled、12 skipped、0 todo，原生统计耗时 1,603,344.1821ms。跳过项和平台限制保留在原日志；这次本机通过不替代 Linux 与 Docker 门禁。

最终 Browser 批次 `final-browser-20261018T030617.503422Z` 在 03:06:17–03:36:08 UTC 完成，27/27 阶段 exit0，维护输入前后不变。原 20 项 smoke、使用最终 bundle 的 D6 四案、独立 strict、forge、三项 benchmark 和真实 CDP 全部实际执行。新四案各 17 项、全局 13 项成立；strict 重新核验完整源码、bundle、原正文、决定字节和真实时序，并在 runner teardown 后接受完整日志。

根代理实际打开最终四张 PNG：桌面浅色的未知成单确认、手机深色的未知关闭确认、手机浅色的已成单结果、桌面深色的已关闭结果。可见 0/2 可靠失败和 2/2 已明确关闭的固定成员状态；没有观察到水平裁切。手机长确认卡需要纵向滚动，截图不代表整卡同屏。原截图、自动布局测量和人工查看记录共同保留。

最终证据已封存于[最终门禁原件归档](evidence/defect-ticket-decisions-final/README.md)，包含失败、中止、最终四组门禁、12 份实现源码及同次完整 bundle。归档创建在 04:00:06–04:00:33 UTC 实际 exit0，并在独立布局真正执行原维护 strict。随后根代理分别执行归档 `verify` 和 `verify --sources`，均 exit0；后者逐项核对当前来源，结果为 `passed:true`、`integrityPassed:true`、`strictPassed:true`、`checkedSources:true`，核验清单为 1915 files / 34,915,071 bytes。新增归档后的文档检查和最终整次暂存核验由相邻[发布检查原件](evidence/defect-ticket-decisions-release-checks/README.md)接续。归档属性保留原件的 CRLF 与终端日志空白，完整性由源文件、归档和 Git blob 的原始字节逐项核验。

封存前 v1 归档工具曾错误要求人工中止批次仍为 `running`；原 driver 实际已在停止后收束为 `completed / passed:false`，Core stage PID40724 exit1。第一次拒绝没有捕获独立 stdout；后续使用原 v1 命令的同失败重现完整保留，不能冒充第一次输出。v2 仅修正这一历史状态合同，要求中止原证明精确绑定非零 stage 的 PID 与命令，继续核对完整日志、输入和时间；该批次仍标记 `aborted`，不计完整 Core 通过。v1、v2 准备目录及后续同失败重现均以原字节独立保留。

发布后的完整 Linux CI 按精确提交单独采集，不用提交前本机通过或旧提交通过替代，也不改写旧失败原件。

## 证据导航

- [D6 开发轮与 schema / store 原件](evidence/defect-ticket-decisions-development/README.md)：专项、失败、探针及旧 bundle 第七轮。
- [D6 verifier 独立审查](evidence/defect-ticket-decisions-verifier/README.md)：旧漏检反例、增强后正反对照和输入身份。
- [D6 前端、服务与静态审查专项](evidence/defect-ticket-decisions-specialists/README.md)：原始专项输出、早期失败和两版 CI 接线复核。
- [最终门禁原件归档](evidence/defect-ticket-decisions-final/README.md)：最终四批、首轮失败、中止、12 份源码、同次完整 bundle 与原维护 strict。
- [发布检查原件](evidence/defect-ticket-decisions-release-checks/README.md)：真实 create / verify 输出、归档后文档检查及分时点暂存核验；检查结果不自证自身。
- [Catalog 状态恢复专项](evidence/catalog-state-recovery/README.md)：修复前后源码、复现与完整原输出。
- [旧 Catalog CI 失败](acceptance-catalog-ci-failure.md)：精确 `41c359...` 失败结论与原日志。
- [历史 Linux 单文件归档](evidence/source-session-linux/README.md)：原件字节、精确历史源码和证据限制。

后续 D7 先提供本地固定示例的完整产品流程，再拓展获授权的真实开发项目；不预造候选、执行或缺陷单，不把两个人工固定成员的通过率解释为整个项目通过。
