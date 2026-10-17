# D5 自身 CI 超时与双核测试调度修复

日期：2026-10-18。D5 精确提交 `a0f834ebe727d6d00e2d692a008d3d0512a56536` 的 Linux CI run `39072135745`、attempt 1 为 **completed / cancelled**。本记录补充[原 D5 本机验收](acceptance-defect-tickets.md)之后发生的 CI 事实；原本机门禁和公开包不重写。

## 已核实的取消原因

GitHub check-run `117511756157` 的 [annotations 原件](evidence/defect-ticket-ci-timeout/timeout-annotations/annotations.json)明确记录：`The job has exceeded the maximum execution time of 45m0s`。这项原因由 GitHub 原件确认，不能将整轮结果写为通过。

| 范围 | 真实结果与 UTC 时间 |
| --- | --- |
| core (lint + test) | cancelled，2026-10-17 21:43:26–22:28:46 |
| Core 全量测试 | 2661 total / 2657 pass / 0 fail / 0 cancelled / 4 skipped / 0 todo；21:44:33–22:18:42；原 TAP duration 2047064.490832 ms |
| 前 19 项 Core acceptance smoke | 全部 success，包括 D2 候选、D3 执行、D4 启动决定 |
| 第 20 项人工缺陷单 D5 smoke | cancelled，22:27:54–22:28:42；没有 terminal summary，未证明通过 |
| Docker offline delivery | skipped，没有执行证据 |
| 失败诊断上传 | skipped；原 `if: failure()` 未在取消时执行，不能声称已有完整远端文件系统现场 |
| core (e2e smoke, local fixture) | success，含 forge 与三组 acceptance benchmark |
| console (build) | success |

[完整失败归档](evidence/defect-ticket-ci-timeout/README.md)保留 96 份原文件的字节，包括 run / jobs、完整 stdout、原 ZIP 与提取日志、原独立核验输出、两份新读出的 check-run / annotations，以及未修改的采集和核验工具。复制内容共 5,196,054 字节，逐文件来源、长度与 SHA256 见[清单](evidence/defect-ticket-ci-timeout/manifest.json)。另有本目录说明、Git 原字节属性和清单文件。

独立核验真实 exit 1：`passed:false`、`captureComplete:false`、`identityMatches:true`、`executionAccepted:false`，共 312 项检查。未执行的 Docker 没有 step log，D5 无终态摘要，run / job 被取消；这些结果按原工具保留，不能通过修改工具将失败转成通过，也不能据 `captureComplete:false` 单独推断原日志已经损坏。

## 最小调度修复

原 `core/scripts/test-core.mjs` 默认文件并发为 `max(1, min(4, P−1))`，其中 P 为 `availableParallelism()`。双核只得到 1 个文件进程；该次全量测试已消耗约 34 分钟，后续串行 smoke 的预算不足。

旧 run 的原日志没有记录实际 CPU 数量或 `availableParallelism()`，不能仅凭 `ubuntu-latest` 标签断言该次实测 P=2，也不能把这个调度候选写成已经证明的唯一性能根因。GitHub annotation 证明的是 45 分钟超时；调整是否有效须由新提交自身的实际 Linux CI 证明。

本次只把 P=2 的默认值调整为 2；其余映射不变：

| 可用并行度 P | 原默认 | 修复后默认 |
| --- | --- | --- |
| 1 | 1 | 1 |
| 2 | 1 | 2 |
| 3 | 2 | 2 |
| 4 | 3 | 3 |
| ≥5 | 4 | 4 |

保留两种显式 CLI override、4 个默认进程上限、单次 Node 调用、进程隔离和维护目录顶层的原 229 个测试文件集合。未改 workflow 的 45 分钟时限、20 项 Core smoke 顺序、断言、单项 timeout、错误过滤、历史指纹或兼容清单；原八个受保护 verifier 原字节保持。

## 本机验证

实际维护 driver 已经通过 11 组调度检查：P=1/2/3/4/5/64、两种并发参数写法、任意显式覆盖及额外参数顺序、非零子进程退出码、子进程没有退出状态的失败传播。检查通过 ESM loader 仅替换 `os.availableParallelism` 与子进程调用，实际运行维护 driver 并读取真实顶层测试目录；它不冒充完整测试执行，也未往维护套件新增测试。结果位于 ignored `core/workspace/_runs/ci-small-runner-20261018/policy.json`。

Windows / Node 25 的完整 Core 并发 2 于 2026-10-17 22:34:23.162194–23:15:06.800934 UTC 执行，真实 exit 0。唯一原生统计为 **2661 total / 2649 pass / 0 fail / 0 cancelled / 12 skipped / 0 todo**，duration 2443530.4189 ms，约 40 分 43.5 秒。语法与该轮文档链接检查均 exit 0，列入冻结清单的 **614 个维护文件**前后未变。维护输入的具体范围以清单为准，不把生成产物或运行现场称为完整静态输入。

本机[证据入口](evidence/ci-small-runner-local/README.md)保存原始 Core 输出、11 组调度记录、输入前后摘要、构建、运行时和发布后链接检查结果。12 个本机跳过与 Linux 的 4 个跳过分别核对；本机耗时不构成跨平台提速证明。

失败 CI 公开归档已按 manifest 将通用 `*.log` 忽略规则排除的原件逐项补入 Git 索引；96 原件在来源、磁盘、索引三方长度与 SHA256 一致，加上旧八 verifier 共 **104 项字节检查通过**，独立只读复核结果一致。原日志空白和 CRLF 报告保持原字节，只对本归档的原 log / txt 与指定 REPORT 禁用文本 diff；README、JSON 和工具继续保留正常文本 diff。

静态隔离审查未发现默认配置下明确必须串行的跨文件共享写冲突；条件性的 `PORT` 继承、端口预选窗口和 Chromium 资源竞争仍需实际执行验证。不能从并发值宣称耗时减半或稳定性已经证明。

## 修复提交自身的 Linux CI

本记录在提交前冻结。推送后须以修复提交的精确 SHA，另行采集其自身 Linux CI 的 workflow / run / attempt、完整日志与独立核验；只有三个 job、全部 20 项 Core smoke（含 D5）和 Docker 实际成功后，才可报告该提交 CI 通过。该次结果按实际完成时点报告并由后续切片归档，不反复回写同一提交造成 SHA 变化。D5 原取消记录不能由后续通过覆盖。

D6 人工动作永久拒绝仍未在本切片实施。当前已进入未知状态的人工操作仍只允许 GET 核对；缺少原件的 `unresolved` 不能解除本机原确认。
