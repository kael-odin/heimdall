# Browser 启动结果核对与永久拒绝实施验收

实施日期：2026-10-17 至 2026-10-18（Asia/Hong_Kong）。D4 基于 `5d1de82ac31fa48ef45ed0746591fbd0c710d264`。最终本机 12 组门禁全部通过，真实 UI 原件与四图已独立复核；提交自身的 Linux CI 必须另外核对。

## 产品行为

当启动 POST 的响应丢失时，工作台保存原确认六字段并阻止新启动。新增只读 `resolution` 返回完整接纳、完整拒绝或尚未决定；用户明确确认后可用 `deny-start` 永久阻止这个操作号的迟到启动。完整同键决定优先读取，已接纳的运行继续执行。解除确认后，重新复核与批准才能使用新操作号开始验收。

前端只在核验项目、原六字段、domain fingerprint、完整 operation view 或拒绝 canonical JSON 加 LF 的 SHA 后，精确解除对应确认。普通 4xx、列表出现同号、旧启动 view、等待时间和查不到记录都不能解除。所有回执集合写入使用原生同 origin / project Web Locks，锁内重读、核对、写入和完整回读；不支持锁时仅只读，写入或回读失败在当前页面内保持项目阻断。

决定单元继续使用 `browser-operations/v1/bo-*`：完整 accepted dispatch 与单文件 `rejection.json` 互斥。新决定需要独占创建目录与私有 claim；已有部分、混合、未知或不安全现场只保留并阻断，不能补写。拒绝无过期时间，不回收操作号；拒绝本身不创建 run、task、来源物化或目标导航。具体操作和 HTTP 合同见[使用指南](../../competition/acceptance-browser-start-resolution.md)。

## 本轮发现与修复

| 问题 | 最终处理与证据范围 |
| --- | --- |
| 旧 operation 查询在项目归属核验前，对 foreign rejected bo 返回冲突 | 改为先核验范围，旧 operation / report / evidence / cancel 仅服务完整 recorded；foreign rejected 返回 404。已证实的是拒绝事实存在性泄露，未扩大为正文泄露。 |
| 拒绝实际提交后抛出 unknown，执行槽释放再失败时丢失 unknown 标记 | 合并保存 `commitMayExist`；真实落盘后注入双异常，最终 503 仍保留 unknown，runtime 阻断而原 proof 可读。 |
| 回执可能被不完整依据解除，跨页写入可能丢另一条确认 | 只允许专用完整 proof 精确解除；原生锁覆盖全部集合写，捕获原 client 隔离迟到上下文；写入故障锁存。纯状态测试与双页真实 helper 交错分别验证。 |
| round5 原 catalog 末次来源栅栏测试失败 | 真实复现新增昂贵外部 guard 过早触发，使复制 evidence 前就失败。claim 后改用 `currentClaim` 保留 namespace 容量、形状和 owner 检查，将来源 guard 留在真正的 dispatch 末栅栏。未修改原 catalog 测试。 |
| 上述独立探针发现旧 partial read 错误码变化 | 仅旧 `readInternal` 将 `DECISION_INCOMPLETE` 投影回 `BROWSER_OPERATION_UNAVAILABLE`；新 `inspectDecision` 保持严格完整性错误。未放宽新决定核验。 |
| 两页同时批准都在等待锁前看到空集合，随后各发一次 POST | 两个实际 Vue 状态与产品 helper 的确定性反例确认原逻辑有空集合检查 / 写入竞态。新增 `claimForStart`，在同一锁内检查空集合、保存唯一确认并全回读；另一页只读取已有确认，不写、不 POST、不锁存存储故障。修后纯 Node 专项 25/25，真实原生锁 smoke 另覆盖 claim/claim 的 `[true,false]`。 |

修后原 catalog 整文件 **9/9**、原决定整文件 **16/16**，均 exit 0、无 skipped，600 项源码前后相同。专项通过不替代最终完整 Core。服务层修前复现期间四文件发生变化，该次只作旧模块复现；修后另建独立 recheck，四文件前后字节一致。

## 最终冻结与门禁

最终 round7 动态快照覆盖 600 项 maintained 源码、脚本、测试、工作流和配置，SHA-256 为 `f700d54a3bb10a55748818d68b6d33fe43724f8485ec72063e0a35d253c078d8`。收集 tracked 与 untracked 文件，不硬编码旧文件数量。最终 store SHA 为 `f1b3a61fc0e88838f987e46375f8311e7819e348c7484b94ef8a57e42166684a`。600 项 Git filtered / no-filter 字节预检无转换。

round7 的增强 UI 预检通过后，重新运行完整 Core；通过后才串行运行其余门禁。每组保存 command、stdout、stderr、exit、before / after 与冻结快照。原 Acceptance console、托管执行和 D3 固定来源执行的断言、timeout 与错误过滤均保留。原 Console 和 CDP 输出使用本轮独立目录，避免覆盖旧原件。

<!-- FINAL_GATE_RESULTS -->
完整组于 UTC `2026-10-17T16:42:19.356Z` 完成（香港 `2026-10-18 00:42:19.356`），12/12 门禁均 exit 0、signal null、unchanged true。每组 before / after 与上述 600 项最终快照逐项相同。

| 最终门禁 | 本轮结果 |
| --- | --- |
| 完整 Core | **2530 total / 2518 pass / 0 fail / 0 cancelled / 12 skipped / 0 todo**；`1077541.6168` ms |
| Console 构建 | exit 0 |
| JavaScript 语法检查 | exit 0 |
| D4 启动结果核对真实 UI | **9/9** |
| 原 D3 固定来源执行 UI | **16/16** |
| 原 Acceptance Console | exit 0，桌面与手机实际流程通过 |
| owner 启动恢复 | exit 0 |
| 原 managed 执行 UI | **16/16** |
| Browser 候选 UI | **13/13** |
| Browser 来源绑定 Schema4 UI | **19/19** |
| 原 forge 端到端 smoke | exit 0 |
| 原 Console CDP smoke | exit 0，`HEIMDALL_E2E_CDP_SELF=1` |

Core 的 12 项跳过为 Windows 上不适用的 10 项 Linux / POSIX 文件、FIFO、重命名或信号用例，以及常规测试未启 Docker 的 2 项。它们均保留原名称和原因；Linux / Docker 行为仍须在本提交 hosted CI 原件中核对。上述 UI checks 不是额外 Core 测试总数，不将早期通过或专项数相加为本轮总数。
<!-- /FINAL_GATE_RESULTS -->

开发期另外保留：前端纯测试 20/20、Core-backed 与纯组合 39/39、service 初轮组合 32/32、后续范围及双异常定向 6/6、crash / race / engine 6/6，以及早期 schema / store / compatibility 专项。它们范围重叠且部分早于最终 store 最小修复，不能累加，不能替代本节最终冻结门禁。

## 真实浏览器验证与范围

<!-- FINAL_BROWSER_RESULTS -->
最终 round7 新 UI **9/9**，exit 0，600 项源码前后相同。真实运行根为 `browser-resolution-console-smoke-177bb267-39ed-4123-bc5f-a07c91fd69c2`，外层门禁于 UTC `2026-10-17T16:31:57.712Z` 至 `16:32:57.549Z` 完成。独立复核从该门禁 stdout 的唯一成功事件绑定新 root，重算 25 份原件并逐张打开本次四张截图；没有沿用预检或 round6 图片。

| 最终核验 | 原件结果 |
| --- | --- |
| 迟到原启动与永久拒绝 | A 原 UI body 共 342 bytes，经同一个 Node HTTP relay request / socket 分段进入引擎；prefix 到达但未 end，拒绝落盘后补 tail，原 start 返回 409 `BROWSER_START_REJECTED`，无 dispatch、run 或目标导航。 |
| 已提交拒绝丢响应与重启 | B 在相同数据根、origin、端口和 Browser context 重启，3 GET、0 新 POST 恢复；原 canonical JSON+LF 决定字节与 SHA 不变。 |
| 双页原生锁 | save/save、resolve/save、resolve/resolve 和 claim/claim 四组均实际排队；最后一组返回 `[true,false]`，只保存唯一原 a 确认。四组包含在上述 9 项 checks 内，不另加总。 |
| 新批准正常验收 | 新操作 `bo-e2312c7a-dd23-41d2-8221-4c9d9b7c755c` 的 API、DOM 和手机图均为 completed / passed，14/14 声明检查通过；报告按钮 1、停止按钮 0。 |
| 来源与浏览器健康 | 29 份来源文件 SHA 不变，保存后未重访来源，storage / href 不含来源全文 sentinel；pageErrors 0，5 条 console errors 均逐条对应受控 503，不能称零 console errors。 |
| 视口与目视 | 1440×1000 和 390×844、明暗主题四图均实际打开；采样 documentWidth 等于视口。B 手机首屏只覆盖回执上半部，下部说明由完整 DOM 证明。 |

独立审查见[最终 Browser 复核](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/round7-final-browser-review.md)。四张本次截图可直接打开：[A 桌面亮色](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/resolution-A-desktop-light.png)、[B 手机暗色](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/resolution-B-mobile-dark.png)、[恢复后桌面暗色](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/resolution-recovered-desktop-dark.png)、[新批准手机亮色终态](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/resolution-fresh-mobile-light.png)。round4、round6 和 round7 增强预检的 9/9 继续只作开发证据。
<!-- /FINAL_BROWSER_RESULTS -->

真实 smoke 的设计包含以下可核验边界：

- A 场景由原生 UI 触发 start；拦截原 body 后交给单个 Node HTTP relay request。发送 prefix、engine observer 记录收到且未 end，永久拒绝落盘后才在同一 request / socket 补 tail。该证据不宣称 Chromium 原生 socket 分段发送。
- B 场景使拒绝已提交但 UI 丢失响应，暂阻 proof GET，保留确认；在相同 DATA/root/origin/端口/Browser context 重启后，通过 GET 核验原决定。未对 SIGTERM 与 fallback SIGKILL 作最终断言，不据此宣称优雅退出。
- 两个真实页面通过产品 helper 和原生 `navigator.locks` 验证 save/save、resolve/save、resolve/resolve、claim/claim；不扩大为两页完整 Vue storage 事件流程。双 Vue 状态的 POST 数量另以确定性离线反例验证。
- 新批准使用新 bo 后真实运行，检查来源原件字节、后续来源请求、storage/hrefs，以及桌面 / 手机、明暗主题截图。

## 保留的失败原件

| 记录 | 解释 |
| --- | --- |
| round1 完整 Core 中止 | 独立审查定位服务层范围与双异常问题后停止原测试树，随后修复并重新冻结；不计为通过。 |
| round2 smoke 创建失败 | 新 fixture 使用不存在的 `mode:browser`；改为受支持 `regression`，原件保留。 |
| round3 smoke 等待 start 元素超时 | 一次批准已消耗，`finally` 清空复核导致元素按设计缺席；新夹具重新复核后检查 disabled 与 POST 不增加。未改产品或原 D3 门禁。 |
| round5 完整 Core 中止 | 原 catalog 末栅栏失败后停止测试树及串行包装器，按本页修复后另建 round6。 |
| round6 因跨页启动竞态停止 | 完整 Core 已 2525 total / 2513 pass / 0 fail / 0 cancelled / 12 skipped；新 UI 9/9、原 D3 执行 16/16、原 Console、owned recovery 均通过。发现两页启动反例后停止串行包装器，managed UI 已开始但无完成 summary；修复后另建 round7，不将 round6 当最终通过。原新 UI 的 fresh 手机图仍为轮询更新前的 running/blocked，而 API 已 completed/passed；新 smoke 在截图前增加真实终态等待。 |
| 新 store 测试夹具失败 | 空目录清理错误使用 `rmSync`，改为 `rmdirSync`；产品代码不变。 |
| 新 HTTP pending harness 首跑期限不足 | 只将新夹具的整体 fetch 期限从 5 秒改为 30 秒；产品 POST 仍为 60 秒，原 D3 期限不变。 |
| 前端首轮 relation 断言失败 | 旧原件为 30 total / 27 pass / 3 fail，含父测试聚合失败；无 verifier 前后 SHA，原因未归因。保留分段输出说明；旧断言未改，后续冻结通过单独记录。 |

## 证据、发布与 CI

<!-- PUBLICATION_RESULTS -->
最终证据已发布到[证据目录](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/README.md)，[INDEX](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/INDEX.json)与[封存计划](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/publication-plan.json)固定输入、最终运行根、全部门禁及独立目视审查。42 组原件共 1608 文件，加 600 项冻结源码，ZIP 共 **2208 条目 / 41,301,374 bytes 展开内容**。公开目录共 16 文件，包含最终独立审查和四张截图的直接可读副本。

[完整 ZIP](../../archive/audits/2026-10-17/evidence/acceptance-browser-start-resolution/complete-evidence.zip) 为 **21,272,748 bytes**，SHA-256 `140a15f9759e2ddbdb390d14a80578719303329c990d6de618411937e2562128`。发布器逐项核验原件、重复读取全部输入，并回读 ZIP CRC / 每条 bytes 与 SHA。另一个不导入发布器的独立工具已通过工作区完整文件集、2208 条目、1608 原件、600 源码、12 门禁及四图目视记录核验；暂存时继续从 Git blob 核对同一源码与公开证据，不以工作区通过代替暂存字节验证。

失败和中断现场均按原件归档，7 个精确 `chromium-profile` 子树排除出包但仍保留本机。D3 已公开的 69 MB 包只引用，未重复嵌套。可读副本与封存计划集合必须完全一致；仅有一份审查 Markdown、机器等待目视状态或旧预检截图均不能满足发布合同。工作区 / 暂存核验记录另保留于本机 `d4-publication-20261017/`，不回写已封存原件。
<!-- /PUBLICATION_RESULTS -->

<!-- CI_RESULTS -->
父提交 `5d1de82` 自身 CI 已 success：run `39044519602`、attempt 1，三个 job 全通过；Core 2461 total / 2457 pass / 0 fail / 0 cancelled / 4 skipped，18 组后续 smoke 全 success，显式 Docker 2/2。原失败与修后 CI 的完整记录见[D3 CI 追加验收](acceptance-browser-d3-ci.md)。

本页与 D4 产品代码一同提交，不能预写推送后才产生的自身 CI。发布流程须另外核对远端精确 SHA、对应 Actions run 的 head SHA、全部 job / step 结论、完整 Core 和显式 Docker 原始日志；该结果在交付时据实报告，并于后续审计追加。父提交和本机通过均不代替 D4 自身 hosted Linux CI。
<!-- /CI_RESULTS -->

本片只保证当前真实数据根及保留事实的正常引擎重启。备份回滚、复制数据根、删除决定、突然断电后的 exactly-once 不在保证范围；Windows 文件 flush 不等于完整掉电耐久性。D3 与 D4 检查 verifier 保持不可比，连续 D4 pass 也不能将旧 D3 问题自动改为 `verified_passed`。来源已审兼容清单未扩充。全局 Browser approval / selection 与业务缺陷单最终关闭仍为后续建设。
