# Spec 执行控制与操作核对

日期：2026-10-16 开始，2026-10-17 完成当前切片。范围：B2.2-b 的执行控制基础。本批为私有 Spec runner 增加停止信号和同步 active 校验，并为已接受准备增加物理只读核对。它尚未把准备记录接入托管 HTTP、运行创建、provenance、恢复或控制台按钮；[准备合同](../../competition/acceptance-managed-spec.md)仍为 `executionReady:false`。

## 实现与行为

`runSpecAcceptance` 增加可选 `signal` 与同步 `assertActive`。首次控制失效固定为本次运行的控制错误，停止心跳并中止当前请求；该错误从 HTTP 检查逻辑穿透，不能被当作一次普通 timeout 后继续下一条。未提供新 options 的调用保持原计划、预算、检查身份、HTTP / MIME / JSON / schema 判定、证据名称和报告结构。

目录、证据和事件的副作用前，以及 await 返回后的下一项副作用前均重新检查。外部停止会打断 fetch、流读取与事件回调的等待；仍 active 时保留事件背压。迟到拒绝被消费，资源清理不因控制失效被阻止。心跳最多保留一个待结束回调，并在后续 tick 继续检查 owner；失效后不继续触碰进度。内部请求超时在外部仍 active 时保持原 blocked / environment 语义。

新增私有 `catalog.readManagedSpecDispatch(projectId,input)`，仅接收与准备相同的完整原确认，返回原 record 或 null。项目与全部原确认字段绑定同一指纹；旧 CAS、取消后的 selection、当前来源或 catalog 缺失均不改变已接受操作。请求指纹不一致、损坏或 owner 失效拒绝，不能按不存在处理。null 只表示本次观察未见记录，不预留运行槽，也不能取代启动队列内的再次核对。

runner 变化会产生新的实际 verifierFingerprint。既有 LF / CRLF 两个精确值保留，新源码经兼容审查后显式增加精确 LF / CRLF 值；没有运行时自动信任，也不改旧报告摘要。允许来源投影读取这些已审实现，不表示不同 verifier 的 before / after 可直接判定 BUG 已修复，跨运行比较继续遵循原身份规则。

查询不创建 sidecar 目录。首次缺失通过 lstat 确认，已经观察到的 root / parent 身份在同一 store 生命周期内保留，即使版本目录尚不存在也不能替换后继续。首次 lstat 之后的解析错误不是安全缺失。普通目录 API 没有获得调用私有核对或准备的方法。

## 审查发现与修复

- onEvent 同时取消并抛错时，普通 callback 错误原先可覆盖取消；外层 catch 再检查 sticky 控制错误后固定中止原因。
- started / completed 事件 callback 永久 pending 时，直接 await 原先阻止取消收尾；现在用受控制的等待保留正常背压，并允许取消及时退出。
- 查询看到 parent 存在但 v1 缺失后，原探测实现没有持久固定 parent；替换目录可在下一调用被接受。现在固定部分祖先，查询和 initialize 都拒绝替换。

上一提交 `a45c8ae` 的 CI run `38925385944` 为 failure，两项失败在本批处理。其余未执行步骤不能借上一阶段的绿色结果补记为通过。

- 临时文件清理仅比较 dev / ino，关闭全部句柄后 Linux 可立刻把同一 inode 分配给替换文件。WSL / ext4 的原代码探针实际观察到 `ino=77231 → 77231`，随后替换文件被清理而报 ENOENT。现在在写句柄关闭之前取得并核验独立只读句柄，保持原 inode 到条件清理后再关闭。修后同一探针观察到 `77231 → 77232`，替换文件保留；写入、fsync 与写句柄关闭失败仍禁止发布。
- 已观察到派发记录后，realpath 的 ENOENT 原先也能被当作未接受操作。现在只允许最初 lstat 的 ENOENT 返回 null，之后的解析失败保持 unavailable。隔离子进程回归锁定该行为。
- Browser 的三色动态夹具每 33ms 换色，99ms 回到同色，与两次截图的时间间隔可能碰撞。复用原夹具回调的真实浏览器复现中，推进三个 tick 得 stability=1，推进一个 tick 得约 0.736。测试现在在真实截图前明确控制相位，仍验证原 0.9995 稳定门拒绝异相位、mask 允许比较，并增加同相位样本通过的边界回归。生产 runner 和阈值未修改；两次采样相同不证明整个时间段稳定。

## 验证与证据

[证据索引](evidence/acceptance-spec-execution-control/README.md)保留最终原始输出、源码与证据摘要、原提交 CI 终态、修前 / 修后故障注入和真实浏览器产物。下列数字从最终日志与 JSON 核对；代码在统一回归前冻结。

| 检查 | 最终本机结果 |
| --- | --- |
| 全量 core | 1407 项：1405 pass、0 fail、2 Docker skip；249408.229 ms |
| 执行控制、Spec / OpenAPI、准备 / 来源 / 基线扩大专项 | 244 / 244 pass，0 fail、0 skip；21757.3715 ms |
| 语法 | 347 文件通过 |
| 准备与私有只读核对 smoke | 25 / 25；两 source / 14 原文件 bytes 和 SHA 不变，目标请求 0、fetch 尝试 0、新 run 0 |
| 临时文件发布修复 | Windows Node 25.2.1 与 Linux Node 22.21.1 / WSL ext4 各 30 / 30，0 fail、0 skip；原 Linux 误删探针修后通过 |
| 独立发布审查 | 11 / 11 相关专项，另 4 / 4 写入 / fsync / close 故障注入通过 |
| Browser 动态与原验收回归 | 9 / 9 通过，包含显式异相位、mask 和同相位抽样边界 |
| 普通 Spec 控制台 | 17 / 17 检查，pageErrors=[]；390px 视口 document=390，无横向溢出 |
| 原镜像 CDP | 真实控制台点击后 task done，镜像 200，pageErrors=[] |
| 其余本机门禁 | console build、core forge smoke 通过；Markdown 457 targets / 118 files |

独立兼容审查另有 174 / 174 项输出。新旧 runner 对照通过真实 HTTP 分别覆盖 healthy、业务 BUG、timeout、redirect 与 draft，除明确列出的三个时间字段外报告相同，事件序列和逐个证据 bytes 相同。10 个 verifier 源文件均 LF；新实际值为 `e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8`，全 CRLF 对应值为 `8d1b75da7efad4f18b279a466ebdf880b1e24bb641ca80070cd03d0700376e9f`，连同旧两值精确锁定。未知指纹仍拒绝；两个原 B2.1 source 的候选 contentDigest 保持原值。

准备 smoke 使用真实 owner 与本地监听目标，但没有启动引擎 / Browser / executor；其零请求不能替代托管执行验收。普通 Spec 与 CDP 浏览器结果来自另外两条已有流程。原始大日志、修前探针和临时数据保留在本机 ignored `core/workspace/_runs/`，本次归档文本采用 LF 并同时记录原文件摘要。

本机 Docker 两项仍按环境跳过；新提交推送后单独跟踪其 CI 终态。`a45c8ae` 的失败保留，不能借 `022f345` 的旧绿色结果或本机通过结果改写。

## 剩余边界

检测到控制失效后，不发起下一项请求、证据写入、事件或正常完成返回。已在有效检查下开始的异步磁盘 I/O 可能结束并留下部分证据；本批不撤回已经到达目标的请求，也不证明跨进程写盘 fence、目录断电事务或远端 exactly-once。

`assertActive` 是调用方提供的同步断言，失败时抛错；它自身不是 owner acquisition、持久 claim 或共享运行槽。本批没有给旧 `runAcceptance` Browser dispatcher 静默增加托管授权。下一切片仍需完成 owner 内执行器、manifest / report 不可变来源关系、统一启动队列、取消 / watchdog / shutdown 接线和只中断不重发的恢复，再做真实控制台闭环。
