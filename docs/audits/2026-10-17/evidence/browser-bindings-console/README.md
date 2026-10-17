# Browser 来源归属控制台：片 C 本机证据

完整 Core：**2273 total / 2264 pass / 0 fail / 9 skip**，553978.1225 ms。九阶段串行命令均 exit 0，source-before/source-after 与当前 12 份冻结源码逐项一致。

专项 DTO **20/20**；最终 HTTP **34/34**（新 HTTP 28 + 原 catalog API 6）；fresh UI **14/14**，2 个 fresh source runs、3 次归属 POST、16 次 capture 目标请求，归属与读取新增目标请求 **0**。独立 finish review 检查 8 张截图，结论 ship、0 material findings；documenter 已完成只读文档核对。

本包的来源是本机受控夹具和串行门禁。报告中的完整 Core、专项测试、fresh UI checks、既有 smoke 回归分别记数；它们有重叠，不相加为一个通过总数。fresh 原比较仍然 failed，这正是保存 BUG 事实的夹具结果，不会被组织归属改写。

`provenance.json` 保留 `sources / stages / groups / archives / copies`。每组完整原件只归档一次到 `originals/*.tar.gz`，相邻 `.files.json` 列明原目录内完整文件集合、长度和 SHA-256；打包后在 ignored 验证目录完整解包，与原文件逐项比较字节。`gates/` 保存九阶段 command/exitcode、source-before/after、原始 detector 与运行器；日志采用无损 gzip，并记录解压前长度、SHA-256 和 round-trip 结果。

`browse/` 只保留必要摘要、fresh 的八张 PNG、CDP clone 两张 PNG、selected-side DTO 和独立 review/documentation；完整 DOM、请求、错误、运行报告、PNG、runtime、DB/WAL/SHM、失败尝试均在完整组归档内。没有再次复制整棵巨大运行树。`source/` 是门禁冻结的十二份精确实现文件；`implementation/` 保留打包器、输入计划和本草稿。

保留所有已知专项尝试：DTO 20 项的 wx 原日志；HTTP 三轮分别 26 total / 20 pass / 6 fail、34 total / 32 pass / 2 fail、34 total / 34 pass / 0 fail，失败计数包含父节点。早期失败来自测试预期与原合同不一致，未修改产品迁就测试。最初 UI helper 的 21 项与 build 只有工具输出，没有 wx 原始日志，本包不补造；最终完整 Core 覆盖冻结的 helper 测试文件。

fresh 默认命令的 wrapper 与 `smoke-source.mjs` 原件纳入归档，并要求脚本字节与最终冻结实现相同；两个真实 worker 的运行原件在 smoke runtime 中保留，`source-file-digests.json` 的 before/after 与运行文件逐项匹配。14 checks、3 次归属 POST、16 次 capture 请求、归属与重读新增请求 0 均交叉核对原记录。来源变化和网络故障是明确测试注入，不能解释为所有站点通用验收。

独立 finish reviewer 读取所提供的 fresh 截图和源码，8 captures / 0 material findings / ship；documenter 只读核对并落盘，没有重新跑浏览器、测试、build 或 detector。detector 的唯一 side-tab 边线在父提交已存在。该窄片不修复全局设计文档历史偏差，也不证明独立键盘或数值对比度验收。

当前 Browser 流程仅做明确来源侧归属、历史列表和按需来源核对/受保护证据查看，不提供 Browser 候选、批准、选用或执行。完整 query 继续属于内部身份和原始受控证据，新的显示 DTO 隐藏整段 query；旧 URL 端点与显式原始证据属于独立边界，不能据本包声称全引擎匿名化。

`package-files.json` 包含完成前全部已发布文件，明确排除自身与 `COMPLETED.json`；完成凭据锚定该清单。只有所有原件发布前后 SHA 不变、逐组集合与字节 round-trip、九门禁和源码快照均通过后才写凭据。目录及每个输出均 new-only；出现无完成凭据的目录即不完整尝试，不会覆盖或自动续写。原件和验证目录保持保留。

本包不包含远端 CI。片 B 的精确 CI 已独立归档，不能与本机片 C 结果互相替代。根任务还会独立执行敏感模式、tar/gzip、清单与 Git index 字节核验；本包不把打包器自身的校验声称为独立复核。
