# 验收运行展示读取与原子发布竞态

日期：2026-10-17。本次修复针对 Browser 来源归属工作台提交 `b42826e4956d491b461bbd00af3d18b2ad702ad5` 自身 CI 暴露的真实读取失败。普通 worker 原子发布进度或完成 manifest 时，浏览器读取运行详情或列表可能收到 `409 / MANAGED_RUN_INTEGRITY_FAILED`。失败证据与修复证据分别保留，不能用本机成功改写原远端结论。

## 已确认的问题

原 [CI 证据包](evidence/browser-bindings-console-ci-main-b42826e/README.md)保存精确 SHA 的 run `39005540253`、attempt 1、完整日志及上传附件。Linux 完整 Core 为 2273 total / 2269 pass / 0 fail / 4 skip；其后的第一个 Acceptance console 浏览器 smoke 失败，后续 14 个验收 smoke 与 Docker 步骤未执行。浏览器 GET 的 409 与测试主动制造的并发 POST 冲突是两件独立事实。

最初尝试对普通 legacy head 的原子替换做有界整批重读。专项通过后，原 smoke 再次在运行列表 GET 触发 409；这版方案没有发布。随后通过 ignored runtime loader 观察到正常 worker 在最终检查阶段又原子发布了新 inode。要求一次列表读取等待所有 worker 同时静止，会把正常更新误判为来源变化。原重读方案的日志、冻结源码、浏览器失败截图与运行原件保留，未增加重试次数、延长超时或豁免资源错误。

## 最终实现边界

新增 `createAcceptanceDisplayReadScope` 与 `readAcceptanceDisplayRun`，只供运行列表与单条运行 GET 展示使用。本请求第一次稳定捕获的 legacy manifest / report 字节保持不变；后续普通原子替换不会让本请求采用更新版本，也不重新枚举或重试整批。下一请求重新读取当时版本。这不是跨文件原子快照，也不保证返回最新进度。

根目录、run 目录与 dispatch namespace 仍保持身份检查；managed head、原地修改、权限变化、硬链接和已观察替换 inode 的后续原地变化继续拒绝。Linux 在旧 fd 仍打开时替换路径可能使旧 inode 的 link / ctime 改变，仅在新路径是独立安全文件、旧 fd 身份 / 大小 / mtime 不变时容忍这种释放元数据变化。

`readAcceptanceRun` 保持严格。启动恢复、finalize、triage、artifact 与来源 snapshot 不使用展示入口。展示 scope 的私有能力标记不能通过 `assertAcceptanceReadScope`，也不能传给文件证据 capture 或 managed completed snapshot；展示版本本身不授予来源、下载或写权限。新坏 head 或 managed marker 在已捕获版本之后原子出现时，当次最多显示原先正常字节，下一请求必须重新核验；独立 artifact / triage 请求仍走严格读取。

## 验证状态

最终实现的确定性专项为 29 total / 28 pass / 0 fail / 1 skip。Windows 上通过实际关闭 fd 后的原子发布、Linux fd 释放元数据模型和复合批次反例；真实 Linux 打开 fd 时 rename 的用例在本机明确跳过，等待精确提交自身 Linux CI。

冻结实现的组合专项为 79 total / 77 pass / 0 fail / 2 skip，93,087.6374 ms。覆盖 display 竞态、managed reader、managed consumers 和 batch edges；两个 skip 不计为通过。Core lint 450 文件通过；Console build 成功；原 Acceptance console fresh smoke exit 0，27,627 ms，`pageErrors:[]`。未修改该 smoke 的断言、timeout 或错误过滤。四阶段前后五份相关源码摘要一致。

完整 Core 与最后三项真实回归均已通过，542 个实现 / 脚本 / 测试 / 前端 / CI / package 条目的前后内容摘要完全一致：

| 门禁 | 实际结果 |
| --- | --- |
| 完整 Core | **2302 total / 2292 pass / 0 fail / 10 skip**，545,705.8707 ms |
| Core 真实流水线 smoke | exit 0，33,990 ms；recon / forge / live bundle / watch / jobs 完成 |
| Console→Clone CDP | task done / clone HTTP 200 / pageErrors []，29,281 ms；2 张截图 |
| Browser 来源归属工作台 | fresh 默认命令 **14/14**，29,108 ms；原比较失败事实与来源原字节保留 |

原 Acceptance console smoke 的 17 个界面检查全部通过；其业务夹具报告仍为 failed、39 个 measured checks / 3 个 BUG，这是预期检测结果。来源归属工作台的本轮验证包含真实 worker 捕获、明确选侧、三类受保护证据、未知提交只读恢复和迟到预览隔离。专项、完整 Core 与浏览器检查分别报告，不叠加为单一覆盖总数。Console→Clone 截图已目视确认控制台非空并显示完成记录。

最终独立审查对冻结源码运行同一组 12 项 probe，全部通过、exit 0、stderr 为空；覆盖复合批次篡改、连续正常发布、旧字节展示、strict/source/managed 隔离与离线 fd 模型。该审查没有重新执行 Browser，也不代替真实 Linux 用例。

[本机证据包](evidence/acceptance-display-head-race/README.md)已按 19 组完整来源目录封存，包含 905 份原文件、18,046,060 bytes 的原始内容及空目录索引；各组保存为 tar.gz，完整成员清单与 SHA-256 分别记录。包内还保存精确打包器、输入计划、542 条源码 guard 和完成凭据。原始 CI 失败包、放弃方案和独立审查夹具错误均在各自分组，没有覆盖为成功结果。

[独立发布核验](evidence/acceptance-display-head-race-publication/README.md)已重新解析 gzip/tar，确认 47 份包文件、19 组成员集合、905 份原件字节、542 条源码 guard 和五份冻结源码一致，原 CI 351 文件的完成凭据与 SHA 链未变。有界强凭据模式扫描 27,963,702 bytes、0 候选；嵌套 ZIP 不递归展开，原 CI 的完整解压树已在扫描范围内。最终文档链接为 757 个目标 / 219 文件通过。独立核验确认公开包 47/47 份 Git 暂存 blob 保持原字节；主流程还逐项核对包含包外源码、文档与原 CI 的全部暂存内容。

当前报告不声明修复自身的远端 CI 通过；推送后按精确 SHA 跟踪，不使用本机结果或父提交替代。

## 剩余范围

本次验证使用受控本地站点和原有本地模型 stub。它解决运行展示对正常原子发布的误拒绝，不扩大 Browser 候选、批准、选用或执行合同，也不把来源组织核对预览升级为完整批准依据。Schema4 显式维护与混合历史兼容仍在独立工作树验证，未包含在本次热修复中。
