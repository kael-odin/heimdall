# D1：Catalog Schema4 显式维护证据包

日期：2026-10-17。首次 `fstat` followup 后的 D1 本机最终门禁已通过：syntax、原 Console、forge、CDP、legacy、Browser v4 和完整 Core 均完成，各门禁 549 条源码前后不变。最终 Core 为 2325 total / 2313 pass / 0 fail / 12 skip，579577.5286 ms，exit 0。发布 guard 使用 `final-first-fstat-full-core-346ba75b-3e2c-4e31-8745-8af482cb24bf/source-before.json`；它与 source-after 精确同字节，SHA256 为 `bb3bf1497be59e7b0d9ca057739701c19ca94c574fc6c3d534275c5e31f78d36`。`pendingGroups` 已清空，ignored 准备目录已定稿供主任务打包和独立核验。精确提交自身的 Linux CI 待发布后触发并核验，本机通过不能预判此前 409 已在 CI 修复，也不能认定新增 Linux 原生时序用例已执行。

## 能力与边界

D1 增加严格 Schema4 纯格式及 Browser 组织候选摘要合同，并把“普通打开”与“显式维护迁移”分离。普通启动不代替操作员执行旧库迁移；维护通过 genuine owner、预览计划及确认后的 apply 完成版本迁移，并保留 catalog 前像。

Schema4 的 `browserCandidates` 格式接受未来候选合同。D1 新建/迁移结果仍为空表，当前没有 Browser candidate 写 API、批准、选用或执行器；`executionReady: false`。来源只读 DTO 的 `presentation.completeSourceProjection: false` 不能当作来源完整执行授权。原 Spec 与 Browser 来源归属合同继续受到各自边界约束。

本包保存 D1 的来源证据，以及触发首次 `fstat` followup 调查的 main `0988fc3` CI 完整失败归档、主树首次 `fstat` 的复现与修正定向门禁。此前 C/display-only 热修复和更早的 Linux CI 已在[独立证据包](../acceptance-display-head-race/README.md)保存；这里引用该包，不重复压入更早的 C CI。

## 已有历史验证

| 证据 | 已确认结果 | 范围 |
| --- | --- | --- |
| `01-format-attempts` | 45 tests / 45 pass / 0 fail / 0 skip；早期 43/43 成功尝试同树保留 | 纯格式与 identity；不证明来源 eligibility，不运行 Browser/Core |
| `02-maintenance-specialist` | 原 81 项维护专项原件保留 | 后续容量修正以 90 项与独立边界探针为准 |
| `03-integration-maintenance90` | 90 tests / 90 pass / 0 fail / 0 skip；wrapper exit 0 | 根条目预算修正专项，历史 548 条源码快照 |
| `03-integration-targeted149` | 149 tests / 149 pass / 0 fail / 0 skip；wrapper exit 0 | D1 集成定向验证，历史 548 条源码快照 |
| `04-format-independent-probes` | 7 组 outcome 全为 pass；24 种事件排列仅依赖顺序合法的一种被接受 | 独立 schema/identity 探针，不等于 store、来源、恢复或 Browser 验证 |
| `05`、`06` 容量探针 | 原 4095/4096 失败事实保留；修正后 fresh preview 写前拒绝，schema1+4091 条目迁移成功 | 完整现存 filler 现场随目录归档，原 key-JSON 索引不能替代完整目录 |
| `09-browser-v4-third-pass-runtime` | 历史第三轮 19/19、10 张截图、`pageErrors: []` | 合并 display 热修复前的受控本地 Browser 流程，不能替代最终合并后门禁 |
| `10-legacy-corrected-pass-runtime` | 历史修正轮 21/21，旧目标请求为零 | 早于 finally 完整 runtime 归档补强，不能冒充补强已实跑 |
| `13-final-syntax`、`14-final-console-build` | exit 0；各自 549 条源码前后不变 | **pre-followup 历史**；早于后续 reader/test 修正 |
| `15-final-legacy-gate`、`16-final-legacy-runtime` | 21/21、22 API cases、0 target requests；exit 0；549 源码不变 | **pre-followup 历史**；成功流程实际归档了三份 runtime 场景与 digest |
| `17-final-browser-v4-gate`、`18-final-browser-v4-runtime` | 19/19；exit 0；549 源码不变；`pageErrors: []` | **pre-followup 历史**；受控本地 Browser 流程，仍无 Browser executor |
| `19-final-full-core` | 2321 total / 2311 pass / 0 fail / 10 skip；591291.785 ms；exit 0；549 源码不变 | **pre-followup 历史**；目录名中的 final 不代表验证了后续 reader/test 修正 |
| `20-main-ci-0988-failure` | main `0988fc3`、CI `39015344019` attempt 1 完成且 failure；原日志、下载件、失败 artifact、精确源码和 query receipt 整树保留 | 详情 GET 曾返回 409；没有 syscall 轨迹，未证明该 CI 恰好触发首次 `fstat` 窗口 |
| `21-first-fstat-repro` | 修正前复现 exit 1，542 源码前后不变 | 主树固定 gate；保留预期失败，不是 CI 根因的精确证明 |
| `22-first-fstat-targeted` | 47 total / 44 pass / 0 fail / 3 skip；exit 0；542 源码不变 | Windows metadata 模型通过；两条新增 native Linux first-fstat 用例未在本机执行；不是 D1 最终整仓结果 |
| `23-followup-original-console-gate`、`24-followup-original-console-runtime` | 修正后原 Console 17/17 检查、`pageErrors: []`；exit 0；549 源码不变 | 本地受控夹具与模型模拟器；原报告保留 3 个行为 BUG 和 `gate: failed` |
| `25-followup-forge-gate` | 修正后 forge exit 0；549 源码不变 | 本地 fixture recon/clone/live/watch/persistence smoke；SEO 仍为 77、13 issues；只保存原 gate 现存证据 |
| `26-followup-syntax-gate` | 修正后 457 files OK；exit 0；549 源码不变 | 静态语法门禁 |
| `27-followup-cdp-gate`、`28-followup-cdp-runtime` | task `done`、clone HTTP 200、`pageErrors: []`；exit 0；549 源码不变 | 真实 Console→克隆产物的本地 fixture 流程，含 receipt 和两张截图 |
| `29-followup-legacy-gate`、`30-followup-legacy-runtime` | 21/21、22 API cases、0 target requests、`errors: []`；exit 0；549 源码不变 | 修正后成功 finally 场景副本和三份 digest 原件；不代证所有归档异常分支 |
| `31-followup-browser-v4-gate`、`32-followup-browser-v4-runtime` | 19/19、`pageErrors: []`、binding/read target requests 为 0；exit 0；549 源码不变 | 原比较 failed、显式 Spec harness setup、预期 502 和 `executionReady: false` 均保留 |
| `33-followup-full-core` | 2325 total / 2313 pass / 0 fail / 12 skip；579577.5286 ms；exit 0；549 源码前后不变 | 本机最终 Core 通过；before/after 精确同字节，已接受为新发布 guard；精确提交自身的 Linux CI 待发布触发 |

`13`–`19` 的固定目录与 ID 保留原名，以保持证据引用稳定；它们均属于首次 `fstat` followup 之前的历史。旧 Core 为 2321 total / 2311 pass / 0 fail / 10 skip，不能代替后续 reader/test 修正后的验证。修正后的本机最终固定 gate/runtime 分列在 `23`–`33`，全部已完成。

历史第三轮 Browser 使用真实 Mirror/Regression engine worker 和原生来源归属控件，保留两个原比较的 `failed` 结果。Spec 草稿、candidate/approval/select/cancel/reselect 和三条 dispatch/lifecycle 都是明确的 harness setup：两条生命周期通过 owner-bound writer 写入 `CANCELLED`、`ENGINE_RESTARTED`，另一条仅 `prepared-only`；这些事实不表示本轮真实运行了 Spec 或 Browser executor。Spec `approved:false` 草稿走 blocked/no-request 分支。

该历史轮独立重核了 548 条源码 before/after、迁移后 71 文件 byte/stat 树、两份 v3 前像和 16 条受控目标请求；binding/setup/maintenance/restart/HTTP/UI 读取没有增加该目标请求。它不是全进程网络隔离证明。3 个 Blob URL 已撤销；10 张截图均存在。保留一条显式注入的预期 502 资源错误，不能写成“全程零 HTTP 资源错误”。

## 失败与修正历史

原根条目预算问题属于产品维护缺陷：4095/4096 条目时 preview 曾误报 eligible，apply 准备文件后拒绝并留下影响后续 preview 的条目。修正把所有新增前像、缺失 previous 和发布临时槽纳入完整预算及 planDigest；原失败和修正后的边界场景分别保存。

容量探针采样 `actualCountAfter` 后正常释放了 owner，每个 case 的 lock 文件因此移除；当前磁盘文件数比该历史采样值少 1 属于已知生命周期差异。空 filler 文件仍完整保留，不因大小为零而排除。

Legacy 首次失败来自较旧格式没有 `browserSourceBindings` 字段时，harness 错把 undefined 与空表比较。Browser v4 首次失败来自 harness 只排除一份 v3 前像，遗漏合法的 previous 前像；第二次失败来自 `about:blank` opaque-origin 的 localStorage 初始化 pageerror。随后修正 harness 并获得历史第三轮通过。全部失败 wrapper、failure JSON、DOM、截图、日志与现存 runtime 完整保留，不能把 harness 失败改写为已证明的产品来源损坏。

main `0988fc333b3ec6abd857c4a5ccac5a5484906ee1` 的 CI `39015344019` attempt 1 在 Core 2302 total / 2298 pass / 0 fail / 4 skip 后，原 `Acceptance console (real browser, local model stub)` 步骤失败。原断言要求 `pageErrors: []`，实际出现一条 409 资源错误；对应详情 GET 的错误码为 `MANAGED_RUN_INTEGRITY_FAILED`，相邻同详情 GET 为 200。后来的 200 不否定先前 409；归档没有 fence cause、syscall/stat 轨迹或 run 目录，不能把源码上可能存在的首次 `fstat` 竞态认定为该次 CI 已证明的精确根因。

该 CI 中原有“读取后 rename”的 native Linux 用例通过，但它发生在首次 `fstat` 之后，两条新增首次 `fstat` native Linux 用例当时尚未存在。后续主树复现保留了修正前 exit 1 和修正后 47/44/0/3 的固定原件；Windows metadata 模型的本机通过不能升级为新增 native Linux 用例已实跑。修正只作用于 display-only 旧 run 的受限读取分支，不授予 managed、source 或 artifact 权限。D1 合并后现已获得新最终 guard 和本机整仓门禁通过结果；精确提交自身的 Linux CI 仍待发布后触发，旧 CI 的失败事实和因果证据限度继续保留。

旧的 standalone 独立审查和 `11-independent-evidence-review/audit-draft.md` 保持当时原字节，包括当时尚未合入热修复、最终门禁未执行的状态说明；它们是历史记录。最终状态应由本说明定稿、最终 guard 和最终门禁原件共同判断，不修改旧报告来制造新的时间线。

## Legacy finally 归档边界

旧首次失败和旧 21/21 成功输出没有 `runtime-scene-*`，不能事后恢复不存在的 disposable 根。finally 补强通过源码审查确认会在停止 Browser/engine 后，将每个已登记根复制到全新输出目录、逐文件路径/内容摘要回核并重读来源，再删除相应 disposable 根。它保证的是路径与普通文件内容摘要，不宣称保全 nlink、inode、mtime/ctime 或目录属性。

pre-followup 的 legacy 成功流程已实际产生 `runtime-scene-0/1/2` 及三份 digests；独立读取当前场景的完整文件集合并重算 SHA256，28、22、23 个文件分别与对应 copied/source 映射完全一致。该结果可把该历史成功归档路径的证据级别从源码确认升级为本地实跑，不代表后续 reader/test 修正后的重跑已经完成。

首次 `fstat` followup 后的 legacy 重跑也已完成 21/21、22 API cases、0 target requests，并留下新的三份 runtime 场景及 `bytesEqual: true` digest 原件，单列在 `30-followup-legacy-runtime`。该新目录的全文件集合与 SHA 独立重算由最终证据核验负责，不能借用上一轮 28/22/23 的重算记录代证。

若关闭、停止或归档异常使顺序 finally 提前结束，未处理 disposable 根可能仍留在原临时位置；不能声称所有失败均已归档。成功现场也不能代证早期失败、复制失败、digest 保存失败或其他异常分支都已经演练。

## 归档合同与发布状态

本包复用已独立审查的通用 `pack.py`，算法字节未改。每组完整目录独立保存为 `archives/<id>.tar.gz`，包含空目录和所有普通文件，不设排除规则；来源 metadata、字节长度、SHA256 和 mode 记录在 `manifests/<id>.json`。门禁和 runtime 均按已完成的固定 attempt 子目录收录，避免后续文档检查或 CI wrapper 写入动态父目录而改变本包输入集合。精确组集和数量以最终 `INDEX.json` 为准。Tar 不宣称精确保全纳秒时间戳或所有目录属性。

`controls/pack.py`、`controls/inputs.json`、`controls/source-guard.json` 和公开文档为精确字节副本；`12-packer-source` 保存整个打包准备目录。包内 `.gitattributes` 保持原证据字节不被 Git 文本归一化。输入完整树前后比较、归档完整成员集合/逐文件字节与 mode 回环、gzip CRC、最终源码 guard 全部通过后才最后写入 `COMPLETED.json`；发布后还需独立 verifier 重算。

独立 verifier 只接受工作树相对 group path，因此 `21`、`22` 使用 D1 ignored 新目录 `first-fstat-main-gates-13f939e3-a932-48c9-997a-aad54d8fbcc9` 内的精确副本，各 7 个文件；主树原件保留。复制前、复制后重新读取来源，完整目录/文件集合与字节长度、SHA256 均一致，来源快照前后不变；原 `command.json` 的 cwd 和路径不改写。`first-fstat-main-copy-receipt.json` 保存完整复制核对收据。该合同不宣称 inode、ctime、nlink 或所有目录属性均被复制保全。

首次 `fstat` followup full-Core 已完成且通过，549 条源码 before/after 不变，新最终 guard 已接受，`pendingGroups` 已清空。定稿计划有 41 组固定来源、5 份精确文档，最终包完整组集和数量以 `INDEX.json` 为准。当前仅完成 ignored 打包输入定稿及固定门禁副本核对，尚未执行 plan/pack；公开打包、独立 package verifier、提交发布与精确提交自身的 Linux CI 由主任务继续完成。准备目录仅包含 `pack.py`、`inputs.json`、`PUBLIC-README.md` 三个冻结文件，之后不再向该目录写入新内容。
