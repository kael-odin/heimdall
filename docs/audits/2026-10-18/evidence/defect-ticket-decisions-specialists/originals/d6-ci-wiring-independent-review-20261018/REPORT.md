# D6 CI 接线独立只读复核

本轮仅静态读取维护文件、原 CI 核验器和已有专项原件，没有启动 Browser、engine、Core 测试、CI 或新补充核验器。当前双路径接线通过 9 项原 CI 文本 / AST 合同和 6 项 artifact 合同；这不等于新 CI 已运行或通过。

## 本版与初版

初版单路径复核的原字节保留为 `REPORT-initial-single-path.md`，原输入清单 `reviewed-inputs.json` 不改。当前补充在 `artifact-dist-update.json`。新版 workflow 为 11058 bytes，SHA256 `b365fc4123cb182f4c86d494454c9017bdfe4ade3fecf52919da673bb9690dfd`。相对初版 11 项输入，仅 workflow 与维护 strict verifier 有变化；其余 9 项 bytes / SHA 保持。

## 原 CI 门禁和原八文件

- 与 `41c359a62ecbb67ac15f38c51c95fa983a7492d3` 对比，Core 与 console job 完整文本未变，仍是原三个 job ID。
- Core 的 20 项 smoke 命令和顺序逐项匹配不可修改 `verify-ci.py` 的 `SMOKE_COMMANDS`；Core timeout 45 分钟，Docker 原步骤与 env 保持。
- independent smoke timeout 10 分钟，末四项 run 仍为 `pnpm smoke` 和原三个 benchmark；两个新增 D6 node 命令可由原 `workflow_runs` 正则读取，解析步骤名称在各 job 内唯一。只提取该函数的 AST 做纯文本投影，没有调用旧工具 main。
- 原 CI 工具仍要求 attempt 1、push/main、原 workflow/repository 和三个 job，未降低任何要求。
- 按 `old-eight-raw.json` 指定的基线 `5006e16bf73e47f36877da24df4ac4a5c8207965`，本轮重新直接读取 8 文件的 baseline / HEAD / index / worktree 原字节，32 份字节均逐项相等，SHA 与原清单一致。没有解码或换行归一化。

## 当前 D6 与 bundle 来源绑定

independent job 在 D6 前安装并构建同 checkout 的 console，再运行 smoke 和维护 strict verifier。当前 strict verifier 的第 53–80 行除了要求 before / after 摘要相等，还重新读取本目录的 12 个固定源码文件及递归 `console/dist`，要求 bytes / SHA 与 evidence 摘要完全相同；拒绝 symlink、非普通文件和多链接文件。因此离线读取 CI 原件时必须使用精确 head 的原始 Git blob，并放入同一次 artifact 的 dist，不能用本机 dist 或重新 build 代替。

维护 strict verifier 继续检查四个 A/B/C/D case、原 UI body、CDP / Playwright 完成、单上游请求、赢家事件顺序、永久决定字节、来源原件、13 项总检查与截图。旧 CI verifier 只理解 run/log 门禁，D6 语义仍需维护 strict verifier 独立核验。

## 双路径 artifact 静态合同

上传步骤在同一 independent job，`if: always()`、`actions/upload-artifact@v7`、名称 `manual-defect-ticket-decisions-${{ github.run_attempt }}`、`if-no-files-found: error`、保留 7 天均逐项匹配。仅有两个路径：

```text
core/workspace/_runs/defect-ticket-decisions-ci/**
console/dist/**
```

两路径的共同祖先是仓库根；根据本次路径和此前已阅读的官方 action 层级规则，预期 ZIP 固定包含以下两个根。这是静态布局推断，尚未下载新版 CI ZIP：

```text
core/workspace/_runs/defect-ticket-decisions-ci/summary.json
core/workspace/_runs/defect-ticket-decisions-ci/case-A/...
core/workspace/_runs/defect-ticket-decisions-ci/runtime/...
console/dist/index.html
console/dist/assets/...
```

初版只上传 OUT，无法取得同次 CI dist 原字节；新版显式上传 dist 解决了这一接线缺口。仍须从实际 ZIP 核对文件全集与摘要，不能凭本段宣称真实 CI 原件已齐全。`always()` 让前步失败时仍有机会上传，硬终止 / 超时可能没有 artifact，必须按缺失记录。

初版样本中的唯一隐藏 owner 标记不是 strict verifier 输入。当前本机 dist 静态枚举 8 文件，没有隐藏路径；该枚举只描述当前目录，不代替新 CI ZIP 的文件核验。官方 README 既有读取来源与 SHA 仍保留在初版记录。

## 新 CI 完成后的 supplement 方案

1. 保持原 capture / verify 工具字节和入口，捕获新完整运行并要求严格 acceptance，保留 raw logs、API、workflow-at-head、工具输出与 SHA。
2. 接收显式 repo / run / head / attempt / artifactId，绑定 Run / Jobs API、原 capture 的同一完整 head、run、attempt、push/main、CI workflow 与全部三个 job 终态；D6 两步骤和上传步骤都须 success。
3. 仅从该运行列出的 artifact 选择精确 ID 和 `manual-defect-ticket-decisions-<attempt>`，保存 API metadata、精确 argv、退出码、stdout / stderr、原 ZIP bytes / SHA，并核对可用 API digest。不能查询全仓最新同名产物。
4. ZIP 先过 CRC、规范唯一相对路径、无目录穿越 / symlink / 特殊项，解压到唯一新目录并逐项核对 bytes / SHA。要求 D6 evidence root 恰为 `core/workspace/_runs/defect-ticket-decisions-ci`，dist root 恰为 `console/dist`，ZIP 文件只来自这两个固定根；拒绝包装目录和额外来源。
5. 12 源码摘要逐项对应同 head 的原始 Git blob，before / after 完全一致。隔离布局仅写这些 blob 和同 ZIP 的 dist；dist 文件全集及每项 bytes / SHA 必须与 `consoleBundle` 完全相同，保存同 job build 原日志。维护 verifier 也必须是该 head 的相同 Git blob，不改写源码、Linux 路径或 evidence 正文。
6. 使用 Node 22 在上述隔离布局运行未改写的维护 strict verifier，只传 artifact evidence root。保存版本、cwd、完整 argv、起止时间、退出码、完整 stdout / stderr 与 SHA；对原 capture、原 ZIP、解压原件和隔离布局做前后原字节核对。不得启动 Browser、engine、目标请求或 build。
7. 独立 JSON / Markdown 分列完整 CI、artifact 身份 / 完整性、Git blob / dist 来源和 strict verifier；全通过才宣布精确 head 的 D6 CI 产物验收通过。原 41 failure、历史 Linux 17/17 和本地专项均保留原证据范围。
