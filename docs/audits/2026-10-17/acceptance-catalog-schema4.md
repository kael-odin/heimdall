# Schema4 显式维护与完整旧历史兼容

日期：2026-10-17。D1 为后续 Browser 候选建立独立格式，并把旧目录升级改成可预览、明确确认的维护操作。现行合同与命令见 [Schema4 指南](../../competition/acceptance-catalog-schema4.md)。

基准提交自身 CI 再次出现展示读取 409 后，已独立复现另一早期 fd 时序并追加修正。包含追加修正的新一轮语法、原 Acceptance console、真实 forge、Console→Clone CDP、旧数据显式迁移和 fresh Browser Schema4 混合历史均已通过。最终完整 Core 为 **2325 total / 2313 pass / 0 fail / 12 skip**；七轮各自的 549 份源码快照前后不变。证据封存与精确提交自身远端 CI 分别记录，不用本机成功代替 Linux 结论。

本片基于 `0988fc333b3ec6abd857c4a5ccac5a5484906ee1`，包含 [运行展示读取竞态修复](acceptance-display-head-race.md)的追加修正。该基准自身 CI `39015344019`、attempt 1 已实际 **failure**；Schema4 与追加修正一起提交，精确提交的自身 CI 待推送触发。基准失败、追加专项和 D1 最终验证分别记录，不能互相代替。

## 1. 实现与停止线

Schema4 新增独立 `browserCandidates` 表、`bc-*` 身份与 `browser-candidate-created` 历史事件。纯格式验证完整项目、版本及 `ax-*` 来源归属关系、每来源最多一个候选、来源摘要、组织上下文摘要、候选内容摘要与事件前缀；迁移得到的 Browser 候选表仍为空。

旧 `sourceContentDigest` 公式冻结。新的域分离摘要绑定完整 project / release / sourceBinding；候选内容摘要绑定合同版本、模式、项目、版本、来源归属与摘要，不含 bc 存储 ID、创建时间、actor、目录 generation / revision。默认 Browser 候选上限为 1024、单实体 8192 字节；完整迁移链最多三步。格式自洽不等于当前来源证据仍可核验。

已有 Schema3 / Schema4 普通启动只打开并验证，不自动升级。旧 Schema1 / Schema2 返回 `MIGRATION_REQUIRED`，未知版本拒绝；目录未能打开时，不收束遗留 running 原件，验收写入保持 blocked。空目录内部创建必须明确指定 3 或 4，引擎为新空目录明确选择 Schema3。

维护 CLI 提供 `--create`、`--preview`、`--apply`，动作必须是第一参数。活动引擎持有同根 owner 时维护拒绝，不强抢锁；无效或重复参数在获取 owner 前拒绝。预览和应用只处理目录元数据，不读取来源 run、报告、PNG 或 dispatch 子树，不启动恢复、worker 或浏览器。

D1 没有开放 Browser 候选写入 API、完整来源复核 API 或保存按钮。现有 [Browser 归属工作台](../../competition/acceptance-browser-bindings-console.md)继续提供显示预览，`preview.presentation.completeSourceProjection:false`；所有相关结果仍为 `executionReady:false`。Browser 完整复核与持久候选属于 D2，Browser 批准、选用和固定来源执行在后续独立切片。Spec 的 `ab-*` 候选、批准、选用、取消与 managed-spec 合同未扩大。

## 2. 显式维护与失败语义

维护预览包含 head / previous 原字节 SHA、generation / revision、逐步转换、前像清单、容量与 `planDigest`。应用必须提交该次预览的完整确认；队列内重新计算并检查，旧身份或旧计划拒绝。CLI 成功 stdout 为安全 JSON，`completedSteps` 是数组，apply 不返回整份 catalog。已是 Schema4 的新预览可明确应用零步计划。

Schema1 按 `1→2→3→4`、Schema2 按 `2→3→4`、Schema3 按 `3→4` 逐步转换。每步独立切换 generation、增加一次 revision、追加一条迁移实体与全局事件；旧实体、事件前缀、source / Spec candidate 摘要及当前 Spec 选用 ID 保持原值。旧页面的 CAS 因此过期。

原始 head / previous 按实际版本和原字节 SHA 排他保存为 `catalog.v1.<sha256>.json`、`catalog.v2.<sha256>.json` 或 `catalog.v3.<sha256>.json`，每版本最多两份。只复用原字节相同的安全常规文件，拒绝链接、坏 JSON、版本或摘要不符。全部链的事件、迁移、JSON、前像与根条目容量在准备文件写入前检查。

每步先保留前像，再写 rolling previous，最后原子替换 head；head 是本步提交点。这不是跨文件或断电事务。I/O 失败时可能已完成前几步，或留下未提交的本步前像 / previous；保留现场，重新预览当前目录并用新确认续迁。普通启动不续迁、不删除现场，也不把失败自动回退为最初版本。

真实 owner、根目录身份、有界 FD、stat / EOF / 原字节围栏是维护权限与读取边界。CLI 获取 / 释放 owner 会改变根目录 stat；“预览不写迁移文件”不等于根目录属性完全不变。这些检查仍依赖合作进程的单写者约束，不承诺对任意外部进程提供文件系统隔离。

## 3. 已执行验证与待完成项

以下计数来自各轮实际 command、stdout、exitcode 和 summary，不累计父子用例或重复运行。早期专项及追加修正前结果明确标记为各自快照；最终门禁使用包含 first-fstat 修正的新一轮。

| 检查 | 当前结果与证据边界 |
| --- | --- |
| 纯格式与摘要专项 | 45 total / 45 pass / 0 fail / 0 skip；611.2272 ms；包括既有格式与新 Schema4、组织候选摘要 |
| 显式维护及根预算修正专项 | 90 total / 90 pass / 0 fail / 0 skip；29,297.92 ms；包含此前 81 项维护测试及新增边界 |
| Catalog / Spec / Browser / API / recovery 集成专项 | 149 total / 149 pass / 0 fail / 0 skip；72,939.9544 ms；旧格式启动不迁移、不恢复，Schema4 保留 prepared 原件 |
| 追加修正后 Core 语法 | 457 file(s) OK，exit 0；22,772 ms 墙钟 |
| 追加修正前 Console build | 436 modules，exit 0；681 ms；保留大 chunk 告警，不写成无告警构建 |
| 追加修正后原 Acceptance console | 17/17 界面检查，exit 0；29,125 ms 墙钟；`pageErrors:[]`；业务夹具仍如实检出 3 个 BUG、gate failed |
| 追加修正后真实 forge 流水线 | exit 0；35,100 ms 墙钟；recon 2 页、forge / live bundle / watch / jobs 完成 |
| 追加修正后 Console→Clone CDP | task done / clone HTTP 200 / `pageErrors:[]`，exit 0；30,581 ms 墙钟；2 张截图 |
| 追加修正后旧数据真实迁移 | 21/21 检查，22 个 API 用例；exit 0；27,453 ms 墙钟；目标请求 0、页面 errors 为空；finally 成功场景归档实际完成 |
| 追加修正后 fresh Browser Schema4 混合历史 | 19/19 检查；exit 0；53,872 ms 墙钟；真实 Chromium CDP / mirror / regression worker / 原生归属控件 |
| 追加修正前完整 Core | **2321 total / 2311 pass / 0 fail / 10 skip**，591,291.785 ms，exit 0；549 份源码前后不变，仅证明追加修正前快照 |
| first-fstat 追加主树专项 | 47 total / 44 pass / 0 fail / 3 skip；48,958.5622 ms，exit 0；不替代 D1 最终整仓验证 |
| 含追加修正的最终完整 Core | **2325 total / 2313 pass / 0 fail / 12 skip**，579,577.5286 ms，exit 0；549 份源码前后不变 |
| 证据包独立验证 | 工作树与 Git 暂存两轮均 passed / exit 0；95 份包文件、41 组、549 条源码全部匹配；[独立发布核验](evidence/acceptance-catalog-schema4-publication/README.md)保存原件 |
| 文档链接 | `pnpm docs:links` exit 0；[命令与日志](evidence/acceptance-catalog-schema4-publication/docs-links/command.json)完整保留；最终暂存前再次确认链接 |
| D1 精确提交与自身远端 CI | 本提交推送后触发，再按精确 head、run / attempt 和实际执行范围单独归档；本报告没有 D1 Linux CI 通过结论 |

追加修正后的语法、原 Console、forge、CDP、legacy migration、Browser v4 与完整 Core 七轮包装器均记录 `sourcesUnchanged:true`、`sourceFileCount:549`。快照范围为实现、脚本、测试、前端、workflow 与 package 文件的明确集合；不把它等同于依赖、构建目录和整台机器被冻结。追加修正前的旧快照与结果仍独立保留，不替代新轮。新增 Linux 原生时序用例在 Windows 跳过；自身 Linux CI 仍需实际执行。

## 4. 真实旧数据迁移与成功归档

追加修正后最新通过的 legacy 流程使用已提交 B1 与原生 V2 Spec 证据的独立副本，通过实际 CLI、引擎、浏览器完成维护：

- B1 三条真实运行、18 份来源文件，显式 `1→2→3→4`，revision 12→15，保留每步原字节前像与旧失败报告；两次重启后字节保持，并继续创建项目、版本与旧运行归属。
- 缺失来源使用另一份隔离副本；迁移保留归属事实与独立不可读诊断，未回填来源或改变原门禁。
- 原生 V2 历史含 2 个 Spec 候选、5 个批准、7 个选用 / 取消，14 份来源文件；显式 `2→3→4`，revision 20→22，原实体、摘要、当前选用与重启读取保持。
- 桌面 1440 与手机 390 的 7 条布局记录未出现文档横向溢出；旧目标请求为 0，没有新验收 worker。这里验证已有真实证据的迁移兼容，不是重新执行原验收目标。

最新轮输出为 `core/workspace/_runs/acceptance-catalog-migration/2026-10-17T08-32-41.139Z-1051a9de/`。其中确实存在 `runtime-scene-0`、`runtime-scene-1`、`runtime-scene-2` 以及三份对应 digest JSON；分别有 28、22、23 个文件路径，均保存 `bytesEqual:true`。追加修正前的 `2026-10-17T07-59-38.397Z-54f460fb/` 原件另存，不覆盖为本轮。

本次成功运行已实际经过新版 finally：关闭浏览器、停止全部引擎并保存日志后，将 disposable 根复制到全新 runtime-scene，比较复制前后及再次读取的源内容 SHA，再写 digest，最后清理临时源根。因此“成功路径完整场景保留”已从早期源码确认提升为真实执行证据。

**失败分支的场景归档仍只有源码确认，没有在最终脚本上另行注入失败演练。** 当前顺序会让 catch 后进入同一 finally；复制、核验或 digest 保存失败发生在清理该根之前。但 browser.close、stop 或前一个归档异常可能中断后续根处理，尚未处理的根只保留在原临时位置，不保证全部进入 OUT。`treeDigests` 证明文件路径与内容摘要，不证明复制后 inode、nlink、mtime / ctime 或目录属性相同。

早于 finally 补强的 legacy 首次失败与修正成功没有 runtime-scene；当时已保留的 JSON、CLI / 引擎日志与截图继续保留，不能事后宣称那些轮次已有完整场景副本。

## 5. fresh Browser 混合历史兼容

追加修正后最新流程于 2026-10-17 08:33:09.265–08:33:57.476 UTC（香港时间 16:33:09–16:33:57）执行真实 Chromium CDP 操作。新采集 mirror 与 regression 来源，两个原比较门禁均为 `failed`；来源侧健康资格、原比较结论和组织归属是独立事实。

原生 UI 完成明确选侧、重新确认、baseline / target 独立归属、只读核对、三类证据角色、损坏证据拒绝、项目 A→B→A 迟到响应拒绝、丢失 POST 响应后按存储历史对账且不重发、来源变化时保留归属、关闭或切换时撤销 Blob URL。3 个创建的 Blob URL 均已撤销。10 张截图和 10 条布局记录包括桌面及手机深浅主题，记录中的 documentWidth 均未超过 viewport。

然后停止旧引擎，明确建立 Spec 草稿、候选、批准、选用→取消→重选及三条 dispatch / lifecycle **夹具事实**，显式迁移 `3→4`，重启并经 HTTP / UI 复核旧来源及当前 Spec 选用。最终 catalog 为 Schema4：3 个项目、3 条 Browser 来源归属、1 个 Spec 候选、1 个 Spec 批准、3 条 Spec selection、**0 个 Browser 候选**。

三条派发分别为 `prepared-only`、owner-bound lifecycle writer 的 `CANCELLED` 与 `ENGINE_RESTARTED`。它们不调用 Spec executor，不能记为三次真实执行或 Browser executor 证明。Spec `approved:false` 草稿走 blocked / no-request 路径。

本轮 head 与 rolling previous 原字节不同，预览明确计划两份 v3 前像，夹具逐份核对原 bytes 与 SHA。迁移后重启、HTTP 和 UI 读取的 71 个文件，其路径、bytes、SHA256、nlink、mtimeNs、ctimeNs 与迁移后记录保持相同。该 byte/stat 合同覆盖同一个运行目录读取，不与上一节跨目录复制的内容保真合同混用。

受控 target 共有 16 次请求，均属于初始 capture；binding、setup、maintenance、restart、HTTP / UI 读取阶段新增请求为 0。preview / apply 时的同步 FS 读取 guard 未记录来源或 dispatch 读取。guard 只覆盖被替换的同步 string-path API 与该时段，不是任意 async / FD / URL I/O 的通用沙箱或全进程网络隔离。

`pageErrors` 为空；全程保留 1 条为丢失 POST 回复故障注入产生的预期 502 资源错误。该夹具先确认服务器真实返回 201，再向页面提供受控 502，验证按存储历史对账而不重发。Schema4 阶段以固定起点检查无新增资源错误，因此不能把本轮写成“全程零 HTTP 错误”。所有 Browser 显示 DTO 仍是 `completeSourceProjection:false`，没有新批准权或执行权。

本轮输出为 `core/workspace/_runs/browser-bindings-console-smoke-770ea8de-62f8-4ac8-a420-4b13b134a1c2/`。来源文件清单、catalog 前后、混合历史、最终 byte/stat 树、请求日志、错误记录、截图与 DOM 原件分别保存；已直接核对迁移后的 71 条树记录与复核后树相同，不能只以 checkCount 代替底层证据。追加修正前的 `browser-bindings-console-smoke-7625c329-e4da-40a9-933a-7a8661f4501b/` 仍独立保留。

## 6. 已关闭问题与保留的失败

| 类型 | 原事实与影响 | 修正及当前状态 |
| --- | --- | --- |
| 产品 P2：根条目预算遗漏 | 原 root 已有 4095 / 4096 条目时，preview 误报 eligible；apply 新建前像 / previous 后总数达到 4097，随后拒绝，head 仍旧，但再次 preview 也受阻 | 完整链预算新增前像、缺失 previous 与发布临时槽 1，将当前计数绑定 planDigest 并在预览末重核。90 项专项与独立边界探针通过，P2 已关闭；原失败保留 |
| legacy harness 旧表断言 | 初轮将旧 schema 尚未引入的表 undefined 与空对象比较，导致误失败 | 仅在所属格式步骤检查新表为空，已有表保持原值；最终 legacy 21/21。没有为此放宽产品 validator |
| Browser harness 前像清单 | 首轮只允许一份新前像，实际 head 与 previous 不同，正确迁移生成两份 v3 前像，树比较失败 | 按 preview 完整 sources 精确决定新文件，逐份核原字节；最终 Browser 19/19 |
| Browser harness opaque origin | 第二轮在 about:blank 的 init script 无条件读写 localStorage，产生页面异常 | 仅在 http / https 文档设置 token，不吞实际页面错误；最终 pageErrors 为空 |
| 原验证缺口 | 迁移后的重启 / HTTP / UI 缺完整 byte/stat 树围栏，资源错误豁免可覆盖新阶段 | 增加两次全树比较及固定 Schema4 阶段错误起点；最终真实执行通过 |
| DTO 断言层级 | 旧新增断言曾将 completeSourceProjection 读在 preview 直接字段 | 修正为 preview.presentation.completeSourceProjection；最终真实执行通过 |

根预算独立失败现场为 `d1-store-independent-14c75139-1b29-4e00-8800-9885e197aae1/root-entry-capacity.json`；修复复核为 `d1-store-independent-fixed-1767e73c-7996-476b-a406-cf1026c3884e/independent-fixed-results.json`，均在 `core/workspace/_runs/` 下。

独立复核对原 4095 / 4096 边界分别做两次 fresh preview，均写前拒绝且原集合与 head SHA 不变；另以 Schema1 / 4091 原条目验证精确成功边界，预算 `requiredNewCount:4`、`temporaryEntries:1`、`projectedFinalCount:4095`，实际三步成功。这里的条目数包含取得 owner 后当时实际存在的条目。

legacy 初次失败 gate 为 `legacy-migration-smoke-ebbf2c73-ee60-4489-b7f5-972f801b45f2`；Browser 两次失败 gate 为 `fresh-browser-v4-initial-8ade882c-97d9-4fdd-9b41-d34debee7226`、`fresh-browser-v4-two-preimages-88183da7-4319-47c3-ae8d-f3c1b3949e9a`，均位于 `core/workspace/_runs/d1-integration-20261017/`，对应 failure、stderr、截图及当时可保存的运行材料不覆盖、不删除。

上表除根预算 P2 外的失败属于测试夹具 / 断言及验证完整性修正，不应写成产品来源原件已经损坏。后述基准 CI 的 GET 409 是独立的真实展示失败，不属于这些夹具错误。不能把后来的通过结果改写为早期轮次通过。

### 基准 CI 失败与追加 first-fstat 修正

`0988fc333b3ec6abd857c4a5ccac5a5484906ee1` 的 run `39015344019`、attempt 1 已实际 failure。Linux Core **2302 total / 2298 pass / 0 fail / 4 skip**，原生“第一次 readSync 后 rename”用例通过；原 Acceptance console 仍记录单条 GET detail 的 `409 / MANAGED_RUN_INTEGRITY_FAILED`，随后200，最终因第161行 `errors=[]` 断言失败，后16个步骤 skipped。随后200和单测全绿均不抵销该失败。

归档原件位于 `core/workspace/_runs/ci-main-display-head-0988fc3-run39015344019-attempt1-b8011f5d-f9af-475b-bfb5-4529a879272f/`，保留精确源码、日志与失败附件；没有具体 fence / syscall trace 或运行目录，所以不能断言精确 CI 因果。

后续已独立确定性复现并修补另一时序 `open→rename→first fstat`，并补 `观察 A→发布 B→open B→发布 C→fstat B`。修正保持 display-only 返回实际打开的稳定字节、strict/source/managed 继续拒绝越权；没有增加重试、延长 timeout 或豁免浏览器409。主树原失败 `first-fstat-repro-33c9e056-467e-4036-9816-21f76f4b17a6` 与修正后47项专项分开保留。它是独立缺口复现，不是本轮 CI 事件的根因证明。

追加修改的 `managed-run-reader.mjs` 与 `acceptance-display-head-race.test.mjs` 已同步到 D1；包含修正的新一轮语法、五项真实 smoke 和 2325 项完整 Core 均通过，含修正精确提交自身 CI 尚待执行。D1 早期的 2321 项完整 Core 仅证明追加修正前快照。更完整的基准失败及追加时序说明见 [展示竞态审计](acceptance-display-head-race.md)。

## 7. 证据等级与发布收口

| 证据等级 | 本片内容 | 仍有的限制 |
| --- | --- | --- |
| 本地真实流程 | 历史真实证据副本经实际 CLI / 引擎 / 浏览器显式维护；新采集 Browser worker、原生 UI、混合历史维护与重启读取；legacy finally 成功场景归档 | 受控本地目标，Spec 生命周期部分为明确夹具；没有 Browser 候选写入 / 批准 / 选用 / executor，也不证明真实外部业务或部署冻结 |
| 离线专项与独立复现 | 45 纯格式、90 维护、149 集成、根预算原失败与修复边界 | 对应各自快照，不能代替最终完整 Core 或 D1 自身远端 CI；进程内 I/O 失败注入不等于物理断电测试 |
| 源码确认 | finally 失败分支归档顺序、同步 FS guard 的覆盖范围、格式与 API 边界 | 最终脚本没有另做失败归档实跑；不承诺所有异常后全根均已复制或任意 I/O 被阻断 |
| 待完成 | 精确 D1 提交与自身 CI | 自身 Linux CI 不得预判通过；基准 0988 CI 已失败，旧本机 2321 项属于追加修正前快照 |

[公开证据包](evidence/acceptance-catalog-schema4/README.md)已封存 41 组完整来源目录，包含 **21,836 份原文件、27,705,426 bytes** 原始内容及空目录清单。公开包为 95 份文件、19,499,035 bytes，包含逐组 tar.gz、成员清单、打包器、固定输入计划、549 条最终源码 guard 与完成凭据。完整成员集合和原字节回环均通过，所有输入目录与源码在打包前后保持一致。早期失败、追加修正前快照、基准 CI 失败与追加修正后结果分别归档。

`COMPLETED.json` 的 SHA256 为 `8eb770fa28e80cd6725c330fd26014190dac2bb6a8c2c78b44ef110ec7cee020`，`INDEX.json` 为 `5703beb0e6783843c21ac1ee4d8d6768767c95900350449fdbb56141b2cefcf2`。

[独立工作树与 Git 暂存核验](evidence/acceptance-catalog-schema4-publication/README.md)均已通过：95 份公开文件、41 组、21,836 份原件、139 个目录及 61,982,720 bytes tar 膨胀内容的 gzip CRC、完整路径与类型集合、逐件 bytes / SHA256、原现场稳定性均吻合；549 份最终源码、17 条关键记录与七组最终快照匹配，原 351 文件 CI 证据链保留。每轮强凭据签名扫描覆盖 **81,481,755 bytes、0 findings**；这表示已定义模式没有命中，不是任意敏感信息均已排除的证明。独立 staged 核验确认 95/95 份原包 blob 与工作树精确同字节；包外源码、文档与发布核验记录由最终全 index 检查另行覆盖。

追加修正前的五轮 gate 原件位于 `core/workspace/_runs/d1-integration-20261017/`。目录前缀虽为 final，不能覆盖后来源码发生变化的事实：

| 追加修正前门禁 | 精确目录 |
| --- | --- |
| 语法 | `final-syntax-5f0fc4b3-becd-4b32-bb7f-5551fff62a63` |
| Console build | `final-console-build-c1a8bb46-a8e9-4652-84e5-93d4a4ea31fd` |
| legacy 迁移 | `final-legacy-migration-2524e7e8-317a-4f96-a9e8-44a4949c6da2` |
| Browser v4 | `final-browser-v4-6729f76d-93be-4bc7-9e8c-22cd53823a38` |
| 完整 Core（已通过，旧快照） | `final-full-core-3b089409-e83a-4969-abb3-4125d3267a30` |

追加修正后的最终 gate 原件在同一父目录，各门禁保持独立命令、日志、退出码与源码身份：

| 追加修正后门禁 | 精确目录 |
| --- | --- |
| 语法 | `final-first-fstat-syntax-5e241a6b-ef5d-4374-bb03-0e2029955a2b` |
| 原 Acceptance console | `final-first-fstat-console-67488241-7c22-4396-948d-763542963bc9` |
| 真实 forge 流水线 | `final-first-fstat-forge-9efa4e9f-902b-4a8b-8e90-ef71700d1abe` |
| Console→Clone CDP | `final-first-fstat-cdp-f3a7f80b-a2c2-4e12-9b84-9c44903eda5c` |
| legacy 迁移 | `final-first-fstat-legacy-b8cae31c-b1e1-4e51-952a-09a629758eae` |
| Browser v4 | `final-first-fstat-browser-v4-410cf627-c87b-49eb-ac3d-91b44c50b2db` |
| 完整 Core（最终通过） | `final-first-fstat-full-core-346ba75b-3e2c-4e31-8745-8af482cb24bf` |

文档合同已核对 README、HANDOFF、ROADMAP、目录指南及 Schema3 沿革：普通启动不迁移、现行维护以 Schema4 为目标、新空引擎明确创建3、D1 不扩大 Browser 权限的叙述一致。历史审计继续记录当时自动迁移行为，未被重写为现行流程；通过现行指南区分版本。

精确提交与自身 CI 在推送后单独记录。上一片 `0988fc3` 的 Linux 单测通过但整轮 CI 失败，不能填入本片通过栏；本片本机完整回归及 smoke 通过，也不能预先推定其远端结论。
