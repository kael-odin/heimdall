# 验收目录 Schema3：保留历史的分步迁移

本文记录 Schema3 迁移切片：它为明确的 Browser 来源归属预留独立 `browserSourceBindings` 表，发布时该表严格为空，先解决持久化格式与现有 Spec 历史的兼容问题。后续[来源侧归属](acceptance-browser-bindings.md)已为该表增加严格实体和内部 store 操作；HTTP / UI、Browser 批准、选用与执行仍未接入。

新建目录使用 Schema3、独立 generation、revision 0 和空迁移历史。已有 Schema2 在真实 owner 内迁移一次；Schema1 依次经过原有 `1→2` 和新增 `2→3`，每步独立提交、各换一次 generation、各追加一个迁移实体和全局事件，revision 每步增加 1。旧 CAS 因 generation 变化失效。迁移不会重新批准或选用，也不会重写旧事件与实体摘要。

## 严格格式与历史

`validateAcceptanceCatalogV1` 和 `validateAcceptanceCatalogV2` 保留旧格式的独立白名单和语义。新增 `validateAcceptanceCatalogV3`；通用 validator 按实际版本分派。原 `buildCatalogMigration` 仍只构造 `1→2`，新增 `buildCatalogMigrationV3` 只接受严格 Schema2 并构造 `2→3`。二者均为无文件系统的纯函数。

Schema3 允许新建空迁移历史、原生 Schema2 的单条 `2→3`，或有序 `1→2→3`。迁移 transition 和来源 generation 不得重复，当前 generation 不得复用前代。原 `1→2` 不能出现在 Spec 专属历史之后；`2→3` 可以发生在完整候选、批准、选用、取消和重选之后。旧 Spec 实体、内容 digest、事件顺序和当前选用 ID 保持原值。

默认迁移容量为 2，Browser 来源表容量为 4096；Schema2 仍最多一条 `1→2`。迁移切片发布时拒绝非空 Browser 表和事件；后续来源归属切片加入明确实体 / 事件验证，未知字段与 accessor / Proxy 继续拒绝。现有 Spec 候选和选用链保持原合同。

## 原始前像与提交

升级前将实际 Schema1 字节排他保存为 `catalog.v1.<sha256>.json`，实际 Schema2 字节保存为 `catalog.v2.<sha256>.json`，每种版本最多两份。名字中的版本来自原件本身，不把仍为 Schema1 的 previous 标为 V2。已存在前像必须是安全 regular file、通过自己的严格 schema，且实际版本和原字节 SHA 均与文件名一致；同名仅复用完全相同字节。

每一步继续使用现有 owner、根身份、双文件字节 CAS、排他归档和原子 head 提交：先保存前像，再将当前 head 写入 rolling previous，最后提交新 head。head 是本步语义提交点。第二步失败后可能保留有效 Schema2、已发布前像或前移的 previous；这些现场不清除，新 initializer 按当前有效原件继续 `2→3`，不会重放已提交的 `1→2`。

`sourcePreviousSha256` 记录本次尝试开始时实际 rolling previous 的原字节。若上次第二步 head 失败而 previous 已前移到 V2，重试记录的 previous hash 可以是该 V2 字节；它不是初次尝试的永久 previous hash。

同版本 predecessor 必须同 generation、拥有完整旧事件 / 实体前缀，并保持同一迁移集合。相邻版本仅允许 `2/1` 或 `3/2`，必须通过对应迁移的 fromGeneration、fromRevision、sourceHeadSha256 与原字节历史前缀桥接。`3/1`、逆向版本、分叉历史、实体内容变化和字节格式变化不能冒充同一前像。

最新 Schema3 初始化也核对 predecessor。合法 head 的诊断读取仍可保留，不能据此宣称备份谱系、来源证据或写入 readiness 已成立。缺失 head 却存在 recovery material 时仍拒绝新建空目录；本片没有自动恢复、历史删除或降级写入入口。旧版本引擎不能写入 Schema3。

## 验证与下一步

```powershell
node --test core/test/acceptance-catalog-schema.test.mjs core/test/acceptance-catalog-schema-v3.test.mjs
node --test core/test/acceptance-catalog-migration.test.mjs core/test/acceptance-catalog-schema3-migration.test.mjs
pnpm acceptance:catalog:migration:smoke
```

迁移 smoke 使用两组已提交的真实数据副本：旧 B1 的 3 个运行 / 18 文件验证 `1→2→3`、两次重启、原失败报告和桌面 / 手机布局；原生 V2 的 2 候选 / 5 批准 / 7 选用与取消历史验证 `2→3`、完整历史、当前选用和重启。源目录继续只读，读取和浏览不启动新 worker，不访问旧目标。实际结果见[实施验收记录](../audits/2026-10-17/acceptance-catalog-schema3.md)。

后续[来源侧归属](acceptance-browser-bindings.md)已定义严格 Browser 实体、全局唯一 `(runId, side)`、双向 target 归属约束，以及写入前和 head 提交前的完整来源重建。独立 HTTP 与显式工作台操作继续后续接入；迁移本身不会生成 Browser 归属或授权。
