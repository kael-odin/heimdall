# 托管 Spec：核验读取与消费者隔离

日期：2026-10-17。范围：B2.2-b 的只读消费者切片。managed 运行现可读取状态、取得可靠完成快照、下载核验报告及引用证据，并参与显式运行对比较。candidate、triage、owned recovery 与 engine executor 仍隔离，继续保持 `executionReady:false`。

## 已实现的行为

`readAcceptanceRun` / `listAcceptanceRuns` 通过托管读取层核对派发 namespace、不可变准备记录与固定运行身份，提供 managed head。`readAcceptanceSnapshot` / `readAcceptanceSnapshots` 在同一有界范围内捕获报告和引用证据，批次结束后再次核对所有已捕获事实；批量结果与输入顺序一致，缺失项保留 null。坏来源、身份、摘要、结构或证据均不能形成有效完成快照。

完成事实以存储层已经提交的 completed manifest 为准。真实 BUG 的 `completed + failed`、普通 timeout 或预算受阻的 `completed + blocked` 仍可形成有效快照；running 进度和半份报告只可作为运行现场，failed / interrupted 收尾也不能借用残留报告成为完成事实。读取不创建运行、不发起目标请求，也不补写或修复现场。

`readAcceptanceArtifact` 返回核验捕获的 Buffer、SHA-256 和 contentType。JSON 下载返回报告原 bytes；Markdown 从同一已核验报告派生，忽略磁盘上可能存在的 `report.md`。证据必须出现在该报告的核验证据索引中；manifest、triage、sidecar、temporary 及未引用文件不可下载。比较使用同一批次的可靠快照，继续沿用现有稳定检查身份、verifier 兼容与保守复验判定。

HTTP 列表及详情返回明确的安全 DTO：managed 记录带最小来源标识与 `triageSupported:false`，不返回计划、完整 envelope、私有 receipt 或 owner nonce。failed / interrupted 的本地错误原件保留在磁盘，HTTP 使用固定脱敏说明，避免输出路径或凭据。控制台能够查看生命周期、原门禁、引用证据及 JSON / Markdown 下载，并提示当前不支持 AI 解读。

显式 `readLegacyAcceptanceRun` 保留旧 CLI、mutation、finish、path artifact、triage 和 recovery 的隔离边界。managed / reserved 身份即使删除 manifest / report 的托管标记也不能降级；读取可见性不赋予执行能力。managed 完成运行仍不能通过旧 catalog bind 认领为本项目目标或相同 URL 的其他项目来源，拒绝不新增 catalog event。

## 验证与证据等级

[本轮证据索引](evidence/acceptance-managed-reading/README.md)集中保存定向测试、真实浏览器、Linux 环境及 CI 诊断产物；[质量门汇总](evidence/acceptance-managed-reading/quality-summary.json)、[源码固定值](evidence/acceptance-managed-reading/source-pins.json)与[原件到归档件映射](evidence/acceptance-managed-reading/archive-provenance.json)记录实际范围和字节摘要。

| 验证 | 实际结果与范围 |
| --- | --- |
| 新托管读取真实浏览器 | 7/7；pageErrors=[]；390px viewport / document 均为 390。覆盖安全 head、真实生命周期、completed BUG、triage 不可用、引用证据、原 JSON / 派生 Markdown、running 不冒充完成与读取零执行 / 零事实改写 |
| Linux 最终定向回归 | 189/189，0 fail / 0 skip；78126.442098 ms；原生 Linux Node v22.23.3。源码位于 WSL 9p，fixture 临时根位于 ext4；20 份源码 SHA 在执行前后不变。范围为 schema / reader / batch / CLI / HTTP / quarantine / DTO / catalog / managed Spec 合同，不含浏览器或外部真实业务系统 |
| 独立消费者集成 | 12/12；真实目录准备、owner 与内部 writer，覆盖 prepared 零创建 / 请求、running / partial / terminal、BUG / timeout、混合批次、重算摘要的假通过与计划错配、下载边界、CLI / HTTP / catalog 隔离。脱敏错误场景补充后 HTTP 定向 1/1 |
| Catalog 真实浏览器复验 | 原脚本 1 次、诊断 probe 并行 3 次、同步改进后 1 次均为 17/17；catalog target requests=0。诊断拒绝探针把延迟 POST 状态设为 409，在约 7.6s 准确失败于 201 断言并保存现场 |
| Core 语法检查 | 373 files，通过 |
| 最终 Windows Core 全量 | 1654 total / 1650 pass / 0 fail / 4 skip；224404.778 ms。跳过为 Windows 不适用的 2 项 FIFO / 非 regular pipe，以及需显式启用的 2 项 network-none Docker；Linux 定向回归已覆盖前两项，Docker 本地未运行，交由 CI 独立步骤验证 |
| Console build 与 Core smoke | build 通过，保留原有 chunk >500kB 提示；smoke 通过，2 页、visual / DOM 100%、offline health unresolved=0 / external=0。分数只适用于该本地夹具 |
| 最终浏览器与准备回归 | 8 条真实浏览器 / CDP 流程及 1 项私有准备 smoke 全部 exit 0。包括 managed 读取、普通 Spec、comparison、catalog、一般验收、旧目录迁移、需求基线、原有 CDP 克隆与 managed preparation；全部使用独立新输出目录 |
| 原有 CDP 克隆闭环 | 控制台实际点击 → 生成 home → 打开克隆产物；taskStatus=done / cloneStatus=200 / pageErrors=[]，两张截图已归档 |
| Markdown 文档链接门 | 530 个本地目标 / 137 份 Markdown，通过；检查日志与结果已归档 |

新托管浏览器流程使用真实 prepare 与显式内部 `runSpecAcceptance` / writer，在引擎启动前生成受控本地运行；之后浏览器只读。其证据明确记录 `engineExecutorTested:false` 与 `engineRecoveryTested:false`。创建和准备本身没有目标请求，只有测试显式调用 runner 后产生请求；不能把内部 runner 的成功作为托管执行入口或重启恢复已经可用的证明。

本轮还覆盖真实 partial report 的多硬链接发布现场：仅 reserved managed 的非 completed 可选报告允许有界多硬链接捕获，并固定实际 nlink、长度、身份和重复字节。completed 报告、manifest 和引用证据继续要求 single-link，partial 的存在不开放下载或比较资格。

十源 verifier 仍为 `e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8`。旧算法与历史 verifier allowlist 未改；两份历史候选 golden 摘要及 14 份来源原件已重新读取并对照父提交核验，保持原有字节。

## 父提交 CI 与诊断改进

父提交 `f72edadcf5e31c066bac8141733569e8f02ee084` 的 CI `38946429912` 中，Core tests、console build 和独立 smoke job 已通过，catalog console smoke 在等待 `catalog-notice` 时触发 `locator.innerText` 的 30000ms 超时。场景为延迟 release POST、切换项目、保留当前草稿、再释放旧响应；原日志不足以区分后端提交、route 响应投递或 UI 刷新哪一阶段出现间歇失败。

本轮将固定 150ms 等待改为 route 处理完成信号，对两笔延迟 POST 明确断言 HTTP 201 和 fulfill 成功；notice 读取改用 `allTextContents`，避免 locator 默认 30 秒等待覆盖外层 25 秒轮询预算。失败会输出有界项目 / busy / notice / error / 最近响应，并保存 panel DOM、截图和 catalog response trace。CI 在失败时精确上传这些 JSON / UI / PNG 与 engine log，保留 7 天；root package 同步提供 `acceptance:managed:read:smoke` 别名。

这些改动使阶段失败能够直接暴露并留下可下载现场。原间歇根因在本轮复验中没有复现，因此不能声称已定位或修复某个确定的产品缺陷。父提交 CI 的结果也不替代本次新提交自身的 CI 结果。

## 保留的边界

- managed candidate、triage、owned recovery、engine executor、统一运行槽与 task mirror 仍需后续接入；prepared、同键重试、重启或来源恢复不会自动启动执行。
- 当前读写一致性依赖实际 owner 的单写者约束与有限文件检查，不构成操作系统原子 inode CAS、敌对管理员签名或跨文件断电事务。
- 报告、计划和证据交叉核验用于发现不一致，不能证明所有来源被协同伪造后的远端 HTTP 真实性；不把 JSON 重序列化称为响应正文原 bytes 核验。
- 本轮 HTTP 与浏览器验收均使用受控本地夹具；认证、写操作、外部获授权业务系统及真实项目泛化仍未验收。
