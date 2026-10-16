# 托管 Spec 核验读取：证据索引

日期为香港本地 2026-10-17；产物内时间戳使用原始 UTC。全部请求针对受控本地夹具，Browser plugin 不可用，浏览器流程使用现有 Playwright Chromium。托管记录由引擎启动前显式调用内部 runner / writer 生成，未验证 engine executor 或 owned recovery。

| 证据 | 内容与适用范围 |
| --- | --- |
| [质量门汇总](quality-summary.json) | Windows 全量、8 条真实浏览器 / CDP 流程及 1 项准备 smoke；所有命令退出码 |
| [托管读取浏览器](browser/browser-checks.json) | 7/7，真实生命周期、BUG、证据、原 JSON 与派生 Markdown、390px 无溢出、零执行 / 零改写 |
| [桌面截图](browser/managed-reading-desktop.png) / [手机截图](browser/managed-reading-mobile.png) | 实际渲染页面，pageErrors=[] |
| [原有 CDP 克隆流程](cdp/cdp-real-forge.json) | taskStatus=done，cloneStatus=200，pageErrors=[] |
| [Core 全量日志](gates/test.log) / [Core 质量门](gates/core-gates.json) / [流程退出码](gates/browser-gates.json) | 1654 total / 1650 pass / 0 fail / 4 skip；373 files 语法检查、core smoke 和 console build |
| [独立审查](review/README.md) / [Linux reader](reader-linux/README.md) | 发现与修复前后反例；Linux focused 189/189、独立 reader/dispatch 60/60；FIFO 实际执行，范围有交集，不相加 |
| [Spec](regression/spec-final/browser-checks.json) / [比较](regression/comparison-final/browser-checks.json) / [目录](regression/catalog-final/browser-checks.json) | 既有控制台真实回归，无新增目标请求的检查仍通过 |
| [一般验收](regression/acceptance-final/browser-checks.json) / [旧目录迁移](regression/migration-final/migration-checks.json) / [基线](regression/baseline-final/browser-checks.json) | 新读取层兼容原有工作流，保留历史失败门禁 |
| [准备 smoke](regression/preparation-final/quality-gates.json) | 私有 prepare / replay 的零执行边界，无浏览器或 engine executor |
| [父提交 CI](ci-parent/parent-ci-f72edad.json) / [失败日志](ci-parent/parent-ci-f72edad-failed.log) | f72edad 的 catalog notice 超时；本轮未复现原间歇根因，不代表本次提交 CI |
| [诊断拒绝探针](catalog-negative-probe/failure.json) / [UI](catalog-negative-probe/failure-ui.json) / [截图](catalog-negative-probe/catalog-failure.png) | 故意返回 409，预期在 201 断言失败并保存现场；不是一次成功的目录运行 |
| [源码与历史固定值](source-pins.json) / [原件到归档映射](archive-provenance.json) / [逐文件摘要](index.json) | 固定 24 份变更实现 / 配置 / 测试、10 份验证器来源、14 份历史原件及两份候选 golden |

`browser/run-evidence/` 保存运行现场，里面故意写入的 `report.md` 内容为 `UNTRUSTED STORED MARKDOWN`；下载结果是 [downloaded-report.md](browser/downloaded-report.md)，由核验 JSON 重新派生。completed BUG 的 gate=failed 和受阻报告 gate=blocked 都是预期事实，不能把文件中的 failed 字样当成本轮测试失败。

归档保留全部 JSON、TAP、PNG、派发与报告原字节；`.log` 明确移除 UTF-8 BOM、把 CRLF 转 LF 并移除行尾空格 / Tab，原日志仍留在 ignored 工作区。逐项映射记录原件和归档件的不同摘要。该目录的 `.gitattributes` 禁止 Git 再次改写证据字节；子目录保留自己的原字节设置。`index.json` 不包含自身。

本地跳过的四项为两项 Linux FIFO / 非 regular pipe 和两项需显式 Docker 开关的隔离交付。前两项在 WSL 已实际通过；Docker 独立检查由本次提交的 CI 执行，本轮本地未执行。console build 的既有大 chunk 提示仍存在。

合成故障值、loopback URL、临时目录和本机工作路径用于复现；不含真实业务凭据或生产数据。两份 PowerShell 质量门脚本位于 `gates/`，保留了本机绝对路径；跨机执行时应修改其 repoPath 并选择新的输出目录。
