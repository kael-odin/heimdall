# 跨运行复验实施与验证记录

日期：2026-10-16。比赛方向：自动验收开发项目还原度 BUG 检测系统。前置版本：`f8bfdde`（Spec / OpenAPI）。本阶段交付显式运行对复验，用户指南见[跨运行复验](../../competition/acceptance-comparison.md)。

## 本阶段结果

“项目验收”现在可以明确选择此前与本次运行，重新核对报告和证据后，区分可靠复验通过、仍失败、新增失败、本次观测失败、未复验、不可比、持续通过与本次观测通过。API、CLI 和控制台共用同一比较投影，保留双方原门禁，不修改原报告，也不请求受测目标或模型。

这是运行之间的事实比较，范围为 `explicit-pair`。没有新增项目批准目录、可执行冻结基线或持久缺陷工单；未自动推断代码根因，也不自动关闭 BUG。

## 核心实现与防假修复条件

| 能力 | 当前实现及其作用 |
| --- | --- |
| 稳定检查身份 | 分开保存语义检查、实际视口、规则、判断依据和执行环境指纹。目标地址、运行名、展示标题和数组序号不决定跨运行身份 |
| 实际视口 | 使用宽高，手机只改名称仍能配对；375→390 不可代替旧尺寸复验，缺少旧手机测量保留未复验 |
| 规则变化 | 阈值、遮罩、步骤、断言、schema、超时与预算等变化进入不可比，不能以放宽判据证明修复 |
| 判断依据 | 视觉锁定实际基线 PNG 的 SHA-256；同一 URL 的参考内容变化仍不可比。Spec 绑定来源身份、revision、文档摘要及单份合同语义 |
| 当前字节核验 | 比较前重新读取 manifest、report 及全部引用证据，核对报告字节摘要、计划绑定、统计/门禁、证据大小与 SHA-256 |
| 证据角色 | Spec 需要合同/请求/响应；Browser 需要双方截图/详情/重复截图，视觉另需 diff。空引用索引不能证明检查通过 |
| 整项复验 | 旧子字段错误不再出现在失败列表中，不等于修复；必须对应整份相同合同或操作点可靠通过 |
| 执行与覆盖 | 未完成、中断、缺测、封顶、评估受限、基线失败、待复核与完整性异常均不能贡献可靠复验通过 |
| 原始事实保护 | 完成时保存报告字节摘要；终态事实不可通过通用 patch 改写，独立 AI 元数据仍可保存。CLI 导出拒绝写入运行存储及其 symlink/junction 别名 |
| 控制台状态 | 选择改变时取消旧请求并清空旧结果；迟到的比较或导出不能回写。导出重新核验，JSON、Markdown 与界面使用同一次新快照 |

哈希用于检测保存后字节变化及语义不兼容，不是防本机攻击者同时重写全部文件的签名系统。旧报告缺少稳定身份或完成摘要时仍可查看，但不会补造历史复验通过事实。

默认读取预算为每份 JSON 8 MiB、单证据 64 MiB、证据总量 256 MiB、1024 个证据文件和 1024 项检查。超预算受阻，历史文件保留。完整性区将“通过文件数”与“已读字节数”分开呈现，读取过的失败文件不算校验通过。

## 验证结果

证据等级：**离线复现**。使用真实引擎、Browser / Spec runner、文件存储和 Chromium，目标是本机固定夹具；没有访问生产接口或外部模型。本阶段不能据此声明真实项目检出率或泛化能力。

| 检查 | 结果 | 证据或说明 |
| --- | --- | --- |
| 全量 core 测试 | 1030 项，1028 通过，0 失败，2 条件跳过 | 226752.6282 ms；本机缺 Docker 条件，跳过项不是产品通过 |
| core 语法检查 | 318 个文件通过 | `pnpm -C core lint` |
| 控制台构建 | 通过 | `pnpm -C console build`；原有 Graph3D 大 chunk 提示仍存在 |
| 跨运行固定反例基准 | 12 / 12 通过，12 次真实运行 | [benchmark.json](evidence/acceptance-comparison/benchmark/comparison-benchmark-2026-10-16T12-12-14-939Z-996e6339/benchmark.json) · [benchmark.md](evidence/acceptance-comparison/benchmark/comparison-benchmark-2026-10-16T12-12-14-939Z-996e6339/benchmark.md) |
| 新控制台 / API / CLI 闭环 | 15 项通过 | [browser-checks.json](evidence/acceptance-comparison/console/browser-checks.json) |
| 既有 Mirror / Spec 控制台与 forge | 全部通过 | Mirror 17 项、Spec 17 项控制台守卫；forge 捕获、构建、差异、离线包、watch 与持久任务闭环 |
| Markdown 本地链接 | 269 个目标、100 个文件通过 | `pnpm docs:links` |

固定反例基准保存 truth、12 份真实运行、当前证据比较 JSON / Markdown 以及每项断言结果。验证了重排后修复与新增失败、只测桌面、删除路由、同 URL 参考漂移、合同持续失败、放宽合同、改变来源、删除合同、响应预算受阻、完成后证据变化，以及原报告和门禁不变。

浏览器案例中，相同操作在两个视口分别产生关系；例如 4 项复验通过、2 项新增失败是检查与视口发生次数，不是 6 个独立代码根因。API 示例中，一份合同修复而另一份发生回归，双方原门禁仍为 `failed`，不会被一项复验通过覆盖。

## 控制台闭环与界面核验

被验证流程：**项目验收 → 展开跨运行复验 → 明确选择此前/本次 → 核验、筛选及导出 → 选择切换、刷新、证据变更受阻 → 查看原报告**。

环境为本机临时 loopback 引擎与 API 夹具、Playwright Chromium、`reducedMotion: reduce`。Browser plugin not available，复用仓库已有 Playwright；没有增加浏览器依赖。桌面视口 1440×1000，窄屏 390×844 和 375×812，横屏 844×390。

| 浏览器检查 | 结果 |
| --- | --- |
| 页面 URL / title 与内容非空 | 通过 |
| 框架错误覆盖层 | 无 |
| 控制台 error / warning 与 pageerror | 0 |
| 同运行禁止、显式选择及选择刷新恢复 | 通过；刷新不会复用旧结论 |
| 错误恢复与旧比较/导出取消 | 通过 |
| 关系统计、原因搜索和查看原报告 | 通过 |
| JSON / Markdown 下载 | 通过；鉴权请求，重新核验，同份快照 |
| 390 / 375 窄屏及横屏溢出 | 无横向溢出 |
| 深浅主题关键文字对比度 | 最低 4.688:1；检查说明、主操作与成功/失败计数 |
| 放大文字压力检查 | 注入测试 CSS 将关键正文放大至 24px 后仍可换行，无横向溢出；未声称原生 Dynamic Type 覆盖 |
| 证据被改动 | 明确显示 `EVIDENCE_DIGEST_MISMATCH`，可靠复验通过降为 0 |
| 目标请求与原始事实 | 比较/交互未新增目标请求、运行提交或模型调用；原 manifest 字节保持不变 |

## 证据索引与复现

- [正常比较 JSON](evidence/acceptance-comparison/console/comparison.json)、[Markdown](evidence/acceptance-comparison/console/comparison.md)、[CLI Markdown](evidence/acceptance-comparison/console/cli-comparison.md)。
- [证据变化后的受阻比较](evidence/acceptance-comparison/console/tampered-comparison.json)。控制台 `run-evidence/` 保存的是变化前的完整原始运行，受阻比较另存实际变更后的观察。
- [桌面](evidence/acceptance-comparison/console/comparison-desktop.png)、[手机关系](evidence/acceptance-comparison/console/comparison-mobile-relations.png)、[浅色手机](evidence/acceptance-comparison/console/comparison-mobile-light.png)、[完整性诊断](evidence/acceptance-comparison/console/comparison-integrity-diagnostic.png)。
- [全部浏览器检查和对比度读数](evidence/acceptance-comparison/console/browser-checks.json)。

在仓库根目录运行：

```powershell
pnpm -C console build
pnpm acceptance:comparison:benchmark
pnpm acceptance:comparison:smoke
pnpm -C core test
pnpm docs:links
```

新固定基准及控制台 smoke 已接入 CI；远端结果必须按本阶段提交 SHA 另外核对，不能沿用上一阶段的 CI 结论。构建与读取构建产物的浏览器验证须顺序执行。

## 下一批与当前边界

下一批优先做本地项目、不可变版本、显式运行绑定和基线批准目录；目录写入需要覆盖 read→validate→write 的单写者锁及 revision 检查，原子 rename 本身不能防丢失更新。保存批准与当前选用是两个事实，不能由列表顺序或健康响应隐式决定。

随后再接 managed 执行与冻结来源。现有 Browser 仍访问实时 URL，保存截图不等于可执行冻结基线；将某次目标侧批准为参考时，不能复制该旧运行描述 baseline 侧的 oracle 指纹。认证、业务状态机、精确写许可、真实授权样本、Figma / PRD 扩展和持久缺陷关闭仍需后续实施。
