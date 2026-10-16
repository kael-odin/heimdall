# 托管 Spec：固定身份与受控报告存储

日期：2026-10-17。范围：B2.2-b 的内部存储切片。继续保持 `executionReady:false`；本次没有提供托管 HTTP 执行、历史 prepared 自动消费、worker、恢复或控制台启动入口。

## 已实现的行为

`managed-run-store.mjs` 提供独立的 create / progress / finish / settle。每次调用用 `{operationId,dispatchSha256}` 绑定磁盘原始准备记录，只从实际取得的 owner 对象读取数据根；不接受 root、runId、taskId、计划、目标 URL 或批准状态覆盖。克隆、代理及只有同名方法的对象不能获得 owner 写能力。

新建运行只使用准备记录中的固定 runId / taskId。固定目录已经存在时，即使为空、仅有残留或含相同文件，也拒绝复用，不更换随机身份、不修复 partial。manifest 固定来源、项目、批准、独立选用与目标版本，初始状态为 `running + blocked`。原需求草稿的批准事实与本次计划的批准事实分别保存。

进度只接受实际 runner 的四种事件投影，不能作为任意 patch。取消后可用 settle 写入 `interrupted` 或 `failed`，仍需有效 owner、目录身份及原 sidecar；它不调用已经取消的 active 断言。所有终态拒绝再次 finish、settle 或更新进度。

finish 接收真实 Spec runner 的完整、严格有界 JSON 合同。BUG 保持 `completed + failed`，普通请求 timeout 或预算受阻保持 `completed + blocked`；执行失败或取消用单独的终态收尾，不构造通过报告。

## 报告、证据与提交点

所有引用证据先通过有界描述符读取、regular file、非链接、单硬链接、长度、文件身份和重复字节检查。文件角色与固定计划逐项绑定：contract、OpenAPI source、request 必须符合计划；response 的 runner 摘要投影必须与 raw.actual 一致，记录的 mismatch / evaluationLimited 与 status / verdict 必须一致。这里不重新运行 HTTP 或 schema 判定器，避免存储层成为另一套业务真值。

报告由存储层注入 managed 来源、taskId、计划摘要、当前十份 verifier 源码摘要和证据索引，再沿用原 summary / gate 算法。当前 verifier 与历史来源 verifier 分开保存，十源拼接和旧计划摘要算法均保持原定义。

先排他发布 `report.json`，再以原 running manifest 的字节和文件身份作条件替换。**completed manifest 是完成提交点。** 报告已发布而终态提交失败时保留 running 和原报告；再次 finish 或进度更新拒绝补完，只允许之后按有效 owner 写中断终态。Markdown 留待消费者从通过核验的 JSON 生成，此切片不独立落盘 report.md。

文件发布使用排他 temporary、完整写入、fsync、独立只读 anchor 和条件发布；首次发布使用 link，替换使用 rename。Windows busy 重试每次重新校验预期目标与本次临时文件、owner / active / 目录 / 准备记录及全部业务事实，不删除 destination 来模拟替换。失败不删除正式文件；若可能已经提交，错误明确携带 `writeMayHaveCommitted`，只能按固定身份对账。

完整 namespace 和证据核验在批次边界及每次发布尝试执行。每个证据读取只检查 owner / active / 目录，文件步骤只复读对应 sidecar，不按每个证据或每次临时文件 write 扫描全部 namespace。同步读取仍有明确上限，最大预算下的延迟需实测后再开放大规模执行。

## 验证

[证据索引](evidence/acceptance-managed-store/README.md)和[逐文件字节摘要](evidence/acceptance-managed-store/index.json)记录实际产物；[源码固定值](evidence/acceptance-managed-store/source-pins.json)固定本轮实现和测试。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| Windows Core 全量 | 1586 total / 1583 pass / 0 fail / 3 skip；212150.6893 ms。跳过为 2 项 Docker 条件及 1 项 FIFO 平台条件 | [完整日志](evidence/acceptance-managed-store/core-full.log) |
| 文件发布故障 | 40 项：Windows 39 pass / 1 FIFO skip；Linux 39 pass / 1 Windows 原生占用 skip | [Windows](evidence/acceptance-managed-store/managed-run-files-windows.tap)、[Linux](evidence/acceptance-managed-store/managed-run-files-linux.tap) |
| 独立存储故障 | 两平台各 3/3：进度期间出现 partial report、冻结元数据后同长度证据改写、报告已发布后阻止 terminal 提交 | [Windows](evidence/acceptance-managed-store/managed-run-store-edges-windows.tap)、[Linux](evidence/acceptance-managed-store/managed-run-store-edges-linux.tap) |
| Linux 集中回归 | 58/58、0 skip；原生 Linux Node v22.23.3。源码读取位于 WSL 9p，fixture 临时根实际位于 ext4，不把源码树称为 ext4 | [环境及 SHA](evidence/acceptance-managed-store/linux-integration/summary.json)、[完整日志](evidence/acceptance-managed-store/linux-integration/focused-tests.tap) |
| 本地真实 HTTP + 内部 writer | 创建前 / 创建时 0 请求；明确调用 runner 后 2 请求，1 BUG、completed + failed；部分报告保留 running，再按有效 owner 写 interrupted，原报告 bytes 不变 | [摘要与原始报告](evidence/acceptance-managed-store/managed-http/summary.json) |
| 假通过反例 | 原 BUG 只改 status / verdict 被拒绝；manifest 原 bytes 不变、report 不存在。坏响应 JSON 与错误文件角色同样拒绝 | [独立前后探针](evidence/acceptance-managed-store/managed-evidence-schema-20261017/writer-review-probes.json)、全量日志中的 store 用例 |
| 旧准备合同 | 25/25；14 份来源文件原 bytes 不变；0 target / fetch / new run | [准备质量门](evidence/acceptance-managed-store/managed-preparation/quality-gates.json) |
| 现有控制台回归 | 普通 Spec 17/17，pageErrors=[]，390px document=390；CDP 镜像任务 done、clone 200、pageErrors=[] | [Spec](evidence/acceptance-managed-store/spec-console/browser-checks.json)、[CDP](evidence/acceptance-managed-store/cdp/cdp-real-forge.json) |
| 常规门 | lint 364 files、console build、forge smoke 与文档链接检查均通过 | [lint](evidence/acceptance-managed-store/lint.log)、[build](evidence/acceptance-managed-store/console-build.log)、[smoke](evidence/acceptance-managed-store/forge-smoke.log)、[链接检查](evidence/acceptance-managed-store/docs-links.log) |

十源 verifier 精确值仍为 `e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8`，未修改旧算法或十份源码。原始来源与旧派发证据没有迁移或重写。

上一主分支提交 `13128a9aa10e3f0bc086684afd64006213f47f27` 的自身 CI `38938465905` 已完成且全部成功，包含真实控制台脚本和 Linux Docker 离线交付。[终态](evidence/acceptance-managed-store/parent-ci-13128a9.json)及[日志](evidence/acceptance-managed-store/parent-ci-13128a9.log)随本次归档；不能把父提交的 CI 作为本次新提交的 CI 结果。

## 保留的边界

- 这些内部写能力不证明 fresh admission，也不允许从旧 prepared 自动开始执行。统一启动队列、槽位、取消 / watchdog / shutdown、task mirror 和 owned recovery 仍需下一层接入。
- 普通 CLI、snapshot、artifact、candidate 和 triage 继续显式拒绝 managed / reserved 身份；本次没有悄悄使未迁移入口可用。
- path fence 与 rename 不是操作系统原子 inode CAS，依赖实际 owner 的单写者约束；最后检查与系统调用之间仍有外部写者竞态。expected token 不长期持有原目标 FD，stat / birthtime / 原字节不能证明抵抗敌对 inode ABA。
- fsync 文件不等于跨文件或目录断电事务。runner 已开始的异步证据写入仍可能在控制失效后结束；此时不能形成完整完成事实。
- SHA 与证据交叉校验可以发现不一致，不能证明所有 raw、证据及准备记录被协同伪造后的 HTTP 真实性。响应正文原始 bytes 没有单独保留，不用 JSON 重序列化假装核验原始 bodySha256。
- 本轮真实 HTTP 和浏览器证据来自受控本地夹具，不代表真实授权业务系统、认证或写操作已经验收。
