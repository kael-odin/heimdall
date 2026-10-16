# 托管 Spec 真实执行：新确认、统一运行槽与可核验结果

日期：2026-10-17。该切片把已选 Spec 需求与明确目标版本接入真实引擎执行：目录草稿 → 来源绑定 → 候选 → 批准 → 选用 → 本次新确认 → runner → 严格 writer → 状态与下载。执行使用真实 owner、固定 dispatch / run / task 身份；原来源草稿仍未批准，原报告与门禁不改。

专用 HTTP 合同与请求示例见[托管 Spec 指南](../../competition/acceptance-managed-spec.md)。现有控制台可以观察运行、BUG、证据、下载和中断；明确目标版本的执行按钮继续后续切片。候选、批准、选用不自动执行，相关响应仍为 `executionReady:false`。

## 行为与关键约束

新增 `execution-runtime.mjs`、`execution-service.mjs`、`execution-api.mjs` 与 `managed-executor.mjs`。普通验收与托管验收共享一个 opaque lease 运行槽。完整同键确认的读取先于 busy 检查；首次 await 前预留槽，同进程同键合并。目录队列首行、准备前和发布前重复检查同一许可。只有本次准备正常 fresh 返回、且原许可有效的调用链能够启动。磁盘上的 prepared、同键重试、查询、来源恢复或进程重启均不能获得执行许可。

执行器在副作用前及挂起请求期间核对 owner、固定 dispatch 原字节、原 run 目录身份和最近确定 manifest。失效具有粘性；恢复原字节不恢复写权限。guard 只能同步成功或抛错，不能把 false / Promise 当作继续执行。取消、硬超时、无进展时限和 shutdown 锁定首个停止原因；停止请求与事件等待，禁止后续请求。watchdog 的 stop 为永久状态，late callback / touch 不能重新计时。

runner 的 `acceptance-completed` 只代表进展；writer 完成报告与证据交叉核验、发布 completed manifest 后，任务才结束。检出 BUG 的报告保留 failed gate，任务正常完成为 done。报告表示环境受阻但 writer 正常完成时，也保留原 blocked gate。任务状态不能充当业务通过证明。

写入可能已经提交时，不重复 finish / settle、不删除 partial。先窄读 manifest，完整完成快照通过后只投影已知结果，执行器仍保持 blocked。没有不确定发布、原 owner 和 lease 仍在、running head 精确等于最近确定 bytes 时，才进行一次窄收尾；收尾令牌只消费一次。失去 owner 绝不写入。shutdown 先关闭接纳，停止 in-process 请求和子进程，等待同一 finished，最后关闭 jobs 并退出；宽限超限退出整个进程。

固定 taskId 的冲突和任务库查询故障在 run 创建前拒绝。内存控制对象注册后，DB / SSE 为可降级投影，不能改变 gate 或触发第二次完成。`/api/jobs` 的 store=null 表示仅内存，内存任务的 mirrorDegraded 表示投影故障。启动只从固定绑定和核验运行事实对齐任务：完成 BUG 为 done，取消为 cancelled，重启中断为 interrupted。报告、证据或绑定无法核验时只将任务镜像标为 failed / MANAGED_MIRROR_UNAVAILABLE，保留原运行。

HTTP 接纳只允许完整确认字段，body 限制为 16 KiB 严格 UTF-8 JSON 对象；拒绝 URL、plan、expected、批准标记、身份和预算注入。完整 body 已被接纳后的断连不取消执行，响应丢失查询原 operationId；不完整 body 不接纳。错误只返回固定 DTO，不反射内部错误、路径或 owner nonce。

## 真实流程发现并修复的问题

1. 启动任务对齐原本只调用完成快照读取，却没有检查其 `integrity.valid / evidenceVerified` 返回值。读取层会安全返回无效快照而不抛错，因此可能把损坏历史报告仍投影为 done。现要求两者为 true，真实 report / evidence 损坏重启回归核对任务明确失败且原文件不变。
2. 控制台 JSON 下载原本重新序列化显示对象，导致下载与核验原件字节不一致。JSON 按钮现从 `/report` 下载已核验 blob，沿用身份切换和取消保护；真实浏览器逐字节比对服务端原件。
3. 本地 `node --test` 会递归发现 ignored workspace 中的历史源码快照，误跑重复 suite。新增维护测试入口，明确枚举 `core/test/*.test.mjs`；默认并发不超过 4，并保留小型机器原本更低的默认值和调用者显式 override。正式 `pnpm -C core test` 不再把运行证据当作测试源码。历史证据原件保留。

## 验证与证据

证据等级为真实受控本地流程：真实目录链、真实引擎 HTTP、真实 runner / writer、真实 Chromium CDP；目标 API 与模型日志使用本机夹具。未使用归档派发 envelope 代替本次接纳；来源实际响应不生成 expected。失败轮次与最终轮次分别保存，不把补跑重复计入总数。

完整原始记录见[证据索引](evidence/managed-execution/README.md)。

| 验证 | 结果与范围 |
| --- | --- |
| 正式 Windows Core 全量 | 1797 项 / 1789 pass / 0 fail / 8 skip，459491.5178 ms；跳过为 5 项 POSIX FIFO / pipe、1 项 POSIX SIGTERM 与 2 项显式 Docker |
| 最终诊断夹具的真实引擎复验 | 6/6，42525.244 ms；完整目录链、明确目标、BUG/task done、下载、同键幂等、双向共享槽、pending cancel、prepared 只查、kill/restart 与严格输入 |
| 最终 Linux POSIX 生命周期 | Ubuntu-24.04、Node 22.23.3、/tmp ext4：1/1，626.640437 ms；SIGTERM 收束 ENGINE_SHUTDOWN、目标 abort、无完成报告、重启只查。479 文件 / 21,784,952 bytes 快照前后核对不变 |
| 新执行真实 CDP | 4/4 检查组；running → completed BUG / task done，pending cancel → interrupted / task cancelled，下载逐字节一致；目标共 3 次、模型 0 次、pageErrors=[]、来源草稿原字节不变 |
| 既有浏览器与准备回归 | 10/10 命令 exit 0：8 条既有验收浏览器流程、原控制台克隆 CDP 和 1 条私有准备。加上新执行 CDP，共 10 条浏览器流程；私有准备 25/25，明确没有 browser / engine / executor |
| Core lint / Console build / Core smoke | 391 文件语法通过；build 通过并保留既有 chunk 提示；2 页本地 smoke 通过，offline unresolved=0 / externalAssets=0 |

Windows 默认高并发的首轮维护 suite 为 1797 项 / 1788 pass / 1 fail / 8 skip，失败在取消后新运行的 15 秒轮询。引擎未退出；旧夹具会保留早期 fetch 错误，因而仅凭该日志不能证明服务一直不可达，也不能确认负载是根因。现只增强失败诊断，不放宽 15 秒等待、单次请求超时或业务断言。限制默认并发后的完整 suite 以及最终精确夹具的六项实跑均通过；失败原始 TAP 无损压缩保留并核对解压 SHA256，见[压缩清单](evidence/managed-execution/tap-archives.json)，不将补跑相加。

十源 verifier 仍为 `e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8`，已逐路径与基线 `c8344ff9797a020f5897dd5ec10a7632df6dc2bc` 比较。本文不以父提交 CI 代替本次；main push 将触发完整 CI、新执行 smoke 与独立 Docker 验证，结论按本次提交的 head SHA 核对。

复现命令：

```powershell
pnpm -C core test
pnpm acceptance:managed:execute:smoke
pnpm -C core lint
pnpm -C console build
pnpm -C core smoke
pnpm docs:links
```

## 保留边界

执行 UI、Browser 所选侧来源锁、managed candidate / triage 迁移、认证写操作、持久 BUG 账本和自动关闭缺陷继续后续实现。该切片不修改十源 verifier、历史 fingerprint allowlist、candidate golden 或 BUG expected。单写者、有界身份检查和文件字节核验不构成敌对 OS 下的原子 inode CAS、多文件断电事务或远端 exactly-once；受控夹具通过也不证明任意外部业务项目的泛化效果。
