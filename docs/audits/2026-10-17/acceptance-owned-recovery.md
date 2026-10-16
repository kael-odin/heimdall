# 验收启动恢复：整批预检与保守中断

日期：2026-10-17。本切片把 owner startup recovery 接入真实引擎，为后续托管 Spec executor 建立启动边界。唯一 owner 在接纳新验收任务前，检查整批遗留事实，将可信的 managed / legacy running 收束为 interrupted；不重放请求，不启动 prepared。托管执行入口仍为 `executionReady:false`。

## 行为与失败边界

新增 `recoverOwnedAcceptanceRuns({owner,limits?})`，root 只能来自真实私有品牌的 live owner。恢复不 acquire / release owner，不咨询当前目录选用来重新批准历史运行。它固定完整 dispatch namespace、实际 run 与 reserved run 并集、目录身份和恢复依赖的原始 head bytes；第一次写入前完成所有预检与终态编码预算检查。清单末项损坏不能导致前面的健康 legacy 已被中断。

managed reserved 仅读取不可变 dispatch 和 authoritative manifest，并核验 lifecycle / linkage。running 的 report / evidence 保持不透明：坏 JSON、FIFO、symlink、多硬链接、未提交临时项都不被解析、跟随或删除。terminal head 核验后跳过，不消费历史证据；损坏的历史报告仍不能通过可靠快照或下载入口。prepared 只有 run 目录完全不存在时才可跳过，空目录或缺 manifest 属于不完整身份，会阻断整轮预检。

unreserved legacy 使用严格两份 head 读取，不能从不可读报告推断没有托管标记。仅 report 带 marker、orphan marker、重复 reserved run / task、坏 sidecar 或不安全 namespace 均阻断。旧 `recoverAcceptanceRuns({root})` 保持 number 返回，改用同一严格预检，但只收束 legacy，不能写 managed。

内部 writer 新增 prepare / assert / commit settlement 原语。私有 WeakMap token 固定 owner、原 manifest、terminal bytes 和时间；prepare / assert 均零写，commit 尝试即消费。改成另一个仍合法的 running 也会触发原字节冲突，不能重新采用；取消的 active guard 不阻止失败收尾，丢失 owner 始终禁止写入。

managed 全部成功后，重新建立只捕获 managed head 的读取范围，并与初始或本轮精确发布的预期 bytes 比较，才进入 legacy 阶段。原始范围不会跨自身合法写入继续使用，也不允许 fresh capture 接纳外部改动。legacy 使用原 expected token，报告存在或缺失事实也持续核对。

上限为 1024 个 run、4096 个直接 root entry、4096 份捕获文件、256 MiB 捕获 bytes、每 JSON 8 MiB、128 次收束；调用者仅可收紧。上述是业务读取与写入次数预算，不是进程 RSS 硬限。多 run 不是事务：第二次提交失败或 publication 成功后再报 I/O 错误，会保留已提交事实、已知计数、阶段与 `writeMayHaveCommitted`，停止后续处理，不回滚、不重试不确定发布。

## 引擎与诊断

引擎取得 owner、初始化 catalog 后、启动任务流前，只调用 owned 恢复一次，不 fallback 到旧入口。恢复 preflight 零写不等于整个 startup 零写，catalog 初始化及 owner 文件仍遵循既有合同。

`GET /api/acceptance/recovery` 返回启动 readiness。成功包括 managed / legacy interrupted、prepared、skipped 和总收束数；失败只暴露固定安全 DTO。ready 不是托管执行许可。恢复受阻时保留 catalog 等诊断 GET，所有 `/api/acceptance/*` 写操作在创建 task / runner / job 前返回 `503 / ACCEPTANCE_RECOVERY_BLOCKED`。修复现场不会在同一进程自动解除 latch，必须重新启动并完整预检。owner loss 仍优先阻断读取与写入。

## 验证与证据等级

本轮使用真实 owner、真实 writer、真实 engine 子进程与 Chromium CDP；目标与模型为受控本机 HTTP 夹具。恢复浏览器夹具复用已归档并经 schema 核验的派发合同，仅变更测试身份和本机目标，再重算计划摘要；它不是 live catalog admission 的替代证明。

完整证据、固定源码 SHA 与原件归档映射见[证据索引](evidence/acceptance-owned-recovery/README.md)。

| 验证 | 结果与实际范围 |
| --- | --- |
| 最终 Windows Core 全量 | 1713 total / 1706 pass / 0 fail / 7 skip，269789.3491 ms。跳过为 5 项 POSIX FIFO / pipe 与 2 项显式 network-none Docker；FIFO 由 Linux 验证，Docker 由新提交 CI 的独立步骤验证 |
| 独立恢复反例 | 37 项：实际新 owner、整批零写、prepared / partial / terminal、marker、重复身份、预算、清单变化、expected 冲突、自写后范围、owner / root 丢失与不确定发布；Windows 跳过的 2 项 FIFO 在 Linux 实跑 |
| Writer readiness | 31 项，Windows 30 pass / 1 FIFO skip，独立 Linux 31/31；真实 token、零写、CAS、失 owner、固定时间与字节、guard 时机及 publish 后报错 |
| 真实引擎启动 | 4 项，覆盖混合恢复、completed BUG 的坏历史报告保留、nlink=2 partial、不确定身份、ready / blocked、故障 latch、修复后重启及双引擎 / owner loss |
| Linux 固定输入定向 | 386 文件、4,045,295 bytes 的源码 / 测试 / 夹具快照；14 suites 共 230 项。首轮因副本缺少 parse5 导致 7 个 engine 用例加载失败；固定 86 份依赖 bytes 后仅补跑这 7 项并全通过。去重为 229 pass / 1 Windows 专用 skip，不把补跑重复相加；全部恢复 / writer FIFO 实跑 |
| Core lint / Console build / Core smoke | 378 文件语法门通过；build 通过并保留原 chunk 大小提示；原 smoke 通过，2 页、visual / DOM 100%、offline health unresolved=0 / externalAssets=0，分数只适用于本地夹具 |
| 新恢复真实 CDP | 4/4 检查组，pageErrors=[]，目标与模型请求均 0；截图显示已中断，完成报告 gate / triage 不出现；第二次启动正式文件字节一致，坏 namespace 保留诊断 GET 并阻断写入 |
| 最终浏览器回归 | 9 条浏览器 / CDP 流程和 1 项私有准备 smoke 全部 exit 0：普通验收、Spec、comparison、catalog、旧目录迁移、需求基线、managed 读取、新恢复及原 CDP 克隆；准备另计，不与浏览器重复相加 |
| 原 CDP 克隆 | taskStatus=done / pageName=home / cloneStatus=200 / pageErrors=[]；控制台真实点击到产物页闭环，保留两张截图 |
| 文档链接门 | 569 个本地目标 / 159 份 Markdown，通过；报告、证据索引和项目导航均可跳转 |

独立审查实际复现了 owned 根在初次检查时消失却返回全零成功的问题；现已改为明确阻断。对应测试真实 rename 根目录，核对恢复没有写 syscall、原 manifest bytes 保留；root-only 缺失根返回 0 的旧兼容行为不变。

普通验收浏览器首轮在 page console 捕获两条 HTTP 409，原脚本未记录对应 URL / code，不能确定根因。随后补充有界失败响应 / console location、截图与原 engine log 归档，保持原 `errors=[]` 断言和流程时序。CI 精确上传这些失败文件；该诊断增强不被表述为已修复一个确定的产品根因。额外加密轮询探针出现自身等待问题，其结果不作为正常流程通过或原 409 根因的证据。

父提交 `75e34d4fd6a331cb0e26a6820d856d350e4584e8` 自身 CI `38955933219` 已确认全部成功，其中独立 Docker network-none 步骤实际通过。它只证明父提交，不代替本次提交自身 CI；本次仍由 main push 触发完整 CI 与新增恢复 smoke。

十源 verifier 重新计算仍为 `e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8`；算法、历史 allowlist、两份 candidate golden 与 14 份原件保持不变，原件逐一与父提交 bytes 对照。当前及父提交的正常浏览器诊断对照均通过，最终加入失败归档后的原脚本也通过，不能据此反推最初 409 的确定原因。

## 保留范围

- engine executor、统一槽、取消 / watchdog / shutdown、task mirror 与明确目标版本的执行 UI 继续后续切片；candidate / triage 消费者保持隔离。
- 完整 preflight 只证明当时已捕获的事实；发布期间仍可能发生 I/O 故障或外部变化。单写者与有限路径 / 字节检查不构成敌对 OS 下的原子 inode CAS、远端 exactly-once 或多文件断电事务。
- 恢复不删除不完整证据、不补 completed，不因历史报告损坏重写终态，也不重新发送旧请求。原始门禁和 BUG expected 不变。
- 本轮覆盖受控本地流程，不声称外部真实业务系统、鉴权写操作或通用项目效果已验收。

复现入口：`pnpm acceptance:owned:recovery:smoke`；规范合同见[托管 Spec 指南](../../competition/acceptance-managed-spec.md)。
