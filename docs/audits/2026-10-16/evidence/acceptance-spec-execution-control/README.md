# Spec 执行控制证据

本目录保留 2026-10-16 至 2026-10-17 的私有 runner 控制、物理只读操作核对、兼容审查及 CI 修复证据。[实施记录](../../acceptance-spec-execution-control.md)说明结果和限制。本批没有启动托管 executor，也没有新增托管 HTTP / 控制台入口。

| 内容 | 入口 | 可证明的范围 |
| --- | --- | --- |
| 最终本机门禁 | [quality-gates.json](checks/quality-gates.json)、[完整测试](checks/core-tests.txt)、[扩大专项](checks/focused-tests.txt) | 此源码批次的本机结果；Docker 本机跳过另列 |
| 源码与证据摘要 | [源码摘要](checks/source-digests.json)、[证据摘要](checks/evidence-digests.json) | 指定源码 bytes、原始来源和归档文件身份 |
| 准备与只读核对 | [25 项检查](preparation/checks.json)、[概要](preparation/quality-gates.json)、[来源摘要](preparation/fixture-source-sha256.json)、[准备原字节](preparation/prepared-record.json) | 真实 owner 释放再取得、同键重放、14 个原文件不变；零 fetch / 目标请求 / 新 run |
| 精确 verifier 与旧来源 | [精确支持集](compatibility/verifier-review.json)、[新旧 runner 对照](compatibility/legacy-current-comparison.json)、[独立专项](compatibility/focused-tests.tap) | 保留旧 LF / CRLF 两值并追加已审新两值；HTTP 结果、事件与证据兼容；CI 不依赖旧 Git 对象 |
| 独立控制审查 | [概要](independent-control-review/review-summary.json)、[事件等待](independent-control-review/events-fixed.json)、[祖先固定](independent-control-review/query-pin-fixed.json) | pending 事件 / reader / cancel、sticky 控制失效、心跳与目录身份；修前失败探针不作修后通过证据 |
| 普通 Spec 浏览器回归 | [17 项检查](spec-console/browser-checks.json)、[桌面截图](spec-console/acceptance-spec-desktop.png)、[390px 截图](spec-console/acceptance-spec-mobile.png) | 普通控制台明确批准、worker / 报告 / 刷新恢复，无页面错误；不是托管执行闭环 |
| 原镜像 CDP 回归 | [实际结果](cdp/cdp-real-forge.json)、[控制台截图](cdp/cdp-console-forge.png)、[镜像截图](cdp/cdp-clone-artifact.png) | 真实 Chromium 通过 CDP 操作控制台，task done、镜像 200 |
| 原提交 CI 失败 | [完整终态](checks/ci-a45c8ae.json)、[两项失败摘录](checks/ci-a45c8ae-failures.txt) | `a45c8ae` 自身失败；下游验收 smoke / Docker 未执行 |
| Linux inode 修复 | [修前](ci-repairs/linux-inode-reuse-before.tap)、[同探针修后](ci-repairs/linux-inode-reuse-after.tap)、[Linux 30 项](ci-repairs/linux-dispatch-tests.tap)、[Windows 30 项](ci-repairs/windows-dispatch-tests.tap) | ext4 原 inode 重用与误删被复现；保留活跃只读句柄后替换文件不被删除 |
| 清理独立故障注入 | [11 项专项](ci-repairs/independent-anchor-review.tap)、[4 项故障结果](ci-repairs/independent-anchor-faults.json) | 写入、fsync、写句柄关闭后抛错禁止发布；最终 pin 关闭后抛错保留已接受结果 |
| 周期截图碰撞 | [真实结果](ci-repairs/dynamic-phase/results.json)、[9 项回归](ci-repairs/browser-runner-tests.tap) | 同相位 stability=1，异相位约 0.736；测试显式控制相位，生产阈值未改 |

完整大日志和临时探针原件位于本机 ignored `core/workspace/_runs/`。这里保留的 `.probe.mjs.txt` 是探针源码证据，路径针对当时的本机实验环境；常规可重复门禁使用仓库内正式测试和 smoke 脚本。归档文本使用 LF；证据摘要分别记录归档 bytes 与原文件 bytes / SHA，并标明 CRLF → LF 转换，以及个别日志 / 提取源码尾部空白的整理。prepared record 原本为 LF，保持其原字节摘要。提交前再次检查固定源码和 14 个历史来源的原始摘要。

本目录中的准备 record 仅预留 runId / taskId，不能据此发起执行。事件与文件系统故障注入只证明列出的时序；已开始的 I/O、远端请求和任意自定义 close wrapper 的不确定结果不能由此声称已撤销。
