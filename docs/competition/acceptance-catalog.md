# 项目、版本与历史验收归属

项目验收工作台中的“项目与版本”将独立验收记录组织到明确的开发项目和版本。一个项目可以登记多个不可变版本，再将已经结束的运行逐一归属。查看原始报告和[显式运行对复验](acceptance-comparison.md)继续使用原运行 ID。

这是本地项目目录。版本中的 URL 和 buildRef 是操作者声明，不能证明部署内容在以后保持相同。运行归属也不表示该版本已经通过验收；失败、受阻和旧记录的原始门禁继续保留。[Spec 需求基线](acceptance-baseline.md)在明确归属后提供完整候选预览、人工批准与独立选用；[托管 Spec 执行](acceptance-managed-spec.md)已接入专用 HTTP 和明确目标版本的工作台入口。[Browser 完整来源复核与持久候选](acceptance-browser-candidates.md)、[单次批准的固定来源执行](acceptance-browser-execution.md)和[固定成员人工缺陷单](acceptance-defect-tickets.md)已分别接入独立入口。Browser 全局批准与选用仍待建设；单次批准不代表全局选用，也不代表已通过验收。

## 控制台流程

1. 打开“项目验收”，展开“项目与版本”，创建或选择项目。
2. 登记版本名称、完整目标 URL 和可选 buildRef。需要改变地址或 buildRef 时创建另一个版本；原版本没有编辑或删除入口。
3. 选择本项目版本和已经结束的历史运行，核对后明确提交后续归属。目标 URL 必须经同一规则规范化后完整匹配，包含路径和查询参数。
4. 在归属记录中打开原报告，或到“两次运行复验”显式选择 before / after。目录不会自动挑选“最新通过”作为依据。

单个运行只归属一次。归属写入目录引用，不回填原 manifest，不修改报告、计划、门禁或证据。不在历史列表前 100 条的运行仍可通过完整 ID 由 API 明确认领；列表不是存在性的判断依据。来源后来缺失时保留关系并显示诊断。

两个窗口可能同时修改同一目录。页面发送读取时的 generationId 和 revision；只有仍匹配的一次写入能够成功。遇到冲突时保留表单，刷新并核对已有记录后再明确提交。网络错误也可能发生在服务器已经提交之后，应先重新读取目录，不能自动重发写请求。

目录请求默认以 60 秒覆盖响应头和完整 JSON 正文；不合作的读取或取消也不会永久占住界面。列表和详情是顺序的独立请求，各自有一个预算。已核验的写入确认会先显示，再刷新目录；刷新失败时保留“已提交、待核对”的事实并释放 busy，操作者需手动刷新。写入未取得完整确认时仍标为可能已提交，保留草稿并暂停新写，不自动重试。产品期限不代表原有 25 秒浏览器 smoke 的失败根因已经确定，历史结论见[精确 CI 记录](../audits/README.md)。

## API

沿用引擎 Token / 本地会话鉴权。JSON 响应使用 `Cache-Control: no-store`，写入接口只接受声明字段。

| 方法与路径 | 业务字段 | 作用 |
| --- | --- | --- |
| `GET /api/acceptance/projects` | 无 | 读取目录版本、项目与全局运行归属摘要 |
| `POST /api/acceptance/projects` | name | 创建项目 |
| `GET /api/acceptance/projects/:id` | 无 | 读取项目、版本、归属及事件 |
| `POST /api/acceptance/projects/:id/releases` | label、targetUrl、buildRef? | 登记不可变版本 |
| `POST /api/acceptance/projects/:id/run-bindings` | runId、releaseId | 明确归属终态历史运行 |

所有 POST 还要求 `expectedGenerationId` 和非负安全整数 `expectedRevision`。ID 由服务端生成，不接受本地文件路径。失败写入不推进 revision、不新增成功事件；成功语义写入只推进一次。

| 状态 | 含义 |
| --- | --- |
| 400 `INVALID_INPUT` | ID、字段、URL、目录版本或类型无效 |
| 401 | 没有有效引擎授权 |
| 404 `NOT_FOUND` | 引用的项目、版本或运行不存在 |
| 409 `STALE_REVISION` | generationId 或 revision 与当前目录不匹配 |
| 409 `PROJECT_MISMATCH` | 所选版本不属于项目，或完整目标 URL 不匹配 |
| 409 `CONTEXT_ALREADY_BOUND` | 运行已有归属，不能重绑 |
| 409 `SOURCE_NOT_ELIGIBLE` | 来源仍在执行或记录形状不适合归属 |
| 409 `SOURCE_INTEGRITY_FAILED` | 来源 manifest 损坏、身份不符或超过读取预算 |
| 409 `CATALOG_CAPACITY` | 目录达到条目数或字节上限，历史不自动裁剪 |
| 503 `CATALOG_UNAVAILABLE` | 目录损坏、版本未知、路径不安全或无法完成持久化 |
| 503 `ACCEPTANCE_OWNER_UNAVAILABLE` / `ACCEPTANCE_OWNER_LOST` | 无法取得或已经失去验收目录所有权 |

归属只核对运行 manifest 的有界内容和身份，不补造旧记录的报告摘要。完整性诊断与组织关系分开；要判断修复是否可靠仍须显式复验并重新验证来源字节。

## 所有权、持久化与恢复

目录位于 `HEIMDALL_DATA_DIR` 派生的 acceptance 根。运行目录保持原位。引擎启动先取得真实路径上的独占所有权并打开目录，再预检和收束未完成运行；旧格式或未知版本无法打开时跳过恢复写入，保留原运行现场；同一数据根的第二个引擎或 junction / symlink 别名不能进入恢复。

所有者保存本机 hostname、PID 和随机 nonce。仅当同一主机的 PID 被系统明确报告不存在时，才在独立恢复互斥区重读并核对原锁，再尝试接管。无法确认、权限拒绝、PID 复用、不同主机、损坏锁或遗留恢复锁均保守失败。不会按锁年龄自动接管。正常退出只释放仍属于本进程的锁。

owner 内的目录写入按队列顺序执行，覆盖 read → validate → revision 检查 → 修改 → 前像核对 → 原子替换。原子替换失败保留原目录，不把 rename 本身称为跨文件事务或完整断电耐久。本阶段不提供从备份恢复目录、改绑或删除接口；正常重启不改变 generationId。

## 目录格式与显式维护

当前支持打开并验证 Schema3 / Schema4；引擎为全新空目录明确创建 Schema3。Schema3 的 `browserSourceBindings` 按[来源侧归属合同](acceptance-browser-bindings.md)验证 Browser 来源关系，Schema4 再增加独立 `browserCandidates` 表与严格历史格式。Spec 的 candidates、approvals、selections 继续遵循[需求基线合同](acceptance-baseline.md)，迁移不扩展 Spec 的批准、选用或托管执行语义。

现行操作见 [Schema4 与显式维护](acceptance-catalog-schema4.md)。旧 Schema1 / Schema2 普通启动返回 `MIGRATION_REQUIRED`，不会静默升级；未知版本拒绝打开并保留原件。先停止使用同一数据根的引擎，再用维护 CLI 的 `--preview --target-schema 4` 检查计划，核对后以全部身份执行 `--apply`。活动 owner 持锁时维护拒绝；CLI 不启动引擎恢复或 worker。D1 的本机完整 Core、旧数据真实迁移和 Browser 混合历史检查均通过，证据与自身 CI 待核验边界见[实施验收](../audits/README.md)。

Schema1 依次经过 `1→2→3→4`，Schema2 经过 `2→3→4`，Schema3 经过 `3→4`。每步保留旧实体和事件前缀、追加迁移实体与全局事件、增加一次 revision 并切换 generation，旧页面 CAS 因此失效。迁移不会生成 Browser 来源、候选或执行授权，已有 Schema4 的新预览可确认零步计划。

迁移前严格检查活动目录和 rolling previous：同格式备份必须同 generation，且是完整事件及不可变实体的历史前缀或相同快照；相邻格式必须以对应迁移的原字节摘要、generation、revision 和完整历史前缀桥接。逆向版本、跳步或分叉历史均拒绝并保留原件。

原始 head 和 previous 按实际 schema 与原字节 SHA-256 排他保存为 `catalog.v1.<sha256>.json`、`catalog.v2.<sha256>.json` 或 `catalog.v3.<sha256>.json`，每种版本最多两份。相同名字仅复用原字节完全相同的安全常规文件；版本、SHA 或路径异常均拒绝。完整链的事件、迁移、JSON、前像及根条目预算在任何准备文件写入前检查。

每步先保存前像，再写 rolling previous，最后原子替换 head；head 是本步语义提交点，不能当作跨文件或断电事务。中断后可能已提交前几步，或留下当前步的前像 / previous；保留现场，重新预览并以新确认续迁。普通启动不续迁，也不清除现场。head / previous 原字节或计划变化时，旧确认被拒绝。

这些保护依赖真实 owner、根身份、有界读取与原字节围栏，面向协作进程和意外失败。正常目录写入经拥有该根的引擎执行，显式维护则必须停用同根引擎后由独立 owner 执行；普通验收 CLI 仍产生独立运行记录。不要在引擎管理同一目录期间从其他工具改写活动运行。

## 复现检查

```powershell
pnpm -C console build
pnpm acceptance:catalog:smoke
pnpm acceptance:catalog:migration:smoke
```

目录 smoke 使用隔离数据目录和本地只读 API 夹具，覆盖真实 worker、目录冲突、第二引擎与路径别名、重启、控制台及原始证据不变。迁移 smoke 使用上一版真实目录与运行证据的副本，检查格式升级、旧请求冲突、连续重启、浏览器报告和所有来源字节不变。构建完成后再运行读取构建产物的浏览器检查。当前迁移命令已使用显式 Schema4 维护；本轮实际结果见[Schema4 实施验收](../audits/README.md)，历史结果和当时边界见[目录实施验收记录](../audits/README.md)及[格式升级验收记录](../audits/README.md)。
