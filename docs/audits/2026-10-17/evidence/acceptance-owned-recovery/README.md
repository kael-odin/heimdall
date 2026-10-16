# 启动恢复证据索引

本目录对应[启动恢复实施报告](../../acceptance-owned-recovery.md)。原始日志、报告、JSON 与图片按捕获 bytes 归档；`.gitattributes` 禁止自动换行改写。[归档映射](archive-provenance.json)逐文件记录原路径、长度及 SHA256；[源码固定值](source-pins.json)保存 verifier、14 份历史原件与本轮文件。

| 证据 | 范围 |
| --- | --- |
| [结构化汇总](quality-summary.json) | 实际计数、环境限制与不重复相加口径 |
| [最终 Core TAP](core-full.tap) / [语法门](core-lint.tap) | 1713 total / 1706 pass / 0 fail / 7 env skip；378 files syntax |
| [Console build](console-build.log) / [Core smoke](core-smoke.log) | 实际构建与原站点克隆烟测 |
| [Linux 独立审查](linux/review-conclusion.md) | owned root 丢失复现、修复、固定输入与逐项审查 |
| [首轮 Linux TAP](linux/initial-focused.tap) / [依赖补齐后原失败项 TAP](linux/engine-dependency-retry.tap) | 230 项去重后 229 pass / 1 Windows-only skip；首轮 7 个加载失败与纠正均保留 |
| [Linux 源码 pins](linux/frozen/pins.json) / [运行依赖 pins](linux/dependencies/pins.json) | 386 份输入与 86 份依赖 bytes 固定；运行副本为 ext4 |
| [新恢复 CDP](browser/owned-recovery/browser-checks.json) / [运行环境](browser/owned-recovery/runtime.json) | 真实 owner / writer / engine startup / Chromium CDP；目标与模型请求为零 |
| [中断界面截图](browser/owned-recovery/owned-recovery-interrupted-desktop.png) / [ready DTO](browser/owned-recovery/recovery-ready.json) / [重启结果](browser/owned-recovery/recovery-restarted.json) | 仅 manifest 收束、prepared 不启动、正式 bytes 幂等 |
| [blocked DTO](browser/owned-recovery/recovery-blocked.json) / [拒绝写入](browser/owned-recovery/blocked-mutation.json) | 坏 namespace 时完整现场保留，catalog 诊断 GET 可读 |
| [最终普通验收浏览器](browser/acceptance/browser-checks.json) | 控制台创建、真实 worker、显式模型模拟器、门禁 / 证据 / 下载、刷新与手机布局 |
| [Spec](browser/regressions/spec-browser/browser-checks.json) / [比较](browser/regressions/comparison-browser/browser-checks.json) / [Catalog](browser/regressions/catalog-browser/browser-checks.json) | 原有三类完整浏览器回归 |
| [旧目录迁移](browser/regressions/migration-browser/migration-checks.json) / [需求基线](browser/regressions/baseline-browser/browser-checks.json) | 历史格式连续性、显式候选 / 批准 / 选用 |
| [私有准备](browser/regressions/managed-preparation/checks.json) / [托管读取](browser/regressions/managed-reading-final/browser-checks.json) | 准备零执行、completed BUG 证据与安全 DTO、重启后的 interrupted |
| [原 CDP 克隆闭环](browser/regressions/original-cdp/cdp-real-forge.json) | 控制台实际点击、生成 home、产物 HTTP 200、pageErrors=[] |
| [普通验收首轮失败](diagnostics/initial-acceptance-failure.tap) / [当前正常诊断](diagnostics/current-normal-browser.json) / [父提交对照](diagnostics/parent-normal-browser.json) | 两条无 URL 的 409 尚未确定根因；不把诊断增强声称为产品根因修复 |

恢复 smoke 使用经 schema 核验的历史派发模板变更测试身份 / 本机目标，再经真实 writer 创建事实；它验证恢复，未覆盖 live catalog admission 或 engine executor。普通验收中的模型调用是受控本机模拟器，恢复 smoke 本身没有模型调用。本轮所有截图和门禁都只对应本机夹具。

Linux 首轮环境依赖失败没有删除或改写。独立审查中的脚本和路径按原运行保留；本目录保存输入 pins，不重复提交 Node runtime 或完整冻结源码副本，源码由 Git 版本复现。
