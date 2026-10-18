# D6 最终归档准备 v2 独立静态审查

日期：2026-10-18。审查人：`/root/d6_contract_readthrough`，另有只读子审查 `/root/d6_contract_readthrough/lifecycle_contract_review`。

本报告仅代表静态源代码、精确终态配置和既有原始证据的读取结果。两名 reviewer 均未执行 create、verify、strict、engine、Browser、build、测试或语法检查，未 stage / commit / push。D7 生命周期 runner reviewer 也没有启动重型进程。

## 原始失败与修正范围

v1 的 `validateBatch` 假设 aborted 的原始采集状态必为 running / endedAt:null。现场原件实际已经由 driver 收束为 completed / passed:false；保留的 Core stage PID40724 退出码为 1。测试被人为中止，与采集器写回终态是两个可并存事实。v1 因此拒绝该原件；v2 修正这一状态合同，不改写历史记录，不把中止 Core 计为完整 Core 通过。

原始中止批次：`core/workspace/_runs/d6-implementation-20261018/final-core-20261018T015531.909919Z`。当前只读确认：

- batch startedAt `2026-10-18T09:55:32.038239+08:00`，endedAt `2026-10-18T09:59:45.123778+08:00`，status completed，passed false，changedInputs 空。
- 唯一保留 stage 为 `node core/scripts/test-core.mjs`，PID40724，exitCode1，endedAt `2026-10-18T09:59:44.981717+08:00`；inputs-after 存在。
- `operator-interruption.json` 原件记录同一 targetPid、verifiedCommand 和 `taskkill /PID 40724 /T /F`。其文字“Not a completed Core test result”描述验证没有完整结束，不能拿来覆盖 batch 已写回的采集状态。

v1 全部准备文件保持冻结。后续独立重现目录 `archive-v1-aborted-state-reproduction-20261018T035023.953075Z` 的真实 run 为原 v1 create 命令、exit1、changedInputs 空，stderr 保留 actual completed / expected running。它是后续同失败真实捕获，不能冒充首次未捕获执行的原始 stdout。

## v2 源码核查

审查版 `archive-control.mjs`：33015 bytes，SHA256 `b264d684cfd71db38d4fbc2da91b851bf0520e634defad03b0f4675562eab4ac`。

第 109–132 行让 aborted 保留原 running 或 completed 状态，但两者均须 passed:false、调用方 terminalConfirmed:true、非空说明和原 operator-interruption JSON。有效证明须有正整数 targetPid、非空 reason / verifiedCommand，verifiedCommand 精确对应计划 argv，taskkill 文本与 /PID 均对应所记录目标。completed 分支第 127–128 行还要求该证明 PID、argv 对上实际保留的非零 stage。

第 134–156 行使全部 completed 记录共用真实 endedAt、batch inputs-after / changedInputs、每阶段计划 argv / cwd / environment、完整 run.json 相等、输入差异、原 stdout / stderr 摘要、开始结束时序和原 passed 重新计算。completed 的 aborted 不能仅靠通过外部证明而绕过这些校验，且必须保留非零 stage。第 139 行仍将 running 约束为 aborted 且 endedAt:null。

第 190 行仍把四个最终批次固定为 disposition passed，第 137 行要求它们 raw passed:true，第 154–156 行要求完整阶段、输入不变且全零退出，因此本次变更没有降低最终通过规则。第 158–160 行分别保存 disposition、rawStatus、rawPassed 和被验证的 interruptionProofs；不会将 aborted 改写为 completed Core 通过。

与冻结 v1 源码的逐行 diff 仅涉及工具注释、上述历史中止合同、返回证明摘要与生成说明文本。复制、完整源树复验、symlink / hardlink 拒绝、完整 dist 快照、原 strict 唯一子进程、原输出封存和只读 verify 的实现未变。v1 源码原 SHA256 仍为 `711625bc19765991a7094f09009597808b9788d1c5f9d94262b7ebe7c090fbcb`。

running / null 情形没有未落盘 stage 可独立反查其 targetPid；它依赖原 operator 证明和调用方已确认终止事实。工具没有运行系统探测，也没有声称可凭文件重新证明进程当前存活状态。原证明没有时间戳，v2 不补造时间。

## 最终配置只读复核

`inputs.final.json`：7184 bytes，SHA256 `38c4e5230c35c471d177e21752d1d02a8a25fecc9a7242bc4535f5367891b343`。

- schemaVersion1 / d6-final-archive-inputs，repositoryRoot 为 D6 树，archivePath 为固定 final 目标。global terminalSourcesOnly:true 延用 root 对全部精确终态来源的明确授权；不可执行模板仍是 false。
- 四个 final 路径与冻结 v1 完全一致，两个历史批次路径也未改。此前已独立核对四批 status completed、passed true、changedInputs 空，static2 / core1 / browser27 / docs1 各 stage exit0。
- 14 个 supplemental 均 terminalConfirmed:true。20 个 batch / history / supplemental 来源全部存在、ID 无重复、无占位路径。额外独立保留完整冻结 v1、完整 v2 与真实 v1 后续失败重现窄目录，没有使用活动批次父目录。
- frozen-index 原结果 passed:true，四批各627输入且一致，627文件 exactMatch 全部 true。aborted 配置说明已纠正为原 completed / false、PID40724 exit1，但 disposition 仍是 aborted。
- v1 最终配置仍为6057 bytes / `1600df5a9688f1f8e08706d90e0855aa2bafa5397daaf4d013ee5826d8f36d06`，未改动。
- 配置复核时 final 目标目录尚不存在。没有创建归档目录或尝试覆盖。

当前没有发现其他确定静态阻塞；此结论允许 root 使用真实包装命令进入 v2 create，不能替代尚未执行的 create / copied strict / verify / verify --sources 结果。任何真实执行失败都须保留原始失败，不改写本报告为运行通过。
