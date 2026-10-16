# 项目、版本与历史验收归属

项目验收工作台中的“项目与版本”将独立验收记录组织到明确的开发项目和版本。一个项目可以登记多个不可变版本，再将已经结束的运行逐一归属。查看原始报告和[显式运行对复验](acceptance-comparison.md)继续使用原运行 ID。

这是本地项目目录。版本中的 URL 和 buildRef 是操作者声明，不能证明部署内容在以后保持相同。运行归属也不表示该版本已经通过验收；失败、受阻和旧记录的原始门禁继续保留。[Spec 需求基线](acceptance-baseline.md)在明确归属后提供完整候选预览、人工批准与独立选用；托管执行和持久 BUG 关闭仍待实现。

## 控制台流程

1. 打开“项目验收”，展开“项目与版本”，创建或选择项目。
2. 登记版本名称、完整目标 URL 和可选 buildRef。需要改变地址或 buildRef 时创建另一个版本；原版本没有编辑或删除入口。
3. 选择本项目版本和已经结束的历史运行，核对后明确提交后续归属。目标 URL 必须经同一规则规范化后完整匹配，包含路径和查询参数。
4. 在归属记录中打开原报告，或到“两次运行复验”显式选择 before / after。目录不会自动挑选“最新通过”作为依据。

单个运行只归属一次。归属写入目录引用，不回填原 manifest，不修改报告、计划、门禁或证据。不在历史列表前 100 条的运行仍可通过完整 ID 由 API 明确认领；列表不是存在性的判断依据。来源后来缺失时保留关系并显示诊断。

两个窗口可能同时修改同一目录。页面发送读取时的 generationId 和 revision；只有仍匹配的一次写入能够成功。遇到冲突时保留表单，刷新并核对已有记录后再明确提交。网络错误也可能发生在服务器已经提交之后，应先重新读取目录，不能自动重发写请求。

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

目录位于 `HEIMDALL_DATA_DIR` 派生的 acceptance 根。运行目录保持原位。引擎启动先取得真实路径上的独占所有权，再恢复未完成运行；同一数据根的第二个引擎或 junction / symlink 别名不能进入恢复。

所有者保存本机 hostname、PID 和随机 nonce。仅当同一主机的 PID 被系统明确报告不存在时，才在独立恢复互斥区重读并核对原锁，再尝试接管。无法确认、权限拒绝、PID 复用、不同主机、损坏锁或遗留恢复锁均保守失败。不会按锁年龄自动接管。正常退出只释放仍属于本进程的锁。

owner 内的目录写入按队列顺序执行，覆盖 read → validate → revision 检查 → 修改 → 前像核对 → 原子替换。原子替换失败保留原目录，不把 rename 本身称为跨文件事务或完整断电耐久。本阶段不提供从备份恢复目录、改绑或删除接口；正常重启不改变 generationId。

## 目录格式升级

当前活动目录使用 schemaVersion 2。它保留原项目、版本、运行归属和事件格式；candidates、approvals、selections 按[需求基线合同](acceptance-baseline.md)严格验证 Spec 候选、批准与选用历史。最初 B2.0 版本仅允许这些集合为空，不能回写已包含新历史的目录。

旧 schemaVersion 1 目录在单个引擎取得所有权后，由 initialize 队列执行一次升级。升级保留全部旧实体与旧事件内容，追加一条全局迁移记录，将 revision 从 R 推进为 R+1，并生成新的 generationId。迁移事件没有 projectId，不计作项目的用户操作。旧页面持有的 generationId 失效，需要刷新目录。

迁移前严格检查活动目录和 rolling previous：同格式备份必须与活动目录同 generation，且是完整事件及不可变实体的历史前缀或相同快照。不会仅凭 revision 较小接受无关备份。schema1 活动目录搭配 schema2 备份属于谱系不明，升级失败并保留原件。

升级前原始 head 和原始 previous 按 SHA-256 去重，排他保存为 `catalog.v1.<sha256>.json`，最多两份。相同名字仅在已有字节完全相同时复用；容量、未知格式、坏备份、路径别名或归档失败都会阻止提交。归档使用同目录完整临时文件和排他硬链接发布；文件系统不支持该操作时升级失败，不覆盖旧文件。

之后先将原 schema1 head 写入 `catalog.previous.json`，再原子提交 schema2 head；head 是唯一语义提交点。每次写入前重新检查 owner、根身份和已读取字节。最后一步失败时 previous 可能已推进，但活动 head 仍为 schema1，已保存的前像保留；再次启动可按当前有效原件重新尝试。升级失败期间目录读写返回不可用，不回退到旧格式继续写入。

迁移后第一次正常写入，只有 rolling previous 的原字节摘要、generation 和 revision 精确匹配迁移记录所记 head 前像时，才接受 schema2 head + schema1 previous 的组合。该次写入再将 previous 推进为 schema2。正常重启不重复迁移；原验收运行、报告、计划、门禁和证据均保持原位。前像文件保留用于调查，本阶段没有自动恢复或自动删除入口。旧二进制不能写入 schema2 活动目录。

这些保护针对协作进程和意外失败，不能阻止管理员手工改磁盘。独立 CLI 仍产生独立验收记录；目录操作只经拥有该数据根的引擎执行。不要在引擎管理同一目录期间从其他工具改写活动运行。

## 复现检查

```powershell
pnpm -C console build
pnpm acceptance:catalog:smoke
pnpm acceptance:catalog:migration:smoke
```

目录 smoke 使用隔离数据目录和本地只读 API 夹具，覆盖真实 worker、目录冲突、第二引擎与路径别名、重启、控制台及原始证据不变。迁移 smoke 使用上一版真实目录与运行证据的副本，检查格式升级、旧请求冲突、连续重启、浏览器报告和所有来源字节不变。构建完成后再运行读取构建产物的浏览器检查。结果和实际边界见[目录实施验收记录](../audits/2026-10-16/acceptance-catalog.md)及[格式升级验收记录](../audits/2026-10-16/acceptance-catalog-migration.md)。
