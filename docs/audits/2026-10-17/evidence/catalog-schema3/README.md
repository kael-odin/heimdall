# Catalog schema3 本机门禁证据

归档生成于 2026-10-17T02:42:45.761Z。全部必需阶段完成且退出码为 0；历史失败和专项日志按下文保留。

本目录对应 2026-10-17 的 Catalog schema3 本机验证。最后独占写入的 `COMPLETED.json` 是打包完成凭据；该文件缺失代表保留中的不完整尝试，不能视为已出版完整包。汇总见 `summary.json`，原件来源、逐文件 SHA-256、退出记录和归档校验见 `provenance.json`；实际源码与测试输入见 `source-files.json` 和 `source/`。文档更新不作为冻结的执行输入，避免因报告编辑循环打包。

## 阶段与计数

最终必须完成 `01-catalog-compatibility`、`02-migration-browser`、`03-final-lint`、`04-console-build`、`05a-baseline-integrity`、`05b-core-test-final`、`06-core-smoke`、`07-catalog-browser`、`08-baseline-browser`、`09-managed-prepare`、`10-execution-ui`、`11-cdp-clone`，且每项退出码为 0。每阶段 stdout/stderr 原始字节的 gzip 和退出 JSON 在 `gates/`；gzip 解压后与原始日志逐字节一致。

完整 Core 的最终数量只取 `05b-core-test-final`。初轮 `05-core-test` 的退出码 1 和原始失败堆栈完整保留：2130 total、2120 pass、1 fail、9 skip。失败来自 migrated B1 的旧 revision 断言 `expected=4`、`actual=5`，schema3 的 1→2→3 迁移需要 +2；随后只修正旧测试合同，专项 `05a` 与完整 `05b` 分开记录，不把专项和旧轮加到最终 Core。

`specialized/pure-schema/` 保留 23/23 的纯 schema 输出；这次日志没有单独的退出码原件，所以 `exitCode` 明确为 null，不能从通过计数推造退出码。迁移专项保留 91/91、93/93、97/97 三轮原始日志、独立退出记录和 runner；以时间最后的完整 97/97 为最终专项结论，旧轮不累计。旧 Browser reader CI 另有专门目录，不包含在本包内。

## 原件与浏览

`originals/*.tar.gz` 保存迁移、Catalog 控制台、Baseline 控制台、managed preparation、execution UI、CDP 克隆各输出目录的完整实际文件集合。每包配有 `*.files.json`，记录相对路径、字节数和 SHA-256；生成时解压到全新的 ignored 校验目录，比较路径集合、大小、摘要并逐文件比较原始字节。`browse/<场景>/` 提供原始顶层 JSON 和全部 PNG 的直接浏览副本，其余原件从 tar.gz 提取。

输出目录依对应阶段时间窗口唯一定位；有明确 `outputDirectory` 的阶段使用该路径并交叉核对创建时间。不会从 `_runs` 任意取最新目录。stdout 的汇总对象须与实际 summary 文件一致。

迁移原件严格为 34 文件、1,369,488 bytes：16 JSON、6 LOG、12 PNG。迁移汇总有 7 条 layout，和 12 张截图分别计数：桌面 5 张为 1440×1000，手机 7 张为 390×844。完整派生布局清单在 `layout.json`，保留各场景原始记录。Managed preparation 只验证私有准备内核及 owner 释放/重取，没有启动浏览器或引擎，也没有 PNG、布局或执行证据。

## 来源与保留边界

迁移场景来自两套独立的已提交 Spec fixture：B1 的原 catalog 为 schema1 revision12，1→2→3 后 revision14；原生 V2 Spec 为 revision20，2→3 后 revision21。迁移 smoke 记录 B1 的 18 个源运行文件以及原生 V2 的 14 个源运行文件的摘要，运行时副本与源摘要一致。

迁移 OUT 没有保留临时复制的 `run-evidence/` 原件树，也没有原生 V2 迁移前 catalog 原件；这些临时根已在 smoke 的 finally 中清理。本包因此另外自包含 `originals/b1-spec.tar.gz` 和 `originals/native-v2-spec.tar.gz`，各含对应 committed 源 catalog 与完整源 `run-evidence/`。打包时重新读取两套源 catalog SHA-256，并将全部 32 个源运行文件逐项匹配 smoke 保存的摘要。这些源材料支撑复核，不表示运行后的临时副本仍存在。

B1 来源：`docs/audits/2026-10-16/evidence/acceptance-catalog/console`，catalog SHA-256 为 `1108e814ace681ffff6933e1c4d8fda7c01e6011ede9feb5f47c38285cfe1cd9`。原生 V2 Spec 来源：`docs/audits/2026-10-16/evidence/acceptance-baseline/console`，catalog SHA-256 为 `2fd75752916f7e93e136f86909467f4a681380cb3a076efcc86bd4d3666ca501`。

两套源 run 的 manifest 均为 `mode=spec`。本片迁移验证不新增 Browser worker、不新增 Browser 绑定或执行，也不能据此宣称 Browser acceptance 通用可用。迁移汇总中的 `targetRequests=0` 与 `errors=[]` 属于这个迁移 smoke 的范围，其他场景的指标保留在各自原始汇总内。

## 字节完整性

本目录自带 `.gitattributes`，默认 `-text`；原始 JSON、日志 gzip、tar.gz、源码快照和 PNG 不经 Git 行尾转换。README 与属性文件单独使用 LF。顶层 `package-files.json` 记录出版文件的字节数和 SHA-256，明确排除清单自身及最后写入的 `COMPLETED.json`；完成凭据记录这份清单的摘要。脚本先复查全部源字节，再写汇总、README 和清单，逐项复算出版文件，最后才写完成凭据。提交后的 Git blob 仍应由协调者复核。

生成脚本在 `helpers/pack-evidence.mjs` 保存当次副本。实际运行位置为 ignored 的 `core/workspace/_runs/schema3-gates-20261017/pack-evidence.mjs`：默认 `--inspect` 只读检查；只有显式 `--publish`、全部必需阶段成功、实现摘要未漂移且目标不存在时才写新目录。所有输出使用 new-only 写入；打包失败不会覆盖、修补或删除已经留下的文件，需保留现场并另行协调。
