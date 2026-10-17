# 验收目录 Schema4 与显式维护

Schema4 为 Browser 需求候选增加独立的持久化格式，并把目录升级改为明确的维护操作。已有运行、Spec 候选与批准、选用及取消历史、Browser 来源侧归属保持原值；升级只追加迁移记录，不生成新来源、候选或执行授权。

本阶段交付格式、迁移与旧历史兼容。Browser 候选写入接口、完整批准预览、批准、选用和固定来源执行仍待接入。[来源归属工作台](acceptance-browser-bindings-console.md)继续提供显示预览，其 `completeSourceProjection:false` 不能作为批准合同。

## 普通启动与创建

已有 Schema3 / Schema4 只打开并验证，启动不升级。已有 Schema1 / Schema2 返回 `MIGRATION_REQUIRED`，未知版本拒绝打开，原件保留；目录未能打开时，引擎也不收束遗留的 running 记录，验收写入保持 blocked，等待明确维护后重新启动。

空目录的内部 `initialize` 必须明确传 `createSchemaVersion:3` 或 `4`。引擎为全新空目录明确选择 Schema3；不会因为部署新版而自动启用 Browser 候选格式。维护 CLI 也支持明确创建空目录：

```powershell
node core/src/acceptance/catalog-maintenance-cli.mjs --create --target-schema 4 --root 'D:\HeimdallData\acceptance'
```

已有 head、缺失 head 但存在恢复材料时均不能用此命令覆盖。`--root` 直接指向 acceptance 目录；省略时使用应用配置的 acceptance 根。动作参数必须在第一位，未知或重复参数在获取 owner 前拒绝。

## 预览与应用

先停止使用同一数据根的引擎。维护 CLI 获取真实 owner，活动引擎持锁时拒绝维护；它不强抢锁，也不启动恢复、worker 或浏览器。以下命令在仓库根运行：

```powershell
$acceptanceRoot = 'D:\HeimdallData\acceptance'
$previewText = node core/src/acceptance/catalog-maintenance-cli.mjs --preview --target-schema 4 --root $acceptanceRoot
if ($LASTEXITCODE -ne 0) { throw '目录迁移预览失败；请保留现场并检查诊断。' }
$preview = $previewText | ConvertFrom-Json
$preview | ConvertTo-Json -Depth 30
```

预览只读取目录元数据，不读取 `ac-*` 来源、派发记录、PNG 或报告，不生成迁移准备文件。结果包含当前 head / previous 原字节 SHA、generation / revision、逐步迁移、前像预算、容量和 `planDigest`，不返回完整项目 URL 或来源内容。CLI 获取和释放 owner 会改变根目录 stat，不能把“预览零写”解释为根目录属性完全不变。

检查预览后，用该次预览的全部身份应用：

```powershell
$previousSha = if ($null -eq $preview.source.previousSha256) { 'none' } else { $preview.source.previousSha256 }
node core/src/acceptance/catalog-maintenance-cli.mjs --apply --target-schema 4 --root $acceptanceRoot `
  --expected-generation-id $preview.source.generationId `
  --expected-revision $preview.source.revision `
  --expected-head-sha256 $preview.source.headSha256 `
  --expected-previous-sha256 $previousSha `
  --expected-plan-digest $preview.planDigest
if ($LASTEXITCODE -ne 0) { throw '迁移未确认完成；请保留现场，重新预览当前目录。' }
```

CLI 的成功 stdout 是 JSON，错误写入 stderr；apply 只返回安全目录身份与 `completedSteps` 数组，不返回整份 catalog。head、previous、目录版本、计划或前像清单变化会拒绝旧确认。重复旧确认不会再次迁移；对已是 Schema4 的新预览可以明确应用零步计划。

## 迁移与恢复边界

Schema1 依次经过 `1→2→3→4`，Schema2 经过 `2→3→4`，Schema3 只经过 `3→4`。每步独立追加一条迁移实体与事件、增加一次 revision、切换一次 generation。原 Spec / Browser 实体、摘要、事件前缀和当前 Spec 选用 ID 保持原值。完整链的事件、迁移、JSON、前像与根条目预算都在任何准备文件写入前检查。

原始前像按实际版本保存为 `catalog.v1.<sha256>.json`、`catalog.v2.<sha256>.json` 或 `catalog.v3.<sha256>.json`，每个版本最多两份。只复用原字节完全相同的安全常规文件，拒绝链接、文件名与内容版本不符、摘要不符和坏 JSON。根目录最多 4096 条目；预览预算包括全部新前像、缺失的 rolling previous 及发布时的一份临时文件，并绑定维护期间的当前条目数。

每步先排他保存前像，再写 `catalog.previous.json`，最后原子替换 head。head 是本步提交点；这不是跨文件原子事务或断电事务。I/O 中断后可能已完成前几步，或留下尚未提交的本步前像 / previous。保留这些原件，重新预览并使用新的确认续迁；普通启动不会续迁，也不清除现场。不要把上次命令失败等同于目录仍是最初版本。

安全检查覆盖真实 owner、已固定的根身份、有界 FD 读取、前后 stat、EOF 和原字节围栏。它依赖合作进程的单写者约束；不能宣称对任意外部进程提供文件系统隔离或跨文件快照。

## Browser 候选格式

Schema4 新增 `browserCandidates` 表、`bc-*` 身份与 `browser-candidate-created` 事件，迁移后为空。严格实体引用已有项目、版本与 `ax-*` 来源归属，每个来源归属最多一个 Browser 候选；Spec 的 `ab-*` 候选、批准、选用和托管派发语义保持原合同。

旧 `sourceContentDigest` 算法冻结。新增 `organizationContextDigest` 绑定完整 project / release / sourceBinding 值；新的域分离 `contentDigest` 绑定合同版本、模式、项目、版本、来源归属与两个摘要，不含候选 ID、创建时间、actor 或目录 generation / revision。目录格式能验证实体与历史自洽，不能替代重新读取来源证据。

默认最多 1024 个 Browser 候选，每个实体最多 8192 字节；最多三步迁移。旧 Schema1 / 2 / 3 保留各自字段与事件白名单，不接受通过旧格式偷塞 Browser 候选或把 Browser 候选送入 Spec 批准链。

## 验证入口

```powershell
node --test core/test/acceptance-catalog-schema-v4.test.mjs core/test/acceptance-browser-organized-candidate-identity.test.mjs
node --test core/test/acceptance-catalog-migration.test.mjs core/test/acceptance-catalog-schema3-migration.test.mjs core/test/acceptance-catalog-maintenance-cli.test.mjs
pnpm acceptance:catalog:migration:smoke
pnpm acceptance:browser:bindings:v4:smoke
```

迁移 smoke 使用旧 B1 和完整 Spec V2 原件副本，通过真实 CLI、引擎和浏览器验证显式升级。Browser Schema4 smoke 先新采集真实 Browser 来源与原生归属操作，再明确建立 Spec 草稿、批准 / 取消 / 重选和派发生命周期夹具，检查混合历史迁移及旧来源重核验。生命周期夹具不调用 Spec executor，迁移也不发目标请求；它们不能作为 Browser 托管执行已完成的证明。

实际门禁、保留的失败尝试、容量问题修复与证据边界见 [Schema4 实施验收](../audits/2026-10-17/acceptance-catalog-schema4.md)。
