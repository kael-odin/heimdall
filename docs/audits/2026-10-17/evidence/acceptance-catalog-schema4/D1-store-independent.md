# D1 Catalog 显式维护独立审查（2026-10-17）

状态：原审查发现 1 项 P2，root 已修复，独立复核通过；当前审查范围没有未解决的 material finding。本文不是全项目发布验收证明。

工作树：`C:\Users\44548\.codex\worktrees\managed-spec-provenance\heimdall`。
范围：`catalog.mjs`、`catalog-maintenance-cli.mjs`、维护测试，交叉读取 `owner.mjs`、`catalog-preimage.mjs`、`atomic-file.mjs` 与纯构建器边界。没有修改产品/测试，没有 stage、commit 或 push；没有重复运行既有 81 项专项。

## P2：根目录条目上限没有预算迁移新增文件

原审查版本：

- `core/src/acceptance/catalog.mjs` SHA256 `229c7c3b81717ca82c35a5f7c4d332e2efdaa31adba2969f67d8cb652ffb45c3`。
- `core/src/acceptance/catalog-maintenance-cli.mjs` SHA256 `d9f908c2608c12ab650590d67bb956c60ee46e29677b5c34e8cb4aa6f7dfc999`。

位置：`catalog.mjs:137-148` 的 `maintenanceNames` 对 root 总条目数设 4096 上限；`migrationPlan` 的 `318-365` 只计划前像槽位和事件/JSON容量，没有将即将新增的前像、缺失的 `catalog.previous.json` 计入 root 预算。写入发生于 `preservePreimage:263-279` 与 `commit:236-245`。

确定性独立探针：

`core/workspace/_runs/d1-store-independent-14c75139-1b29-4e00-8800-9885e197aae1/root-entry-capacity.json`

两个隔离 genuine-owner schema3 目录，其他条目均为无关空文件：

| 维护时原总条目数 | preview | apply | 留下的新文件 | apply 后总条目数 | head |
| --- | --- | --- | --- | --- | --- |
| 4095 | `capacity.eligible:true` | 503 `MIGRATION_ROOT_ENTRY_CAPACITY` | 前像 + previous | 4097 | 原 SHA，schema3 |
| 4096 | `capacity.eligible:true` | 503 `MIGRATION_ROOT_ENTRY_CAPACITY` | 前像 | 4097 | 原 SHA，schema3 |

影响：原 head 没有损坏，但已知预算错误导致可避免的半程准备文件；再次取得 owner 后 root 条目数继续超过上限，新的预览也会被阻断。应在任何准备文件写入前，预算整条链的新增前像、缺失 previous，以及发布所需同目录临时文件，并将计划身份需要的计数纳入摘要与稳定性复核。

## 其他审查结论（截至原审查版本）

- `initialize:408-435`：空目录必须显式选择 3/4；既有 3/4 仅读取并验证 head/previous；既有 1/2 返回 `MIGRATION_REQUIRED`，不调用迁移构建器。未知格式由严格 validator 拒绝。
- `assertMaintenanceOwned:100-104` 与 `owner.mjs:24-26,145-167`：维护使用本模块 WeakSet 中真实取得且仍持原 nonce/inode/root 的 frozen capability；method-shaped object、copy 和 proxy 不获得维护权限。
- `readMaintenanceFile:105-135`：有界 FD 读取，拒绝符号链接及 nlink != 1，读取前后 lstat/fstat/realpath/EOF 围栏，严格 UTF-8，最后重新检查 owner。该结论仅限维护读取，不把普通 legacy 读取入口升级成同等安全合同。
- `migrationPlan:318-365`：当前原始 head/previous SHA、generation/revision、前像 inventory、limits 和完整链容量进入计划；随机未来 IDs/时间不进入计划身份，固定宽度模拟确保 JSON 大小预检。除本次 root 条目遗漏，事件、migrations、jsonBytes 与每版本最多两份前像均在写前预检。
- `applyMigration:375-405`：确认 head/previous 原始字节摘要与计划摘要，队列内重新计算，不自动接受旧确认。元数据迁移不读取运行、来源证据或 dispatch 子树。
- `migrateOne:281-312`：先保留准确来源前像，再替换 rolling previous 与 head；前像 wx 冲突只有原字节完全一致才接受；每个发布阶段继续检查 owner、head/previous 与 inventory。失败保留已发布事实，普通 initialize 不续迁；需要重新 preview/apply。
- CLI `19-48`：显式动作必须首参数，重复/未知/缺失 flags 和非标准数字确认在 owner 获取前拒绝；不启动引擎或执行器。`54-65,69-75`：创建不覆盖现存 metadata，成功 JSON 仅输出维护结果/安全身份，apply 不输出 catalog 整树；错误走 allowlist，无原路径、parser text 或 stack。

已读取既有专项原件：`catalog-maintenance-specialist-20261017/attempt-0eb37baa-724e-499e-8dd4-9990669448bd/{command.json,exitcode.json,stdout.log,source-before.json}`。原命令三份测试串行，81/81、0 fail、0 skip，进程 exit0；当前原审查时两个产品文件 SHA 与 before 一致。

限制：本轮没有重复执行全量 Core、浏览器 smoke、引擎启动或真实旧数据迁移；不覆盖 D2 Browser candidate 写入/API/UI。既有中断测试验证的是进程内注入的发布失败/owner丢失/根替换，不能据此声称物理掉电事务或 hostile filesystem 的完整原子 CAS。

## 修复复核

root 的修复已完成独立复核：

- `maintenanceNames:137-148` 返回稳定读取的 `{names,count}`；`migrationPlan:320,360-375` 把 root 当前计数、整条链新增前像、缺失 previous，以及同目录发布临时槽纳入 `capacity.rootEntries` 和 `planDigest`，在写前拒绝超出预算，计划结束重核条目数。
- `acceptance-catalog-migration.test.mjs:43-82` 新增上限、全链、前像/previous 复用、schema4 no-op 与计数变化 stale-confirmation 测试。读取了 root 的专项命令/summary/exitcode：`d1-integration-20261017/root-capacity-983e6568-aca2-4efd-abe1-24f28206871c`，进程 exit0，`sourcesUnchanged:true`；90 项通过由 root 的执行结果报告，本独立审查不重复运行该整套测试。
- 独立再次复现原始两个边界（4095、4096）：每个两次 fresh preview 均返回 `MIGRATION_ROOT_ENTRY_CAPACITY`，原文件集合和 head SHA 完全不变，没有留下任何新文件。
- 独立新增精确成功边界：schema1、4091 个原条目，preview 预算 `requiredNewCount:4, temporaryEntries:1, projectedFinalCount:4095, maximumCount:4096`，实际完成三步 1→2→3→4，最终 4095 个条目。
- 独立探针 exit0、`passed:true`、`sourcesUnchanged:true`；证据：`core/workspace/_runs/d1-store-independent-fixed-1767e73c-7996-476b-a406-cf1026c3884e/independent-fixed-results.json`。
- 修复后审查源码 SHA：catalog `f14034f3f9ad458101fd4e68d30703c654053bdfeb3ae2d857330b00fdd2d80b`；CLI `d9f908c2608c12ab650590d67bb956c60ee46e29677b5c34e8cb4aa6f7dfc999`；相关三文件 `git diff --check` exit0。

结论：本次已确认 P2 关闭；其余维护设计没有发现第二个 material finding。原失败探针现场保留，不删除或改写。