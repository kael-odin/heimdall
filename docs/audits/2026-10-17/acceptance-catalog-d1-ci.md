# D1 精确提交 Linux CI 复核与夹具迁移适配

日期：2026-10-17。精确 head 为 `c170f503964601b7d125c2f902760c1235cc2e39`，run `39020282414`，attempt 1。整轮结论为 **failure**；不把以下通过步骤扩写为整轮成功。

## 实际执行结果

| 范围 | 本轮结论 |
| --- | --- |
| core e2e / 本地 fixture / 三组 acceptance benchmark job | success |
| console build job | success |
| core lint、文档链接、Console 构建 | success |
| 完整 Core | 2325 total / 2321 pass / 0 fail / 4 skip |
| Linux 实际 rename 发生在 open 后、首次 fstat 前的原生用例 | pass；本机 Windows 跳过的时序已在 Linux 实际执行 |
| 原 Acceptance console | success |
| Spec contract、跨运行复验、项目目录、显式迁移、Spec baseline smokes | success |
| Managed Spec preparation | failure；`owner-and-selection` 阶段 `CATALOG_UNAVAILABLE` |
| 其后的 managed / Browser / Docker smokes | 未执行，不宣称通过 |

D1 的 first-fstat 修正有自身 Linux 用例与原 Console 通过证据。该结果不能倒推出更早 `0988fc3` 那次展示 409 的精确根因。

## 失败原因与修正

**离线复现与源码确认：** `smoke-acceptance-managed-preparation.mjs` 把历史 B2.1 的 Schema2 catalog 原字节复制到隔离根后，直接 `initialize({createSchemaVersion:3})`。D1 明确取消旧格式普通启动时的隐式迁移，因此返回 `CATALOG_UNAVAILABLE / MIGRATION_REQUIRED`。同一原脚本在 Windows 复现同阶段失败，故障并非 Linux 专属，也没有证据指向 mtime 或 first-fstat。

修正只改变该 smoke 的测试 setup：使用真实 owner，先 `previewMigration({targetSchemaVersion:4})`，再提交该次预览的完整 generation / revision、head / previous SHA 和 planDigest 确认，显式走 `2→3→4`。保存预览、确认、结果和 Schema2 原字节前像；核对原 maps、events 前缀和 14 份来源文件。

原 prepare、同键重放、错误确认拒绝、来源移动、重取 owner、零 fetch、零 target 请求和零新运行等 25 项检查语义保留，新增两项显式维护检查。修正后的本机结果为 **27/27**、exit 0；它不代替修复提交自身的 Linux CI。

## 原件归档

整轮 run metadata、1,667,632 字节原日志、artifact metadata、原 ZIP 及完整提取附件均已归档，随 [D2 证据索引](../../archive/audits/2026-10-17/evidence/acceptance-browser-candidates/README.md)发布。

GitHub 返回的 artifact 原 ZIP 为 1,447,004 字节、163 项，SHA-256 为 `54d1b9d708e9313d801ed3706257967f02dea32253feb83fcf8ef9267a71a6fc`，与远端 metadata.digest 完全相同，ZIP CRC 通过。原 CI artifact 未包含 preparation 的临时根，不能声称保留了远端失败的全部文件系统现场；远端原日志与本机确定性复现分别保留。
