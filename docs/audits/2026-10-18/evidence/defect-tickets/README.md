# D5 人工缺陷单闭环：公开验收证据说明

本目录用于审阅 Heimdall 人工缺陷单闭环的本机验收证据。它包含门禁运行原件的压缩归档、共享的维护输入快照、历史失败和诊断资料，以及便于直接阅读的最终 D5 Browser 产物副本。

本说明不预填测试通过数、归档数量或某个提交的 CI 状态。实际结果以 `archive-index.json`、它绑定的批次原始摘要、各门禁的原始输出，以及另行生成的独立复核报告为准。目录存在、截图存在或某个内层 JSON 写有成功，均不能单独替代这些绑定。

**先找到最终批次与原件。**

`archive-index.json` 是包内导航与完整性清单：

| 字段 | 含义 |
| --- | --- |
| `finalBatch` | 收集时明确指定的完整批次目录及其原始 `summary.json` 的 SHA256。对应摘要以 `batch-<UUID>.json` 直接复制进本目录。 |
| `finalGates` | 最终批次中每一组门禁实际绑定的执行目录。绑定依据是门禁名与唯一包含关系的原始时间窗，不按“最新成功”挑选。 |
| `chosenD5GateDirectory` | 最终 D5 Browser 的执行目录，应与 `finalGates.browser` 相同。 |
| `gates` | 收集范围内有外层 `summary.json` 和 `runner.mjs` 的全部已落盘门禁，包括历史失败；保留退出码、signal、error、输入摘要、时间与 `finalBatchMember` 标记。 |
| `archives` | 每个 `.tar.gz` 的 SHA256、压缩包字节数、普通文件条目清单及每项长度/SHA256、原件目录和特殊条目描述。 |
| `sourceGroups` | 完整输入清单的摘要到共享 source 归档的映射。每个 gate 的 `sourceArchive` 指向相应快照。 |
| `copies` | 直接阅读副本、工具、说明及审查记录的原件路径、字节数和 SHA256。 |

收集器要求所指定批次包含下表全部门禁，并核对外层退出成功和输入未变化，才会形成正式目录。它先写入唯一的临时发布目录，完成归档读回核对后再重命名为正式目录；不会覆盖已有正式证据目录。独立核验还会重新验证完整集合、归档与本机原件、最终批次绑定，以及 D5 的精确检查项和请求记录。

**最终批次的 17 组门禁。**

下表描述当前完整批次的串行执行顺序和覆盖范围，不表示本 README 已确认其结果。

| 顺序 | gate | 运行内容 |
| --- | --- | --- |
| 1 | `build` | 构建 Console，生成后续 UI 验收所用的 `console/dist`。 |
| 2 | `browser` | D5 真实 Chromium 人工缺陷单流程：固定成员、显式关闭、可靠失败后重开、丢回复后 GET 对账、过期预览与导出。 |
| 3 | `core` | `core/scripts/test-core.mjs` 枚举的全部维护 Core 测试，不使用测试名或文件子集筛选。 |
| 4 | `original` | 原有验收 Console 烟雾流程。 |
| 5 | `managed` | 受管理执行 UI 烟雾流程。 |
| 6 | `d3` | Browser 执行 Console 烟雾流程。 |
| 7 | `d4` | Browser 启动未知结果核对与永久拒绝 Console 烟雾流程。 |
| 8 | `candidates` | Browser 完整来源审阅、显式保存候选集与持久化读取流程。 |
| 9 | `bindings` | Browser 来源绑定流程，使用脚本原有的显式 catalog 迁移选项。 |
| 10 | `recovery` | 自有执行恢复烟雾流程。 |
| 11 | `cdp` | Console CDP 烟雾流程，保留 runner 明确设置的 self 模式环境变量。 |
| 12 | `forge` | 原有 Forge 烟雾门禁。 |
| 13 | `benchmark` | 验收基准门禁。 |
| 14 | `specbenchmark` | 规格验收基准门禁。 |
| 15 | `comparisonbenchmark` | 对比验收基准门禁。 |
| 16 | `lint` | 仓库原有语法检查。 |
| 17 | `docs` | 仓库原有 Markdown 链接检查。 |

完整 Core 的计数应读取 `stdout.log` 中实际 reporter 的原生末尾汇总。Node spec 的 `ℹ tests/pass/...` 与 TAP 的 `# tests/pass/...` 是两种输出；外层旧采集字段中的 `null` 不等于零，也不能据此补造测试数量。跳过项应保留其真实数量，不能计入通过数。

**原字节与共享 source 的保存方式。**

每个 gate 归档保存当时实际存在的结果、运行时数据、完整 stdout/stderr 和摘要等普通文件字节。清单逐项记录长度与 SHA256，收集时会读回 tar 内容并与本机原件比较。普通文件在 tar 中使用统一的 mode 和时间戳；这不是保留原始权限、ACL、mtime、空目录或硬链接拓扑的整盘备份。本目录的 `.gitattributes` 使用 `* -text` 保存提交中的原始字节，避免文本换行转换；它不替代独立的字节核对。

每次 gate 的 `before`/`after` 使用显式维护输入清单：维护源码、脚本、测试、Console 源码、配置、包与锁文件、入口和构建配置、CI 文件及指定的准备模板等。非 build 门禁还包含 `console/dist`。最终各非 build 门禁必须具有完全相同的清单和字节；build 必须等于该清单去掉 `console/dist/` 后的精确投影，不能把 build 的输入摘要说成与其他门禁字面相同。

完全相同的冻结 source 只保存一份共享归档。单个 gate tar 因而不重复包含其顶层 `source/`，应通过该 gate 的 `sourceArchive` 查阅；嵌套运行时中名为 `source` 的业务证据仍保留。source 归档按完整 manifest 分组，历史轮次可能对应不同的 source 组，不能把早期失败的输入与最终输入混用。

这份输入清单不是自动依赖追踪得到的整仓构建闭包，也未冻结全部 Markdown。`docs` 门禁会读取清单之外的文档，不能将它描述为所有文档输入均已冻结。清单中包含某目录也不自动证明构建配置实际使用了其中所有文件。

gate 结果中只排除顶层、已经证明与完整日志逐字节相同的 `stdout.partial.log`/`stderr.partial.log`，以及明确命名为 `chromium-profile` 的缓存目录。补充开发根没有这一缓存排除；公开目录和 source 的完整集合核验也没有隐式缓存排除。

**历史失败与诊断资料。**

最终成功批次的选择不删除或改写历史失败。收集器分别归档所有具备外层摘要和 runner 的已完成 gate，以及同级 `d5-*` 补充开发目录；后者排除本 gates 根与另行管理的 `d5-ci-*` 目录。每个原始批次摘要也单独保留。各轮的真实状态、输入摘要和目录应分别阅读，不能把失败轮的截图和另一轮的成功摘要拼成同一结果。

历史失败可能没有 Browser `finally` 生成的 `browser-errors.json`、截图或内层完成摘要。只要外层 wrapper 已保存其摘要、完整 stdout/stderr 和 source，这些实际存在的失败现场仍可归档；缺失的文件不会被伪造补齐，也不由“没有错误文件”推断没有错误。若 wrapper 自身中断、没有外层摘要，则不属于 `gates` 的已完成集合；是否另有补充目录覆盖，应查阅 `archives` 与诊断来源记录。

`diagnostic-loader.mjs` 与 `diagnostic-provenance.json` 分别保存诊断插桩工具和其来源说明。诊断输出及补充开发归档与最终 gate 分开识别，以清单中的实际条目为准。诊断轮用于解释原因，不代替无诊断插桩的最终门禁；任何原始 stderr、失败状态或不完整收尾都应原样理解。

`verifier-review.json`、`static-review.md`、`staged-source-review-*.json` 和 `git-index-review-*.json` 属于各自范围的审查记录。不同时间的记录可能绑定不同输入；应读取其来源与覆盖范围。旧审查记录的存在不自动表示当前暂存区、当前工作区或新提交已经通过相同核验。

**Symlink 与 Windows Junction。**

安全测试保留的符号链接和 Junction 不跟随目标、不递归目录链接，也不作为可执行的 tar 链接还原。它们记录在所属 archive 的 `specialEntries` 中，包含 `file`、`kind`、`target`、`mode` 和 `reparseTag`，并在收集前后与本机现场元数据比较。普通文件数量 `fileCount` 不包含这些特殊条目，应另看 `specialEntryCount`。

`target` 是 Python `os.readlink()` 返回的 substitution-target 原样字符串，保留其 Windows 前缀和分隔符；它不是完整的原始 reparse buffer，也不是要求审阅者访问的路径。当前合同针对现存 Symlink/Junction；可观察到的未知 reparse 类型会被拒绝，不能据此声称支持所有 Windows reparse 类型。归档只保留描述，不自动重建链接关系。

**离线查看 JSON、tar 与直接阅读副本。**

只查看包内材料不需要启动服务、测试或 Browser，也不需要本机原件目录。可以先在包目录中运行：

```powershell
python -m json.tool archive-index.json
$index = Get-Content -Raw -LiteralPath .\archive-index.json | ConvertFrom-Json
$index.finalBatch
$index.finalGates | Format-List
$index.archives | Select-Object archive, bytes, sha256, fileCount, specialEntryCount
```

从最终 Core 对应的归档查看原始摘要和日志：

```powershell
$entry = $index.gates | Where-Object { $_.directory -eq $index.finalGates.core }
$archiveName = $entry.archive
tar -tzf $archiveName
tar -xOzf $archiveName summary.json
tar -xOzf $archiveName stdout.log
Get-FileHash -Algorithm SHA256 -LiteralPath $archiveName
```

同样可按其他 gate 的映射选择 tar。`tar -xO` 将指定成员输出到标准输出，不创建运行时目录或链接；终端显示编码不替代原字节 SHA 比较。也可用 Python 标准库列出归档：

```powershell
python -m tarfile -l "<从清单选择的归档名>.tar.gz"
```

压缩包 SHA 应与 `archives` 的记录一致；进一步核对时还需比较完整成员集合、每个普通成员的长度/SHA，以及 `specialEntries` 描述。包内清单允许离线检查内部一致性，但清单与归档一起被改写时，单靠二者不能证明外部真实性；应结合提交中的原始文件、另行记录的摘要和独立复核结果。

顶层 `defect-ticket-*.png` 和 `d5-browser-*` 是最终 D5 Browser 对应产物的直接副本，便于查看桌面/移动、浅色/深色截图、布局、检查项、错误记录和导出文件；其来源及 SHA 仍由 `copies` 绑定。PNG 的签名、尺寸、SHA 和 DOM/布局核验不等同于人工目视审美评审。

**完整独立核验的本机依赖。**

包内 `collect.py`、`verify-public.py`、`verify-staged.py`、`verify-index.py`、`run.mjs` 和 `all.mjs` 是工具副本，便于审阅采集与验证逻辑。查看材料不需要执行它们；`run.mjs`/`all.mjs` 会实际运行门禁，不能当作离线查看命令。

`verify-public.py` 的完整核验模式依赖原仓库位置、清单记录的本机绝对原件路径、原批次目录、冻结 source、当前维护输入和本地 Git 基准对象。公开包单独复制到其他机器后，可以检查包内材料，但不能直接在公开目录运行该脚本副本并声称完成原件一致性复核。

保留原件的本机应从原 gates 工具位置执行，并使用清单绑定的明确最终批次与一个尚不存在的、位于公开目录之外的报告目录：

```powershell
python core/workspace/_runs/d5-gates-20261018/verify-public.py `
  --public-directory "<公开证据目录绝对路径>" `
  --batch-directory "<archive-index.finalBatch.directory 的原始值>" `
  --output-directory "<gates 根内尚不存在的独立报告目录>"
```

该核验只读取证据，不启动 Browser、engine 或测试，也不解压恢复运行时。输出报告位于公开目录之外；最终引用应给出实际报告位置与摘要，不能因工具文件存在就推断已经运行或成功。

原件通过流程冻结并反复比较，但多个文件不是在同一瞬间原子采样。Windows 的 lstat/读取组合不提供对并发恶意替换的原子防御；这套证据也不检测一份自洽外部备份的整体回滚。D5 丢回复场景由 `route.fetch()` 后返回受控 HTTP 响应模拟，不是断电或 TCP 中断试验；Browser 请求日志只覆盖所记录的验收 API 范围。

**平台与提交边界。**

这些运行材料来自 Windows 本机受控夹具，能够支持其明确记录的页面、数据和行为结论；不覆盖任意真实站点，也不代表整个项目的全部业务已经修复。冻结输入摘要、Git 暂存区 blob 核验和最终提交 SHA 是不同层次的证据，应分别绑定。

Windows 本机验收不代替新提交 SHA 的 Linux CI。此前提交、D4 或其他 SHA 的 CI 归档可作历史参考，不能写成当前新 SHA 已通过 Linux。发布或交接说明应另列该新 SHA 的实际 CI 状态、运行链接及结果；若尚未取得，就据实保留未验证状态。
