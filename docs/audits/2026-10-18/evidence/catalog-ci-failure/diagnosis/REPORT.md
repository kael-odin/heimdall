# 41c359 Catalog smoke 失败原件与只读诊断

本记录绑定 `kael-odin/heimdall`、run `39082419484`、attempt `1`、commit `41c359a62ecbb67ac15f38c51c95fa983a7492d3`。原 CI 终态为 **completed / failure**。这里没有重试 CI，也没有启动 Browser、engine 或 Core 测试；没有修改维护源码、workflow、原采集/核验工具。

## 已确认的结果

- 完整 Core TAP：2661 tests / 2657 pass / 0 fail / 0 cancelled / 4 skipped，duration 1665894.745146 ms。前轮 named-session case 本轮为 `ok 1975`，不能继续称其为本轮失败。
- console build 和 core e2e local fixture 两个 job 成功。core lint+test job 的 step 12、13、14 成功；step 15 catalog smoke 在脚本 line 312 等待时失败。
- step 16–31 的 16 项后续 acceptance smoke 与 step 33 Docker 被跳过。没有 D5 终态摘要；Core 成功不代表整轮 CI 成功。
- 原采集 exit 0 仅表明采集命令完成。原核验 exit 1、263 checks、45 failed；身份匹配 true，执行验收 false。45 个失败由 execution 28 和 capture 17 构成；capture 17 均为上述 skipped 步骤没有独立 step log。保留 `captureComplete:false` 原结论，这本身不证明下载日志损坏。
- 原核验 REPORT 的 D5 固定说明文字不是本轮成功证据，实际 D5 summary 为空且步骤 skipped，应以原 verified-summary 与 checks、GitHub step 终态为准。

## 原件身份与下载校验

原工具未改动：

|工具|bytes|SHA-256|
|---|---:|---|
|capture-v2.py|11710|f0727a28d924f6672988161257fcb243a5572f124b3eeb1819d139374a7b7950|
|verify-ci.py|26998|071aebb1ce4ba28aa2e615560cb2997444e0365a0a39eaa64dbfc77f4ab97be3|

原 final 目录为 `../d5-ci-20261018/final-20261018T005401.151239Z`，73 文件 / 4758605 bytes；原 verification 目录为 `../d5-ci-20261018/verification-20261018T005440.596276Z`，4 文件 / 106986 bytes。加两原工具共 **79 文件 / 4904299 bytes**。逐文件 SHA 见本目录 inventory；归档时应逐字节复制并由根代理复核，不覆盖原件。

唯一上传 artifact：`12120555294 / acceptance-catalog-failure-1`。下载原 ZIP 共 **149526 bytes**，SHA-256 为 `7c02655c6ce6c013ea99c55eed28963fb448316bbe86624264c47b5718ae4ab9`，与 GitHub API 和 upload 日志一致。ZIP CRC 检查通过，解压前检查相对路径、目录边界和符号链接，提取 7 文件。原 ZIP、API JSON、stderr、命令 argv 和每文件 bytes/SHA/CRC 均保留；见 `artifact-integrity.json` 与 `capture-commands.json`。

## line 312 实际在等待什么

精确提交的 smoke line 294–300 用 `route.fetch()` 提交 release POST，保留服务端响应，等待测试 gate 后 `route.fulfill()`。line 303 已验证服务端状态 201，line 310–311 已验证 route delivery 成功，然后 line 312–316 等待 catalog notice 含“延迟响应版本”。错误为 `Catalog smoke timeout: state not reached`，不是可见 catalog error 断言失败。

原 `failure.json` 保存 61 条 catalog response/requestfailed 记录、27 条 API case、8 项已完成 catalog check，记录数未触及 200 cap。最后记录为提交到 UI 创建项目的 release POST 201；之后没有目录列表 GET 的 response 或 requestfailed 记录。当前日志没有 request-start、requestfinished 或响应体读取阶段，因此“没有后续响应记录”不能替换成“请求没有发出”。

原 `failure-ui.json` 与截图相互吻合：

- selected project 为 `ap-9ca2f3fb-1fec-44f4-b7af-02e8fcf0dc6b`（切换后的原项目）。busy 为 true，notices/errors 均为空。
- 原 HTML 的刷新按钮为“正在读取…”，project select 带 disabled；精确模板确认 `listLoading=true`。
- release 提交按钮为“正在登记…”，精确模板确认 `writing='release'`。
- 未出现“正在读取所选项目…”提示，已有当前项目 detail 仍可见。原截图中“当前项目未提交草稿”仍可见。这只是失败快照事实，不能冒充 line 317–320 尚未执行的最终断言。

精确 Vue `mutate` 在 line 204 `await refreshCatalog()`，line 208 才写入提交成功 notice，line 215 finally 才清空 writing。`refreshCatalog` 在 line 130 设置 listLoading，line 132 await 目录列表 transport，再在 line 141 await 当前项目详情；line 154 才清理 listLoading。因此最小可证实定位为：**release 已收到提交确认，失败快照仍处于写后刷新未终结的阶段；现有原件不足以判定 HTTP/解析的具体停点。**

`requestAcceptanceCatalog` line 84 await fetch，line 92 await response.json，均没有自身完成期限；调用传入 AbortController，但仅新读取、项目切换或卸载触发相关 abort。该静态事实说明一个未 settle 的读取能够阻塞 busy/notice，不证明原 CI 就是具体某种网络挂起。

原 engine 日志只有启动信息、SQLite 实验提示，以及用于双引擎所有权测试的两条 `ACCEPTANCE_OWNER_UNAVAILABLE`；没有 HTTP 请求开始/完成信息。项目切换期间的 ERR_ABORTED 与该测试主动 abort 旧读取相符，不能仅凭这些记录定性产品缺陷。

## 最小假设与证据缺口

可验证假设 H1：写后目录列表读取未 settle，使 `mutate` 无法到达 notice/finally。原 UI 状态与代码路径支持该定位，但原日志没有足够阶段信息来区分：浏览器未真正发出请求、请求被路由/连接调度挂起、服务器未返回、响应体未结束，或后续详情读取被取代。当前没有证据证明服务端死锁、runner 变慢、notice 被覆盖、草稿丢失或与前轮 named-session 同根因。

不得通过扩大 wait、弱化 notice 断言、修改 verifier 或重跑原 CI 来替代定位。

## 受控复现方案（仅方案，尚未执行）

1. 根代理安排单一 Browser/engine 窗口，以精确 commit 的独立 ignored 副本跑一次带观测版本。保持原 UI 操作、断言与 25000ms wait；记录诊断副本 diff/hash，与原 CI 分开标识。页级 observers 记录所有 catalog `request`、`response`、`requestfinished`、`requestfailed`，用 request identity、method/path、单调时间串联，不设 200 cap。同步记录 post gate、route.fetch 返回、fulfill 返回和失败快照时刻。
2. 若原现象出现，保留失败瞬间 DOM/截图、未完成 request identity，并在原 teardown 前做单次只读目录 API 探针。探针只能判断此时独立连接是否响应；不能代表原请求阶段。Browser fetch/json 细分观测如需加入，应做第二个独立实验并标识可能的时序影响，保持返回值和异常语义。
3. 受控对照 A：只暂停写后列表 GET 的交付，确认能否得到相同 listLoading/writing/no-notice 状态；释放 gate 后验证写入 notice、busy 清理、项目选择和草稿。该对照只证明状态模型可复现，不能证明原 CI 根因。
4. 受控对照 B：列表 GET 正常、只暂停随后详情 GET，对比原 UI 提示和网络轨迹；释放后验证相同收尾。受控对照 C：确定性 reject 写后 GET，验证已有已提交实体会标为需核对、无自动 POST 重发，保留当前草稿。
5. 先依据阶段轨迹选择最小维护修复及语义回归，不把离线模型或新本机通过转换为原 CI 通过；Browser 调度和任何维护变更由根代理决定。

精确源文件字节与 git blob/SHA 已保存在 `source-at-41c359/`、`source-identity.json`，确保后续 D6 工作不会污染这次诊断引用。
