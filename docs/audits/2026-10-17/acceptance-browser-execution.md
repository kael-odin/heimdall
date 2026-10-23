# Browser 单次批准、固定来源执行与检查问题复验

日期：2026-10-17。D3 基于 `007760ed80019b4a5369ab284ea7ba734f18d0d2`，完成“保存的 Browser 候选 → 完整来源复核 → 本次批准明确目标 → 固定来源执行 → 核验报告与证据 → 显式登记问题及前后复验”。使用方式见[指南](../../competition/acceptance-browser-execution.md)，完整原件见[证据导航](evidence/acceptance-browser-execution/README.md)。

## 已实现的产品闭环

启动严格接受 operation、目录 generation / revision、候选及内容摘要、目标版本六字段。来源在本次调用中完整重建并编译 private branded 合同，提交前再次复核；只固定所选侧 details、screenshot 和 repeat。独立 `browser-operations/v1/bo-*` 保留 `br-*` run、`a-*` task、本次批准、合同、报告和检查观察。D2 摘要公式及 `executionReady:false` 保持原语义，没有增加 Schema5 或全局 Browser approval / selection。

Browser 与普通运行、托管 Spec 共用真实执行槽。仅 fresh 接纳的当次调用栈启动 runner；完整同键确认、历史 prepared 和重启读取均只读。取消、owner 丢失、watchdog 与 shutdown 后不提交完成报告；恢复先整批预检，再只收束 running。旧候选、triage、修改和 Spec 派发消费者继续拒绝 `br-*`。

执行只访问所选目标，参考来自已核验原件。环境变化、覆盖不完整及运行中断不能包装为可靠通过或目标 BUG。基础设施诊断使用静态阶段码；业务页面的 console / pageerror、DOM、断言实际值与截图继续保留。来源验证器只接受明确审查的固定 LF / CRLF 指纹，十文件 manifest 逐文件核对；不从当前 checkout 动态扩充兼容集合。

显式登记保存不可变 `observations.json`，复验固定直接 before 与当时已登记原件的 `beforeObservationSha256`，沿固定链继承最初 BUG 身份及验证器。“发现 → 通过 → 阻塞 / 缺失 / 不可比 → 再次可靠通过 → 再次失败”保留完整历史；未核验观察标为 `unverified`，并保留 lastVerifiedState。后补登记不会改变旧观察，原件变化、环、超深链或容量超限均被拒绝。

前端在 POST 前保存最小回执，未知响应只读对账。完整 fetch 与 JSON 正文受独立 60 秒 POST deadline 约束，到期释放控件并保留未知结果，不自动重发。来源全文仅在页面内存中；读取 channel / epoch 拒绝迟到结果，项目或版本切换后清理。证据图片再次验证 MIME、长度、header / bytes SHA，使用结束后撤销 Blob。

## 冻结后的真实流程与门禁

最终本机受控 Browser/CDP 闭环为 **16/16**，时间 `2026-10-17T13:26:56.676Z` 至 `2026-10-17T13:29:56.015Z`（UTC）。来源为一次新 Regression capture 的健康侧，两个实际视口和 menu point 共 14 项声明检查。候选保存后，来源端改为 HTTP 410；后续验收来源访问为 0，原来源全部字节保持不变。

- 缺陷目标：14 项中检出 4 个目标 BUG，分别为两项视觉与两项行为；首次显式登记得到 4 个 open issue。
- 修复目标：14 项全部通过；明确选择此前操作并登记后，原 4 个 issue 均为 verified_passed。
- 再次退化：原 4 个 issue 均为 reopened，保留首次发现、可靠通过和再次发现三段历史。
- 启动已被真实 202 接纳后精确注入 502，只用原操作 GET 恢复，未重复 POST。同长度图片篡改被 SHA 拒绝，三张正确原图实际解码展示。
- held navigation 经原生停止动作中断并关闭浏览器。停止已被真实 200 接纳但响应被挂起时，60 秒后控件恢复且只发一次 POST。
- 跨项目 404、旧 br 消费者拒绝、同键确认零新请求、重启同账本和 prepared 不启动均通过。执行与登记不修改 catalog；storage / hrefs 不包含来源全文。

完整 Core：**2461 total / 2449 pass / 0 fail / 12 skipped**，`892660.3291` ms；12 项跳过的具体原因保留在[原始输出](evidence/acceptance-browser-execution/core-full.stdout.txt)，未把跳过计为通过。Windows 上未运行的 Linux rename / FIFO 时序与未启用的 Docker 等平台或环境专用用例继续由各自门禁限定；Linux CI 另行核验。语法检查 482 文件通过，控制台构建通过。原 Acceptance console、owner recovery、managed execution UI、Browser candidates、Schema4 混合历史、forge 和 Console→Clone CDP 均使用原脚本完成。

11 组最终门禁均 exit 0，且每组前后 **578 项源码字节一致**，全部与同一发布快照相同；[INDEX](evidence/acceptance-browser-execution/INDEX.json)记录每组原始 command、stdout、stderr、before、after、summary 在 ZIP 内的路径。原 Acceptance console 的断言、timeout 和错误过滤没有因本片放宽。

7 张截图覆盖桌面 / 手机明暗主流程、桌面三图证据以及桌面 / 手机问题历史。组件 client / scroll 分别为桌面 964 / 964、手机 296 / 296，无采样水平溢出；主代理和独立审查均实际打开本轮图片，[最终界面审查](evidence/acceptance-browser-execution/frontend-final-review.md)记录具体范围。证据三图只目视核验桌面 light，历史覆盖桌面 light / 手机 dark，不扩展为全量无障碍认证。

`pageErrors` 为 0。`consoleMessages` 保留故意丢失接纳响应产生的 502 和主动停引擎期间旧页面轮询的 `ERR_CONNECTION_REFUSED`；没有删掉这些后宣称“零控制台错误”。Browser 插件在本次会话不可用，按前端测试技能的后备路径使用仓库 Playwright CDP。

## 审查及回归中修复的问题

| 问题 | 修复与验证 |
| --- | --- |
| fixed 分支 Playwright 物理诊断可能带出本机路径 | 使用静态阶段码和消息，保留页面业务观察；launch / navigation / capture / step / assertion 离线注入和原 runner 真实回归通过。 |
| API 错误投影读取异常属性时可能触发 getter / Proxy | 使用 own data descriptor 白名单与 string 类型检查，getter / Proxy / revoked proxy / coercion 和真实 HTTP 专项通过。 |
| BUG 通过后，后续 pass / blocked / missing 丢失 lineage | 固定此前 observations 原字节并继承最初问题；连续链、missing 后恢复、环境变化、再次打开和后补登记专项通过，修前原件仍保留。 |
| POST 永不结束使 writing 长期锁住 | fetch 与正文均有独立 deadline；超时保留原回执并只读恢复，单测和真实挂起停止响应均验证只有一个 POST。 |
| 共享 runner 改变后 Spec 静态兼容清单漏新指纹 | 首轮 Core 为 2384 total / 2103 pass / 269 fail / 12 skipped，原件完整保留。独立核对十文件中仅 Browser runner 改变，Spec 早期委托及其余九文件不变；保留旧四值，新增已审 D3 LF / CRLF 两值并核对 manifest，未知源码变化仍拒绝。80/80 投影 / 计划及 10/10 边界专项通过；实际 draft / healthy / BUG 报告、identity / oracle、事件与全部证据原字节对照一致且 Browser launch 为 0。[独立兼容审查](evidence/acceptance-browser-execution/spec-verifier-compatibility-review.md)无新增阻断。 |
| 第三轮托管执行 UI 严格 console 捕获一条 ERR_NO_BUFFER_SPACE | 16 项业务检查均通过，但完整门禁仍按失败保留；错误的具体请求未被原脚本记录，不能宣称已确证系统资源耗尽。原断言、timeout 与错误过滤保持原样，单独复验后仍重新跑完整最终门禁；前次通过不能代替本轮。 |
| 新 Vue 文件中两处 CRLF 会被 Git 暂存规则转换，与门禁原字节不同 | 保留归一化前的第三轮全部已运行结果与前像，将组件两处 CRLF 统一为仓库 LF；重新冻结 578 项源码并完整重跑最终 11 组，随后从实际 Git 暂存字节独立核验。[换行记录](evidence/acceptance-browser-execution/eol-normalization.json)列出原始与规范化 SHA 和字节数。 |
| 候选回归主动停引擎后，旧页面轮询触发严格 console 断言 | 业务 12 项均过，原件保留一条首引擎连接拒绝。两处主动停机前先导航 about:blank，停止旧 document 的轮询；同一 Browser context / storage / initScript 与新 origin 原生重读保留。断言、timeout 和错误过滤保持原样，仅修夹具生命周期顺序；随后专项验证并重新冻结、重跑完整发布门禁。 |

首轮构建误用 Vite `--root`、初版前端测试失败、lineage 修前复现、首轮完整 Core 失败，第二轮候选夹具停机顺序失败，以及第三轮换行归一化前的通过结果及托管执行 UI 严格 console 失败均收入完整包，未覆盖或删除。修复后重新冻结全部源码，并重新跑最终 11 组门禁；先前通过不能代替本轮最终结果。

## 证据、发布与范围

证据公开包含 19 组原件、5544 个文件，ZIP 大小 69111818 bytes，SHA-256 为 `f77e154f829fb46a4a3d4b9f5fbe99b41d05198f41eabe758705a3765ee61e4c`。INDEX 为每个原件、可读副本和最终源码记录长度与 SHA；发布器逐项核对 ZIP 回读和 CRC，并扫描高置信凭据模式。Chromium profile 缓存按清单排除，仍保留在本机原目录。详见[原件索引](evidence/acceptance-browser-execution/INDEX.json)与[完整包](evidence/acceptance-browser-execution/complete-evidence.zip)。

发布前独立核对工作树与 Git 暂存字节、完整原件集合和全部门禁。该提交自身 Linux CI 在推送后按精确 SHA 另行查询；本机通过与父提交 CI 不代替它。D1 / D2 历史审计、失败原件、冻结 ZIP 和索引保持原样。

本机受控闭环覆盖声明路由、视口、menu point 和只读策略，不构成任意站点、登录态、写业务、PRD 意图或 Figma 对照的通用保证。`closesBugs:false` 保留检查复验与业务最终关闭的边界。全局 Browser approval / selection、业务工单聚合 / 最终关闭、长期不存在的未知操作安全解除及操作归档仍待独立建设。
