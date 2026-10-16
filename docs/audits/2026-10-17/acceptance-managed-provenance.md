# 托管 Spec：来源关联与普通入口隔离

日期：2026-10-17。范围：B2.2-b 的只读来源关联与隔离切片。[准备合同](../../competition/acceptance-managed-spec.md)仍为 `executionReady:false`；本批没有新建托管 manifest、执行器或 HTTP 启动端点。

## 当前行为

新增只读 dispatch context，捕获有界派发清单、原始字节和保留的 run / task 身份。仅初次 lstat 的 ENOENT 可以表示尚未存在；已观察到的根或祖先身份变化、坏记录、链接、重复身份、未知条目和预算超限都会拒绝。临时文件计入预算并核验，但不会成为已接受操作，也不会被修复或提升。

每次 freshness 重新核对有界目录名集合，并复读全部已见文件字节。Linux / WSL 测试发现，快速同长度改写可能保留相同时间戳，因此不能只靠 metadata 判断内容未变。目录名核对另以固定 metadata 的故障注入覆盖新增正式文件、临时文件、未知文件和删除；这些模拟边界不冒称为全部在真实文件系统中复现。任何被观察到的变化会持续使本 context 失效，不刷新后继续混用事实。返回 envelope、Buffer 和引用数组均不允许修改私有原件。

纯 provenance / linkage 校验每次复制 record 原字节、重算 SHA-256、严格解码与验证 envelope，不信调用方提供的 `record.envelope`。manifest 和 report 必须关联同一 operation、dispatch、项目、批准、选用、来源版本、目标版本及保存计划。来源原批准事实与本次合同批准分开，来源 verifier 与本次报告 verifier 也分开。纯函数只核对报告 verifier 的合法形状，不声称已读取当前十份源码，也不据此判断运行完成或授予执行许可。

普通运行入口在规范化之前拒绝托管保留字段，防止字段被丢弃后误用。既有 manifest 或 report 的 own 托管标记（即使值为 null / false）会阻止普通读写、报告、AI 解读和候选来源读取；通过 dispatch 保留 runId 反查，删除全部标记也不能降级为普通运行。CLI 在进入原执行及错误写回之前拒绝。snapshot 仅返回 `report:null` 的完整性阻塞，不把原报告继续当作可信快照。

列表成功时保持数组；尚未迁移的托管项给安全的 blocked 摘要，坏派发命名空间则给明确完整性错误，不伪装空列表。引擎对已知隔离错误停止启动恢复写入，保留原件并继续提供项目目录读取；未知启动错误仍抛出。目录中的 manifest-only 组织元数据不等于来源资格，候选、批准与准备仍须经过来源读取校验。

## 验证

[证据索引](evidence/acceptance-managed-provenance/README.md)记录本批日志、源码指纹与上一提交 CI 终态。最终源码冻结后结果如下：

| 检查 | 结果 |
| --- | --- |
| core 全量 | 1508 项：1506 pass、0 fail、2 Docker skip；204292.9689 ms |
| 来源关联、reader、普通入口隔离及来源读取专项 | 165 / 165 pass |
| 普通目录兼容与隔离专项 | 35 / 35 pass，包含相对 root 与旧断言收紧 |
| reader 跨平台 | Windows 与 WSL / Linux Node 22 各 23 / 23 pass |
| 语法 | 353 文件通过 |
| 既有准备 smoke | 25 / 25，原 source 14 文件不变，目标请求 / fetch 尝试 / 新 run 均为 0 |
| 普通 Spec 真实控制台 | 17 / 17，pageErrors=[]；390px 视口无横向溢出 |
| 原镜像真实 CDP | task done、clone 200、pageErrors=[] |
| 其余门禁 | console build、forge smoke 通过；Markdown 463 targets / 120 files |

首轮全量保留为 1507 项、1 fail：旧目录回归期望损坏派发记录时仍 `eligible:true`。新规则无法安全排除保留身份，因此该预期已收紧为 `eligible:false`、`preview:null` 和安全来源完整性诊断；HTTP 目录仍为 200，原来源与目录字节不变。另由独立审查复现并修复相对 root 被误判损坏的兼容问题；只读 adapter 在边界 resolve，相对和绝对 root 可以共享正确 context。最终回归包含新增的相对 root 用例。

集成回归真实启动 CLI 子进程和引擎 HTTP，核对保留身份去标记、manifest-only / report-only 标记、准备但未启动、坏命名空间、普通历史运行兼容性、输入伪造与安全错误响应。拒绝前后比较原文件 SHA 和任务列表；CLI fetch spy 为零。普通 Spec 控制台与原镜像 CDP 属于既有可执行流程，不能替代托管执行验收。

独立真实 HTTP / 模型桩探针还覆盖 AI 等待期间的变化：请求前已有 managed 标记时返回 503、模型调用 0 次；等待期间加入标记后返回 503，已发模型调用 1 次，但没有写入 triage，manifest 原字节不变。归档保留该次实际源码、stdout 与调用来源，未冒称再次重跑。

上一提交 `c288c079c6c44d74570017438997d8cd9a0f43fa` 的 CI run `38932247644` 已于 2026-10-17 00:46（UTC+8）完成，三个 job 均 success，包含 Docker 离线交付。本批新提交仍须跟踪自己的 CI，不继承该结果。

## 成本和后续边界

每次 freshness 为有界 O(namespace entries + namespace bytes)，上限继承 dispatch limits。批次列表只捕获一个 context、生成私有 reserved Set，中间逐行查 Set，结尾复验；没有每行重读整个命名空间。直接反复调用 reader 的 public lookup 仍会反复付出完整 freshness 成本，不应把 context 缓存跨越异步等待或当作免校验授权。

本批没有跨文件原子快照、签名、远端 exactly-once 或断电事务保证。无 manifest 的历史准备记录仍为 prepared-unstarted。后续固定 ID 写入与正常完成发布必须受真实 owner 和 active fence 约束；之后接统一启动队列、当次新操作执行、取消 / watchdog / shutdown 与只中断不重发的恢复，再提供控制台闭环。
