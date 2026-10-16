# 执行工作台：明确目标、原操作恢复与请求停止

日期：2026-10-17。本切片把已经交付的托管 Spec HTTP 执行能力接入真实控制台。入口为“验收工作台 → 项目与版本 → 执行已选需求验收”：核对当前选用的完整需求合同，明确本次目标版本，再确认启动。操作指南见[托管 Spec 合同与执行](../../competition/acceptance-managed-spec.md)，原始运行和发布副本见[证据索引](evidence/execution-ui/README.md)。

证据等级为 `local-fixture-real-button-flow`：真实 Chromium CDP、原生表单和按钮、真实引擎接纳、runner / writer、状态与报告读取，目标业务由本地受控 API 夹具提供。模型请求为零，实际响应不参与生成 expected。本次没有把受控样本扩写成任意外部项目的通用验收保证。

## 已交付行为

新 `AcceptanceExecution.vue` 独立读取当前 `selection → approval → candidate`，不借用需求基线面板正在浏览的草稿。核对完整合同后，目标下拉框仍为空；选择具体版本会显示完整 URL 与构建引用。目录 revision、selection 或目标发生变化时清除确认，必须重新核对。批准、选用继续是独立记录操作，仍返回 `executionReady:false`。

启动前同步生成 operationId，将不可变确认写入本地存储并读回，再由单次闭包发送一次 POST。body 只包含 operationId、expectedGenerationId、expectedRevision、selectionId、contentDigest、targetReleaseId 六项；projectId 在路径中。恢复记录不保存令牌、计划、预期断言或可变运行状态。请求使用独立执行 transport，避免把没有目录 CAS 的正常 202 错判为目录写入失败。

页面刷新、丢失 202、HTML 502、5xx、START_FAILED 或单次 404 均保留原操作身份，通过 GET 核对；prepared 只有查询入口。只有明确的前置拒绝成功写入独立拒绝记录后，才能重新核对新操作。原操作状态仍不确定或执行中时，阻止该项目新启动。首次合法响应固定原 run / task 身份，后续身份变化被拒绝。unknown / prepared 自动退避查询最多五次，之后保留手动查询；折叠目录或隐藏页面暂停轮询。

请求停止在发送前锁定当前页面操作，响应丢失后只查询原操作，等待 manifest 终态。执行完成和业务门禁分别展示：检出 BUG 的正常完成任务为 done，报告门禁仍为 failed。终态查询暂时失败会保留最近终态与报告入口，并单独提示读取错误；不会把它回退为未知运行。项目、记录和组件切换都有 epoch / abort 保护，A → B → A 及晚到 POST / GET / capability / cancel 响应不能污染新选择。

## 验证结果

| 验证 | 结果与范围 |
| --- | --- |
| Windows Core 正式维护 suite | 1819 total / 1811 pass / 0 fail / 8 skip，458391.8319 ms。跳过为 5 项 POSIX FIFO / pipe、1 项 POSIX SIGTERM 与 2 项显式 Docker |
| 新执行客户端专项 | 22/22；与既有 catalog / baseline / workbench helper 合跑 63/63，不将重叠测试重复计数 |
| 最终真实执行 UI CDP | 16/16 检查、8 个案例、pageErrors=0；执行夹具目标请求 8、只读恢复夹具目标请求 0，两组模型请求均为 0；原来源草稿字节保持不变 |
| 原控制台克隆 CDP | taskStatus=done、cloneStatus=200、pageErrors=[]，保留现有克隆闭环 |
| lint / Console build | Core 393 文件语法通过，Console 构建通过；保留既有 Graph3D 大 chunk 提示 |
| 视觉独立复核 | 6 张最终有效截图逐张目视复核，结论 ship；1440px 桌面、390px 暗色与亮色没有发现新增横向溢出或布局阻塞 |

全量 Core suite 在 helper / test / smoke 冻结后运行。其后 Vue 增加轮询暂停和终态读取错误保留，并修正旧边界文案；最终树另经 Console build 与真实 CDP 验证，推送后的 CI 按本次 head 核对。父提交 `2737c7648f46eccbcaab5cf8c69497fd22f397df` 的[后端 CI](evidence/managed-execution/ci-main-2737c76/README.md)为三个 job success，但不能替代执行 UI 提交自身的验证。

真实浏览器覆盖原生重复 Enter / 点击仍只有一次严格 POST、凭据先于请求落盘、显式目标与目标变化清确认、旧 CAS 拒绝、丢响应刷新只 GET、404 / prepared 不执行、普通与托管双向共享槽、原操作查询不受 busy 阻挡、pending 停止后不触发后续检查，以及所有关键晚响应。浏览器共记录六次启动 POST：四次真实接纳、一次未转发故障、一次旧 CAS 拒绝；此计数不等于六次执行。

浏览器插件在本机不可用，使用仓库 Playwright 与实际 Chromium 的 `connectOverCDP`，未把静态页面分析当成点击流程。两张手机截图直接证明终态与原操作身份可读；“查看运行与报告”按钮位于当前截图视口下方，六图本身不能证明该按钮的移动端触控可达性。报告打开闭环由浏览器操作记录证明。键盘全路径、屏幕阅读器和合成颜色对比度未在本独立视觉复核中重新实跑。

## 失败轮次与证据处理

首次 late-cancel 测试的新 context 没有 seed 旧完成操作，却尝试选择该操作，在原有 15 秒期限内超时。修正夹具 seed 后重跑，没有放宽业务断言或时限；首次 failure.json 保留，不能计为产品功能通过。

中间一轮功能检查 16/16，但移动截图停在新建验收侧栏，没有展示文件名声称的终态，因此这批移动图不作为视觉通过证据。最终捕获在调整视口后打开结果区、滚动至操作状态，并断言状态矩形完整位于视口内；保留 `screenshot-rects.json` 交叉核对。最终有效轮次为 `execution-ui-bdad78f7-e5bb-4765-bb0d-c8ccceff3ac6`，不把重复轮次累加。

原日志、失败运行和完整原件继续保存在 ignored workspace。发布 JSON 若移除受控 fixture 的临时鉴权 header，明确记录原件和发布副本 SHA 与脱敏路径；该副本不声称逐字节原件。压缩日志均保留原字节 SHA、长度与解压往返校验。Core 原文件虽然名为 `core.tap`，实际输出为 spec reporter，归档使用 `core.stdout.gz`。

## 保留边界与后续建设

本地存储损坏、不可用或达到每项目 100 条凭据时保守阻止新启动，保留原记录。操作归档管理尚未实现，跨浏览器恢复、人工清除浏览器数据和远端 exactly-once 不由本凭据机制保证。运行 head 只确认执行状态，完整报告与引用证据仍需经过既有核验读取。

本次继承现有 Console 令牌、组件和双主题，没有改变全局设计系统。历史审计继续保留原切片的时间边界；新增实施记录与操作指南作为当前能力入口。下一切片推进操作凭据归档管理与 Browser 所选侧来源锁；持久 BUG 账本、自动关闭、认证会话和写入型业务验收仍待实现。managed candidate / triage 继续隔离，十源 verifier、原草稿、历史报告和原门禁不变。

复现：

```powershell
pnpm -C core test
node --test core/test/acceptance-execution-ui.test.mjs
pnpm -C core lint
pnpm -C console build
pnpm acceptance:execution:ui:smoke
$env:HEIMDALL_E2E_CDP_SELF='1'
node core/scripts/smoke-console-cdp.mjs
pnpm docs:links
```
