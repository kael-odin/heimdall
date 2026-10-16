# 托管 Spec 准备内核证据

本批对应[实施验收](../../acceptance-managed-spec-preparation.md)与[合同指南](../../../../competition/acceptance-managed-spec.md)。准备 smoke 使用已归档的真实 B2.1 材料副本、真实数据根 owner 与本地 HTTP 计数夹具，直接调用私有准备内核。它没有启动引擎、Browser 或 Spec executor；owner 释放再取得不能称为引擎重启验收。

| 文件 | 证明范围 |
| --- | --- |
| [quality-gates.json](checks/quality-gates.json) | 全量、专项、语法、准备 smoke 与原基线浏览器回归汇总 |
| [focused-tests.txt](checks/focused-tests.txt) | 计划、sidecar、目录集成、来源和基线的完整专项输出 |
| [core-tests.txt](checks/core-tests.txt) | 本轮最终全量摘要；大日志留在 ignored 运行目录 |
| [source-file-digests.json](checks/source-file-digests.json) | 本轮实现、测试与命令的 LF 规范化源码摘要 |
| [checks.json](preparation/checks.json) | 21 项准备、幂等重放、来源和无执行检查 |
| [prepared-record.json](preparation/prepared-record.json) | 原字节不可变准备记录，runId / taskId 仅预留 |
| [fixture-source-sha256.json](preparation/fixture-source-sha256.json) | tracked B2.1 两个 source run / 14 文件的来源和摘要 |
| [source-checkpoints.json](preparation/source-checkpoints.json) | 准备、重放、移动来源、owner 重新取得后的 SHA 不变 |
| [catalog-checkpoints.json](preparation/catalog-checkpoints.json) | 准备与重放不改目录 head / previous；取消是独立目录写操作 |
| [run-checkpoints.json](preparation/run-checkpoints.json) | 没有新 run、没有预留 run 目录 |
| [replay-results.json](preparation/replay-results.json) | 同键原记录与固定 ID，取消和来源不可读后不重新准备 |
| [fixture-requests.json](preparation/fixture-requests.json) | 本地目标请求与 fetch 尝试均为 0 |
| [baseline-browser-checks.json](checks/baseline-browser-checks.json) | B2.1 原界面真实 worker / Chromium 回归，13 项检查 |
| [async-guard-probe.json](checks/async-guard-probe.json) | 误传 async guard 的独立前后探针，旧处理 1 次未处理拒绝，当前 0 次 |

原始来源只引用[已入库的 B2.1 run 文件](../acceptance-baseline/console/run-evidence/)，本批不再复制一套。原始 run 与准备 envelope 都按原 bytes 保存；只有源码摘要和文本日志进行已说明的 LF / 行尾空格规范化。

最终发布前的回归明确覆盖：最后一轮 temporary 读取时来源改变会拒绝；业务 guard 后到 link 前不再读取临时文件或历史派发记录正文；guard 改写临时文件或新增目录条目会受阻；发布后异常保留原件并要求按原 operationId 对账。这些是列明时序的故障注入，不能扩展为跨文件原子事务、目录断电持久或管理员不可篡改保证。

本地原始大日志和完整浏览器截图保留在 `core/workspace/_runs/acceptance-managed-preparation-*`。B2.2-b 的执行、停止与恢复，以及 B2.2-c 的控制台闭环继续单独验收。
