# 托管 Spec 执行证据

对应[实施报告](../../acceptance-managed-execution.md)。本目录保存真实 HTTP / CDP 流程与最终质量门。原来源仍为未批准草稿，经过真实目录绑定、候选、批准及选用后，专用执行入口对明确目标版本进行检查；完整链路与下载 bytes 随同证据保存。

Browser plugin / browser skill 未在本会话提供，使用仓库 Playwright 与 Chromium `connectOverCDP`，记录 `Browser plugin not available`。控制台执行按钮尚未实现，浏览器从专用 HTTP 发起，既有页面观察运行与结果。

初次运行与最终运行分目录保留。`cdp-first` 发现 UI JSON 重新序列化导致末尾换行丢失，失败记录保留；修复后必须在新目录完成原字节下载与取消后再计通过。初次 engine TAP 位于相邻 `managed-execution-engine-first`，其中目标基路径及旧 triage 503 合同的测试假设已校正；重复或失败轮次不加到最终总数。

| 证据 | 含义 |
| --- | --- |
| [最终浏览器检查](cdp-final/browser-checks.json) | 4/4 真实执行检查组、pageErrors=[]、目标 3 / 模型 0；明确 executionUiImplemented=false |
| [缺陷概览](cdp-final/managed-execution-completed-overview-desktop.png) | 2 项已测、1 项 BUG、原 failed gate；运行正常结束 |
| [取消后页面](cdp-final/managed-execution-cancelled-desktop.png) | 详情与历史均显示中断；不显示完成报告 gate / triage |
| [浏览器回归清单](regressions/results.json) | 10/10 命令；8 个既有验收浏览器、原克隆 CDP 与 1 个私有准备，后者不计浏览器 |
| [正式 Core 全量](gates/core-final.tap) | 1797 total / 1789 pass / 0 fail / 8 skip，459491.5178 ms；正式入口默认最多 4 并发 |
| [最终精确夹具引擎测试](gates/engine-final.tap) | 6/6，42525.244 ms；最终 fixture 仅新增失败诊断，不改业务断言 |
| [Linux POSIX 摘要](linux-final/summary.json) | 当前最终 fixture、真实 SIGTERM、1/1、0 skip，626.640437 ms；479 个源码和依赖文件前后不变 |
| [Linux 原始 TAP](linux-final/graceful-shutdown.tap) | code=0、ENGINE_SHUTDOWN、无 report、目标 abort、重启不重发 |
| [源码字节清单](source-files.json) | 本轮 18 个修改 / 新增源码与测试的 worktree 原字节 SHA，十源 verifier 与基线完全相同 |
| [质量门摘要](validation-summary.json) | 从正式 TAP 与浏览器 JSON 提取的当次数据；重复补跑不累加 |

`gates/lint.log`、[build.log.gz](gates/build.log.gz)、`smoke.log`、`docs-links.log` 保存常规门禁；build 仍有既有 chunk 大小提示。Vite 输出也含原始行尾空格，采用同一无损压缩与往返核验方式。源代码和运行证据单独保存，没有将依赖树或 Linux payload 写入 Git。

[首次误递归 TAP](gates/core-discovery-first.tap.gz) 是未完成的首次误递归运行，包含 ignored 历史副本的缺依赖 / 原件错误，不能作为当前维护 suite 的统计。[首次默认并发 TAP](gates/core-default-concurrency-first.tap.gz) 是限定维护 suite 后、尚未限制桌面默认高并发的失败轮次（1797 total、1 fail）。取消后新操作返回 202，旧日志仅有早期 fetch 错误且引擎未退出，尚不能确定超时根因。最终受控并发全量和精确夹具复验通过；等待与业务断言没有放宽。

上述两份 TAP 与初次引擎的 [fresh TAP](../managed-execution-engine-first/engine-tests-corrected-fresh.tap.gz)、[首轮 TAP](../managed-execution-engine-first/engine-tests.tap.gz) 含原始缩进空白行，使用无损 gzip 保留全部字节，避免改写原输出或降低 Git 空白检查。[压缩清单](tap-archives.json) 记录原字节长度、原 SHA256、压缩 SHA256 与解压往返核验；未压缩副本保留在 ignored 本轮运行目录。

最终 CDP 与前一 authoritative-download 轮次逻辑均通过；`cdp-final` 额外等待左侧历史轮询更新后再截图，保证中断详情与历史一致。正式全量后，失败诊断夹具发生一次不改变行为的增强；最终六项 engine 与 Linux 单项分别使用该精确版本复验。CI 由 main push 触发并按新 SHA 独立核对，不使用父提交成功替代。

后续 CI 核对：[main `2737c76` 的独立运行](ci-main-2737c76/README.md)已全部 success；Linux Core 1797 项 / 1793 pass / 4 skip，POSIX SIGTERM 实测，Docker 独立步骤 2/2。该结果仅适用于此后端提交。
