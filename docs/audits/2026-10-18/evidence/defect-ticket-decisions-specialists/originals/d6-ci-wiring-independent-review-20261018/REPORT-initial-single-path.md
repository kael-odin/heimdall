# D6 CI 接线独立只读复核

本复核未启动 Browser、engine、Core 测试或 CI。只读取当前维护文件、不可修改的原 CI 核验器和已有 D6 专项原件；只在 ignored `_runs` 中保存本记录与核验方案。当前接线未发现阻塞问题。新 CI 尚未据本复核获得通过结论。

## 保持原有验收口径

- 与 `41c359a62ecbb67ac15f38c51c95fa983a7492d3` 对比，Core 与 console job 的完整文本未变；job 仍是原来的三个名称和 ID。
- Core 的 20 项 smoke 命令与顺序逐项匹配不可修改 `verify-ci.py` 的 `SMOKE_COMMANDS`，Core timeout 仍为 45 分钟，Docker 原步骤与 env 保持。
- independent smoke 的尾部四个 run 仍依次为 `pnpm smoke`、三个原 benchmark。其 timeout 仍为 10 分钟。新增 always artifact 是 uses 步骤，不进入原工具的 run 序列投影。
- 只提取原 `workflow_runs` AST 函数做纯文本投影；没有调用旧工具 main。新增两个带显式名称的 D6 node 步骤可被原正则解析。原工具用 API 中每个 step 的动态 number 选择 ZIP 日志，增加步骤不会依赖旧固定编号。所有解析 run 步骤名在 job 内唯一。
- 原工具仍严格要求 attempt 1、push/main、原 workflow/repository、三个 job；本次未降低这些要求。若后续是 attempt 2，原工具将拒绝，这不是新 workflow 的兼容性回退。

## D6 当前 console 与真实核验

independent job 在 D6 前安装并构建当前 checkout 的 `console`；没有复用其他 job 的 dist。D6 smoke 的 engine 通过 `HEIMDALL_CONSOLE_DIR` 使用该 `../console/dist`，会检查 index 存在，并保存 12 项维护源码及完整 console bundle 的运行前后摘要。

D6 smoke 使用全新固定 OUT `workspace/_runs/defect-ticket-decisions-ci`；其后独立 node 步骤运行当前维护 `verify-acceptance-defect-ticket-decisions-console.mjs`。该核验器只读原件，严格检查四个 A/B/C/D case、原始 UI body、CDP/Playwright 完成事件、单上游请求、赢家事件顺序、永久决策字节、源文件原件、13 项总检查和截图。旧 CI verifier 只确认 D6 run 步骤执行与日志一致，不独立理解其产物语义，因此新 artifact 必须另跑维护 strict verifier。

## Artifact 完整性

`if: always()` 位于同一 independent job，上传 `core/workspace/_runs/defect-ticket-decisions-ci/**`，匹配实际 OUT。即使 smoke 或 strict verifier 失败，上传仍有机会执行；`if-no-files-found: error` 不会把缺失证据默认为成功。只有 job 被硬终止/超时等情况仍可能没有产物，不能将这种情况记作已验收。

官方 actions/upload-artifact README 当前说明：glob 的第一个通配符之后保留目录层级，隐藏文件默认忽略，隐藏路径按点前缀定义。这里的固定前缀为实际 OUT，ZIP 可将 summary/case/runtime 作为根内容，下载后仍需探测实际唯一 evidence root，不能只凭绝对旧路径。

现有成功样本 `defect-ticket-decisions-console-smoke-20261018T093910120` 的原件读回：439 文件，仅一个隐藏文件 `runtime/acceptance/.acceptance-owner.json`；源 run 的 29 个摘要路径没有隐藏项。该 owner 标记不属于 strict verifier 的输入。summary、case 原始 body、decision、ingress/relay、CDP/Playwright、图片与源 run 原件均不依赖隐藏文件。当前默认 hidden 策略不会漏 strict 关键证据。此样本仅为现有本地 D6 专项，不能用作新 CI 运行结果。

官方 README 来源：`https://raw.githubusercontent.com/actions/upload-artifact/main/README.md`，本次读取 SHA256 `82e3d7226dabea938b107b93e015aa816150d6894fff631064aa2884c26771f7`；相关行 106-110、184-198、432-451。

## 新 CI 完成后的独立 supplement 方案

1. 原 capture/verify 工具保持原字节，按其已有受审入口捕获新完整运行，并继续要求其严格 acceptance。保留原工具输出、完整 raw logs、API、workflow-at-head 和各项 SHA。
2. 新建 ignored supplement 目录，接收显式 `repo/run/head/attempt/artifactId`。先核对 Run API、Jobs API、原 capture 身份：相同完整 head、run ID、attempt、push/main、workflow CI，以及全部三个 job 的真实终态。D6 两步骤和上传步骤均须 success。
3. 从该运行列出的 artifact 中精确选择 `manual-defect-ticket-decisions-<attempt>`，禁止只按全仓最新名称查询。绑定 artifact ID、workflow_run.id/head_sha、name、expired、size 和 API digest（若提供）。保留下载命令精确 argv、退出码、raw stdout/stderr、原 ZIP 字节数与 SHA256。
4. 先检查 ZIP CRC、唯一规范相对路径、无目录穿越、无 symlink/特殊项；解压到新的唯一目录，不覆盖已有原件。保存 ZIP 每项 bytes/SHA 与解压逐字节核对清单，确定唯一 D6 evidence root。
5. 将 artifact 的 12 源码摘要逐项对应到该 head 的 Git blob；before/after 必须一致。维护 strict verifier 自身 bytes/SHA 必须对应同一 head，当前维护版本若漂移应拒绝混用，另保留经 head 身份确认的独立副本。记录该 checkout 的 console build 步骤日志与 bundle 摘要，不能把另一构建的 dist 作为此 head 证明。
6. 使用 Node 22 运行受审维护 strict verifier，仅传 artifact evidence root。保留命令 argv/cwd/Node 版本/起止时间/退出码/完整 stdout 和 stderr 及 SHA。运行前后对解压原件逐项 hash，必须不变；绝不改 summary 的 Linux 路径或任何正文来迎合核验器，也不启动 Browser、engine 或目标请求。
7. Supplement 输出独立 JSON/Markdown，分别列原完整 CI 验收、D6 artifact 身份与完整性、维护 strict verifier 结果。只有各项全通过才宣布新 head 的 D6 CI 产物核验通过；原41 failure与历史17/17始终保持原范围。不得通过修改旧 verifier 消除失败。
