# Browser 候选基线：明确选侧与完整字节核验

日期：2026-10-17。本切片交付 Browser 候选来源的纯核验内核：从明确选中的参考侧或目标侧重建候选 oracle，核验完整声明槽位及全部实际引用证据。调用与预算见[内部模块指南](../../competition/acceptance-browser-source.md)。这是后续页面基线批准和复验的基础，尚未接入 Browser 目录写入、UI 或托管 executor。

## 已交付结果

新增 [browser-candidate-projection.mjs](../../../core/src/acceptance/browser-candidate-projection.mjs) 提供纯同步 verify/project 两个入口，独立 Browser domain/version 与已审验证器 allowlist。公开返回完整 preview 和摘要，不返回私有规范计划或 Buffer，固定 `executionReady:false`。没有 project/release 归属主张。

系统不根据旧报告 gate 决定选侧资格。固定真实样本中，旧比较发现视觉差异、gate 为 failed，但两侧都完成健康的独立观察，可以分别生成候选。新 target oracle 依据 target 截图、详情和规范声明重建，原报告 expected 与 identity 中的旧 baseline oracle 继续保留。

检查槽由规范计划重建；每个路由和视口的六个基础检查、每个声明交互点及实际出现的只读阻断检查都要一一对应。报告字段、旧稳定身份、角色、coverage、summary 和 gate 与重建值核对。即使重新计算 manifest/report/证据摘要，缺槽、错槽、声明断言或结果语义冲突仍被拒绝。

所选侧必须具有详情、首张及重复截图、非空 DOM、成功导航、完整操作和断言、无已观测运行阻断、完整捕获及允许的遮罩比例。PNG 先核对全部 chunk、单图与累计像素、RGB/RGBA 8 bit 非隔行子集以及比较包围网格预算，再送入解码器；稳定性按真实两张截图重新计算。完整 preview 超过 2 MiB 直接拒绝。

## 证据等级与样本

| 验证方式 | 实际范围 |
| --- | --- |
| 真实采集 | 现有 Chromium runner、完成存储器、本地固定页面、四次独立运行；没有外部站点或真实账号 |
| 离线核验 | 冻结原始文件、重封摘要后的语义反例、独立 golden、输入不变与零 I/O 检查 |
| 源码确认 | Browser 专用 LF/CRLF 兼容表、有效执行设置、URL 脱敏和 PNG 依赖分配边界 |

[冻结原件清单](../../../core/test/fixtures/acceptance-browser-source/source-index.json)共四组、81 个原始 manifest/report/证据文件，另有四份独立构建的 integrity 交接值。主样本两条路由、两种视口、两个分别属于不同路由的交互点，共 28 槽；两种单侧导航失败各 6 槽；真实声明断言失败 7 槽。全部原件 SHA-256 在测试中独立核对，不把 integrity 交接值冒充原始 runner 产物。

legacy snapshot reader 仍会拒绝另一侧 `null` 截图。这里按所有非空报告引用及完成索引重建有界 integrity 交接值，原 manifest/report/details/PNG 保留原字节；该行为明确记录于 source-index。后续 Browser 私有读取器须原生支持此合同，不能因此放宽 Spec 的非空证据规则。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 独立专项 | 22 tests / 22 pass / 0 fail / 0 skip，无 subtests，27.295 秒；重叠作者复跑不累加 |
| 新真实采集 smoke | 8/8 检查；4 次 fresh Browser 运行、8 个选侧案例，4 个合格、4 个拒绝，另有 4 次确定性重查；投影阶段 fetch=0 |
| Core lint | 434 files OK |
| Console build | 通过，既有 Graph3D 大 chunk 提示保留 |
| Windows Core 正式维护 suite | 1841 total / 1833 pass / 0 fail / 8 skip，460303.6743 ms；专项 22 项已包含在总数中 |
| 原 core smoke | 通过；本地两页样本 visual=100.0%、DOM=100.0%、health unresolved=0 / externalAssets=0 |
| 原控制台克隆 CDP | 重试成功，cloneStatus=200、pageErrors=[]；两张截图及结构化结果保留 |
| 文档链接 | 662 local targets / 193 files 通过 |

专项还覆盖跨路由/视口/point/side/角色借用、伪造稳定性、超预算和编码不受支持的 PNG、所选侧健康/步骤/断言、原报告 expected/identity、最终 URL 查询值边界、未引用索引、getter/Proxy/共享字节、完整 preview 超限和零文件/网络调用。两侧 golden 在测试中从 raw details 和 PNG 自行重建 oracle，并以独立 canonical 编码及 crypto SHA 复算。

本次修正了开发中的真实兼容问题：详情 JSON 实际包含 `details` 字段，首版错误排除该字段导致健康样本被拒；通过真实原件发现后恢复必需字段并核对角色文件名。反例测试还促成比较包围网格预算与完整 PNG chunk/编码预检。早一轮因缺少比较网格预算而 19/20 的日志保留，不计为功能通过。

首次原控制台 CDP 的 Windows 调用包装把输出路径外层引号保留为实际参数，mkdir 即失败，浏览器没有启动。保留 exit=1 的原日志，纠正调用后独立重跑通过；不重跑或累加此前已通过的全量门。Windows 的 8 项跳过为六项 POSIX 场景和两项显式 Docker；新提交的 Linux CI 将独立核验这些平台边界。

发布副本、完整日志与摘要见[证据索引](evidence/browser-source/README.md)。本片同时补录上一执行 UI 提交 `e427ec1` 自身的[成功 Linux CI](evidence/execution-ui/ci-main-e427ec1/README.md)，该 CI 不作为新 Browser 模块自身提交的验证。

## 保留边界与下一步

哈希与语义核验用于识别损坏、混用和不受支持的旧规则，不能证明签名历史、管理员未同时重写全部材料或文件系统所有权。所选侧“健康”只覆盖声明槽位和有界观察；人工仍须判断视觉差异是否符合产品意图。原门禁不因候选资格而改变。

计划中的完整 entry URL 和 resolved route 被锁定，捕获最终 URL 已抹除 query 值，预览明确展示这层差别。完整最终查询、重定向链、认证、写请求、数据库、全部状态机与未来部署内容均不在本片证明内。当前来源资格也不能冒充项目版本归属：现有 run binding 只认领 target URL，不能借此声称 baseline 属于同一个 release。

下一切片实现 owner/fence 约束的 Browser 私有读取器，随后单独演进选侧归属、目录批准和固定来源执行。操作归档管理和持久 BUG 账本继续独立推进。

```powershell
node --test core/test/acceptance-browser-candidate-projection.test.mjs
pnpm acceptance:browser:source:smoke
pnpm -C core lint
pnpm -C console build
pnpm -C core test
pnpm -C core smoke
$env:HEIMDALL_E2E_CDP_SELF='1'
node core/scripts/smoke-console-cdp.mjs
pnpm docs:links
```
