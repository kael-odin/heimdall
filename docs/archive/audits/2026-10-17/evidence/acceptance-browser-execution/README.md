# D3 固定来源 Browser 执行证据

本目录是 2026-10-17 发布前冻结的本机受控验证。产品范围与修复见[实施验收](../../acceptance-browser-execution.md)，使用入口见[指南](../../../../competition/acceptance-browser-execution.md)。

- [INDEX.json](INDEX.json)：全部 19 组原件、5544 文件、排除清单、可读副本、SHA / 长度与最终源码快照。
- [complete-evidence.zip](complete-evidence.zip)：保留完整 stdout / stderr、原始运行数据、失败前像和截图；SHA-256 `f77e154f829fb46a4a3d4b9f5fbe99b41d05198f41eabe758705a3765ee61e4c`。
- [final-sources.json](final-sources.json)：最终 578 个源码的原字节长度 / SHA，11 组门禁前后均一致。
- [Core 原始输出](core-full.stdout.txt)：2461 total / 2449 pass / 0 fail / 12 skipped。
- [真实 UI 结果](summary.json)、[16 项检查](checks.json)、[浏览器错误原件](browser-errors.json)、[7 个布局采样](layouts.json)。
- [缺陷目标报告](broken-complete-report.json)、[修复目标报告](repaired-complete-report.json)、[首次问题](ledger-initial.json)、[可靠复验通过](ledger-verified-passed.json)、[再次发现](ledger-reopened.json)。
- [最终截图审查](frontend-final-review.md)、[换行归一化前截图审查](frontend-publish-review.md)、[换行记录](eol-normalization.json)、[前一轮发布截图审查](frontend-release-review.md)、[开发前端审查](frontend-finish-review.md)、[Spec 兼容独立审查](spec-verifier-compatibility-review.md)、[Spec 独立字节核对](spec-verifier-independent-source-review.json)、[80 项专项](spec-verifier-summary.json)、[10 项边界复验](spec-verifier-remaining-summary.json)、[lineage 修前复现](lineage-reproduction.json)。

## 最终门禁

| 组 | 实际结果 | 原始 summary 可读副本 |
| --- | --- | --- |
| `console-build-final` | exit 0；1.235 秒；578 项源码前后不变 | [gate-console-build-final.json](gate-console-build-final.json) |
| `syntax-final` | exit 0；21.477 秒；578 项源码前后不变 | [gate-syntax-final.json](gate-syntax-final.json) |
| `browser-execution-ui-final` | exit 0；184.826 秒；578 项源码前后不变 | [gate-browser-execution-ui-final.json](gate-browser-execution-ui-final.json) |
| `core-full` | exit 0；892.858 秒；578 项源码前后不变 | [gate-core-full.json](gate-core-full.json) |
| `original-console` | exit 0；28.191 秒；578 项源码前后不变 | [gate-original-console.json](gate-original-console.json) |
| `owned-recovery` | exit 0；8.965 秒；578 项源码前后不变 | [gate-owned-recovery.json](gate-owned-recovery.json) |
| `managed-execution-ui` | exit 0；102.741 秒；578 项源码前后不变 | [gate-managed-execution-ui.json](gate-managed-execution-ui.json) |
| `browser-candidates` | exit 0；51.637 秒；578 项源码前后不变 | [gate-browser-candidates.json](gate-browser-candidates.json) |
| `browser-bindings-v4` | exit 0；53.619 秒；578 项源码前后不变 | [gate-browser-bindings-v4.json](gate-browser-bindings-v4.json) |
| `forge` | exit 0；35.186 秒；578 项源码前后不变 | [gate-forge.json](gate-forge.json) |
| `console-cdp` | exit 0；30.295 秒；578 项源码前后不变 | [gate-console-cdp.json](gate-console-cdp.json) |

## 截图

- [browser-execution-evidence-desktop.png](browser-execution-evidence-desktop.png)
- [browser-execution-desktop-dark.png](browser-execution-desktop-dark.png)
- [browser-execution-mobile-light.png](browser-execution-mobile-light.png)
- [browser-execution-issue-history-desktop.png](browser-execution-issue-history-desktop.png)
- [browser-execution-issue-history-mobile.png](browser-execution-issue-history-mobile.png)
- [browser-execution-desktop-light.png](browser-execution-desktop-light.png)
- [browser-execution-mobile-dark.png](browser-execution-mobile-dark.png)

截图采样范围见最终界面审查。`pageErrors` 为 0；console 保留精确注入 502 和引擎重启期间连接拒绝，不声称零控制台错误。原来源、运行报告和账本以完整 ZIP / INDEX 的原字节为准。

本目录 `.gitattributes` 使用 `-text` 保留证据原换行。额外 README 只是导航；INDEX 中的 originals 与 readableCopies 才是被逐项核验的原件及副本。后续 CI 查询和独立发布核验输出写入单独目录，不回写此冻结包。本机成功不代替该提交自身 Linux CI。
