# 跨运行复验：显式选择两次验收记录

更新：2026-10-16。跨运行复验读取两次已有运行的报告和证据，判断相同检查是否可靠复验通过。支持 [Mirror / Regression](acceptance-workbench.md) 与 [Spec 契约验收](acceptance-spec.md)；实施结果见[本阶段验收记录](../audits/2026-10-16/acceptance-comparison.md)。

对比不会重新请求目标、改写原报告或原门禁，也不会自动批准基线。当前范围是用户明确选择的运行对 `explicit-pair`，尚无持久项目目录、版本批准或缺陷状态账本。

## 控制台操作

1. 先完成至少两次验收，在“项目验收”中展开“跨运行复验”。
2. 分别选择“此前运行”和“本次运行”。必须选择不同记录；此前记录的创建时间不能晚于本次记录。历史列表顺序不代表批准关系。
3. 点击“生成复验对比”。系统重新读取报告，验证当前证据字节，再显示八种关系、原因与双方原检查 ID。
4. 点击关系统计筛选，或按路由、检查、原因搜索；通过“查看此前原报告 / 查看本次原报告”回看原始证据。
5. 导出 JSON 或 Markdown。**每次导出会再次核验证据**，完成后文件被改动可能使导出结果变成受阻。

页面保留显式选择的运行对，切换选择会清空旧结果。正在运行的记录需等待结束；执行失败、中断或损坏记录可以暴露受阻原因，不能产生可靠复验通过。已完成运行的原门禁为 `failed` 时，仍可分别判断各项复验关系。

## 八种关系

以下单位是检查及其实际视口，不是推断出的代码根因或唯一 BUG 数量。

| 关系 | JSON 值 | 含义 |
| --- | --- | --- |
| 可靠复验通过 | `verified_passed` | 此前明确失败，同一可比检查本次整项可靠通过 |
| 仍失败 | `still_failed` | 同一可比检查两次均明确失败 |
| 新增失败 | `new_failure` | 此前同一检查可靠通过，本次明确失败 |
| 本次观测失败 | `observed_failure` | 本次失败，但缺少此前可靠通过事实，不能称新增回归 |
| 未复验 | `unverified` | 检查被删除、缺测、受阻、待复核或受限，不能证明旧失败已修复 |
| 不可比 | `incomparable` | 身份不唯一/缺失，或模式、定义、来源、实际视口、验证器、环境不兼容 |
| 持续通过 | `unchanged_passed` | 同一可比检查两次均可靠通过 |
| 本次观测通过 | `observed_passed` | 本次可靠通过，但缺少对应的此前可靠通过或目标失败事实 |

例如：旧版手机和桌面都失败，本次只运行桌面，最多形成桌面复验通过，手机保留未复验。另一项独立 BUG 仍失败不会抹掉桌面的可靠复验事实；本次原门禁仍可为 `failed`。

## API

接口沿用引擎 Token 鉴权：

```http
GET /api/acceptance/comparisons?before=ac-完整UUID&after=ac-完整UUID&format=json
x-heimdall-token: 当前引擎Token
```

`format` 可省略，默认 `json`；`md` 返回 Markdown 附件。示例中的运行 ID 与 Token 必须替换为本机真实值，不要把 Token 写入报告。

PowerShell 示例，在仓库根目录执行；假设当前引擎监听 `8900`，其 Token 已放入本终端的环境变量：

```powershell
$before = 'ac-替换为此前完整UUID'
$after = 'ac-替换为本次完整UUID'
$headers = @{ 'x-heimdall-token' = $env:HEIMDALL_TOKEN }
$query = 'before=' + $before + '&after=' + $after + '&format=json'
Invoke-RestMethod -Uri ('http://127.0.0.1:8900/api/acceptance/comparisons?' + $query) -Headers $headers
```

响应含 `kind: acceptance-comparison`、`scope: explicit-pair`、双方运行元数据、`integrity`、`summary`、检查关系和原因。检查只保留原检查引用，不复制响应正文、需求文档或完整 actual。

**HTTP 200 不代表验收通过。** `status: completed` 表示完成对比，其中仍可能有新增失败、未复验或不可比；`status: blocked` 表示运行、覆盖或当前证据不足以形成可靠复验。原运行门禁保持原值，完整性异常时需先查看诊断。

相同运行、逆序、重复参数、未知参数或无效格式返回 400；运行不存在返回 404；接口只接受 GET；未通过鉴权返回 401。

## CLI 与输出路径

在仓库根目录，用同一数据目录中的真实运行 ID 执行：

```powershell
node core/src/acceptance/cli.mjs --compare $before $after
node core/src/acceptance/cli.mjs --compare $before $after --format md --output core/workspace/_runs/comparisons/retest.md
```

默认向 stdout 输出 JSON；`--format json|md` 选择格式，`--output` 写入文件并创建父目录。自定义过 `HEIMDALL_DATA_DIR` 时，CLI 需使用与引擎相同的环境值。

`--output` 必须在运行存储目录之外。默认运行存储是 `core/acceptance/`；自定义数据目录时为 `$HEIMDALL_DATA_DIR/acceptance/`。运行存储本身、任意子路径，以及通过 symlink / junction 指回该目录的路径别名均拒绝，包括指向原报告或证据文件的别名。建议把导出放在上例的 `core/workspace/_runs/comparisons/`。

CLI 对比受阻或参数/读写错误时退出码为 1；对比完成时退出码为 0。**退出码 0 也可能包含新增或持续失败，不是发布门禁。** 对比命令不接受 `--gate`；原始验收运行仍可用既有 `--plan ... --gate` 检查其自身门禁。

## 稳定身份、完整性和旧记录

检查身份将语义检查、实际视口、规则、判断依据和环境分开保存。修改运行名称、目标版本地址、展示标题、路由/合同数组顺序不会仅因显示 ID 变化而丢失配对；实际宽高、point/contract 标识和方法参与对应范围判断。

- 降低阈值、新增遮罩、删除断言、改变操作或放宽 schema 属于判据变化，不能当修复。
- Browser 视觉依据包含实际基线 PNG 的 SHA-256。相同 baseline URL 内容变化仍不可比；精确哈希也会对轻微渲染抖动保守拒绝比较。当前运行仍访问实时参考 URL，不代表可执行冻结版本已完成。
- Spec 来源身份、版本、类型、声明的文档摘要与合同参与判断依据；OpenAPI 文档会校验其 SHA-256。改来源或规格需要保留不可比原因，不能用健康响应自动替换需求。
- 验证器与实际执行环境分开判断；缺少必要环境信息、验证器指纹或稳定身份时，不通过猜测旧 `check.id` 建立复验关系。

每次对比和导出均重新核对保存的计划/报告绑定、报告字节摘要、统计门禁及全部引用证据的大小和 SHA-256。还要求检查保留必要原始证据：Spec 的合同/请求/响应，Browser 的双方截图/详情/重复截图，视觉检查另需差异图；空证据索引不能证明通过。

完整性诊断区显示文件数、字节数和受限错误摘要。常见原因有旧记录未保存报告指纹 `REPORT_DIGEST_UNAVAILABLE`、报告变化 `REPORT_DIGEST_MISMATCH`、证据变化 `EVIDENCE_DIGEST_MISMATCH`、文件缺失 `FILE_UNAVAILABLE` 和超预算 `INTEGRITY_BUDGET`。旧记录仍可查看原报告；需要重新运行获取完整身份与报告摘要，不能编辑旧报告补造可信历史。

默认验证上限：每个 manifest/report JSON 8 MiB、单证据 64 MiB、证据总量 256 MiB，最多 1024 个证据文件和 1024 项检查。超预算会受阻，历史文件不删除。

## 保守复验边界

只有相同合同、操作点或基础检查**整项可靠通过**才算复验通过。Spec 的 HTTP/MIME 错误、验证预算、失败列表上限及 Browser 的中途步骤错误可能遮蔽其他断言，旧字段错误本次没有出现在列表中不能推断已修复。

报告未完成、覆盖缺失/封顶、非法状态、来源失败、未执行、截图/遮罩或评估受限、证据验证异常均不能贡献可靠复验通过。模式或来源/定义/环境不兼容时不计算“改善百分比”。当前结果不自动关闭持久问题、不追踪部署回滚，也不改变任何基线批准状态。

## 固定基准与真实控制台闭环

安装依赖及 Playwright Chromium 后，在仓库根目录运行：

```powershell
pnpm acceptance:comparison:benchmark
pnpm -C console build
pnpm acceptance:comparison:smoke
```

固定基准有 **12 项固定案例**，经真实本地 Browser / Spec runner 和运行存储生成证据：重排后修复与新增、手机/桌面部分复验、删除路由、同 URL 参考漂移、合同持续失败、放宽判据、改变来源、删除合同、响应预算受阻、完成后证据变化及原报告/门禁不变。原始请求、运行、JSON/Markdown 对比和结果保存在 `core/workspace/_runs/acceptance-comparison-benchmark/`，`latest.json` 指向本次批次。

控制台 smoke 会启动隔离的本地接口夹具与真实引擎，通过 API worker 执行 Spec，检查鉴权、输入保护、CLI、明确选择、错误恢复、筛选、重新核验导出、过期请求、窄屏布局和证据变化阻断。默认输出 `core/workspace/_runs/acceptance-comparison-console/`，含 `browser-checks.json`、对比文件和截图；脚本结束关闭临时服务。

这两项是固定本地场景的离线复现。**12 项通过不代表真实项目检出率、通用误报率、根因识别或持久缺陷自动关闭能力**；实际执行结果与证据以[实施验收记录](../audits/2026-10-16/acceptance-comparison.md)为准。
