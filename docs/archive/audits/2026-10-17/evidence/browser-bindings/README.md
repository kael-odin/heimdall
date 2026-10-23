# Browser 来源侧归属：本机证据

本目录冻结 2026-10-17 的内部 Schema3 / store 绑定实现与本机验证，实际范围见[实施验收](../../acceptance-browser-bindings.md)和[操作指南](../../../../competition/acceptance-browser-bindings.md)。本片没有 HTTP / UI、Browser 批准、选用或托管执行授权。

[summary.json](summary.json)记录各专项与一次完整 Core 的实际数字。[provenance.json](provenance.json)记录命令、时间、原始输出目录、源码摘要、完整原件索引、副本和打包回环。[package-files.json](package-files.json)列出每份包内文件的大小和 SHA；它排除自身及最后独占写入的 [COMPLETED.json](COMPLETED.json)。未出现完成凭据的目录应按中断现场处理。

## 真实采集与绑定

最终默认命令 `pnpm acceptance:browser:bindings:smoke` 的源脚本在执行前后摘要相同，30/30 检查通过。mirror 与 regression 各一次新 Chromium 采集，两侧健康且有预设外观差异，因此两个比较 gate 都为 failed。采集后建立 4 条侧归属并读取 6 次；期间目标请求、fetch、进程启动和新执行运行均为 0。

- [最终摘要](browse/fresh-smoke-final/summary.json)、[归属与完整预览](browse/fresh-smoke-final/bindings-and-previews.json)、[请求记录](browse/fresh-smoke-final/target-requests.json)。
- [最终完整材料](originals/fresh-smoke-final.tar.gz)包含 runtime 原件和独立复制的 run 树；[逐文件索引](originals/fresh-smoke-final.files.json)按它们的实际路径分别记录。复制材料不计为更多运行。
- [原始执行命令和验证记录](originals/fresh-smoke-commands.tar.gz)保留 stdout / stderr、默认运行的源码摘要、拒绝覆盖探针及独立字节核对。
- [早期显式 OUT 的完整材料](originals/fresh-smoke-initial.tar.gz)为独立历史轮；随后仅补建默认输出的父目录，最终源码另做默认运行。两轮不累计合同覆盖。

## 专项、全量与兼容流程

- [纯 Schema 最终专项](originals/schema-final.tar.gz)：75/75，含原 Spec / Browser projector 与固定 golden；[早期专项](originals/schema-initial.tar.gz)74/74 单独保留。
- [Store 最终专项](originals/store-final.tar.gz)：58/58，含 10 个分组父节点和 48 个叶子用例。
- [Store 首轮失败](originals/store-initial-failure.tar.gz)：57 total /54 pass /3 fail，实际失败叶子 2 项。新测试对 reader running 错误码及既有 prepare 空 namespace 的预期已校正，产品与超时预算保持。首轮不计入最终通过数。
- `gates/` 保存 lint、build、一次完整 Core、Core smoke、Catalog / migration / Spec baseline 浏览器回归、managed preparation、执行工作台和 Console→Clone CDP 的命令、退出记录与 gzip 原始日志。
- [Catalog](originals/catalog-console.tar.gz)、[Schema3 迁移](originals/migration-console.tar.gz)、[Spec 基线](originals/baseline-console.tar.gz)、[managed 准备](originals/managed-preparation.tar.gz)、[执行工作台](originals/execution-ui.tar.gz)、[Console→Clone CDP](originals/cdp-clone.tar.gz)完整原件均独立成包。

所有 tar 均解压到新的 ignored 验证目录，核对完整文件集合、长度、SHA 和逐字节内容；gzip 日志核对解压原字节。`source/` 为门禁前冻结的本次实现文件，未改依赖由 provenance 内 parentHead 定位；它不是本片已提交 SHA 的声明。

## 证据边界

本机完整 Core、专项和真实浏览器检查互有重叠，分别记录，不相加。Windows skip 保留为 skip。受控站点验证声明合同，不证明外部部署、认证业务、全部真实项目或跨调用永久 inode 固定。两次 capture 之间逐字节相同的来源重建可以通过完整内容 guard。

本目录不包含远端 CI；上一片 Schema3 提交的精确 CI 另行归档，本片发布后的 CI 也需要按自身 SHA 核对。最终文档链接与暂存字节核验属于包完成后的独立发布检查。
