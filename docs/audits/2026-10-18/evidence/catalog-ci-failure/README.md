# 41c359 精确 CI 的失败原件

本目录绑定 `kael-odin/heimdall`、run `39082419484`、attempt `1`、commit `41c359a62ecbb67ac15f38c51c95fa983a7492d3`，终态为 **completed / failure**。归档不改变该结论，不重跑原 CI，不改原采集或核验工具。

| 原件 | 内容 |
| --- | --- |
| [CI final](final-20261018T005401.151239Z/capture-summary.json) | GitHub run / jobs、完整 stdout、原日志 ZIP、逐步日志、精确提交 workflow 与采集过程 |
| [原独立核验](verification-20261018T005440.596276Z/verified-summary.json) | 263 checks；identityMatches=true、captureComplete=false、executionAccepted=false、passed=false |
| [只读诊断](diagnosis/REPORT.md) | 原 Catalog failure artifact、精确提交源码、失败位置与证据缺口 |
| [原诊断清单](diagnosis/evidence-inventory.json) | 原冻结现场的逐文件长度与 SHA-256 |
| [归档清单](manifest.json) | 本目录相对路径、来源路径、长度和 SHA-256；99 个原文件共 5,361,160 bytes |
| [原 capture](tools/capture-v2.py) / [原 verifier](tools/verify-ci.py) | 工具原字节，无接受标准调整 |

复制时对所有 99 项先核对原 inventory，再逐字节写入并读回。目录内 `.gitattributes` 禁止文本换行归一化；提交前仍需核对 index blob。`README.md`、`manifest.json` 和属性文件是归档包装，不属于 99 个原件。

完整 Core 为 2661 tests / 2657 pass / 0 fail / 0 cancelled / 4 skipped。前轮 named-session 用例本轮通过，但不能据此宣称间歇问题修复。Catalog smoke 是本轮第一个失败步骤；之后 16 项 acceptance smoke 和 Docker 跳过，没有 D5 成功摘要。原 verifier 的 17 项 capture 失败对应这些跳过步骤缺少独立日志，保留原 false 结果；这不等同于 ZIP 下载损坏。

Catalog POST 已得到 201，失败快照仍是 `writing='release'`、`listLoading=true`、notice 为空。旧日志没有请求开始、完整结束或正文解析阶段，不能断言原 CI 卡在具体哪个网络阶段。独立产品复现和后续修复必须另立证据，不改写这里的历史结论。
