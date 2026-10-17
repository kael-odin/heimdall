# Browser 私有来源读取：有界捕获与 owner fence

日期：2026-10-17。本切片在 Browser 纯投影内核之外增加私有原件读取层；从真实 owner 的固定目录捕获双方所有实际引用，再交给显式选侧投影。模块、预算、错误和 alias 合同见[内部指南](../../competition/acceptance-browser-reading.md)。

## 已交付行为

新增独立 [browser-candidate-source.mjs](../../../core/src/acceptance/browser-candidate-source.mjs)，精确返回 `{ snapshot, files }`。使用已有 owner 的私有品牌，不获取 owner、不恢复锁、不创建目录。root / run / 文件身份、字节预算、regular file 与硬链接限制、两轮有界 fd 读取、EOF、最终 metadata 和 managed namespace 都参与核验。原始 gate 与完整 nullable 角色保留；所选侧资格由纯投影器独立判断。

四组原固定样本可被原生读取，完整性值与先前按原字节独立构建的交接值一致。原件和 Spec reader 均未改写。实际断言失败或所选侧导航失败仍能被 reader 捕获为失败材料，纯投影器拒绝不合格选侧；读取成功不会覆盖原始缺陷结果。

独立审查在新 reader 首次读取前复现了既有 owner 的目录替换窗口：取得 owner 后 rename 原 root、新建同名目录，并搬回同一个锁文件 inode，旧 owner.assertOwned 仍为 true、reader 接受 6 份材料。本片因此最小加强共享 owner：在 acquire 时固定 canonical root 身份，取得所有权过程、assertOwned、释放及失败清理均核对原目录。原成功复现保留；修复后相同操作实测 owner 和 reader 均拒绝 503，release=false，原锁 inode 与字节留在替换目录。普通内容新增及 alias 换向后的原 canonical 目录清理保持既有语义。

## 当前验证

| 检查 | 实际结果 |
| --- | --- |
| 最终 fresh reader smoke | 13/13；4 次新 Browser 运行、81 份原件、8 次成功捕获、2 次 owner 拒绝；8 个资格案例为 4 合格 / 4 拒绝；逐项核对所选侧原字节及 HTTP / 结构 / 断言 / 截图期望，17.314 秒 |
| 原件保持 | 读取前后文件字节、身份和被观测 metadata 一致；同步写入、fetch、进程启动观察事件为空 |
| reader 独立对抗测试 | 236 total / 236 pass / 0 fail / 0 skip；23 顶层与 213 子测试，51.134 秒 |
| owner root identity 专项 | 10 total / 9 pass / 0 fail / 1 skip；Windows 打开 lock FD 时无法 rename 目录的分支跳过，Linux CI 另验 |
| owner 旧回归 | 9/9；owner 与 capability 组合回归 11/11；均为独立重复验证，不累加总 suite |
| owned recovery 兼容复跑 | 37 total / 35 pass / 0 fail / 2 skip；24.687 秒 |
| managed executor 单文件复跑 | 原 15 秒等待预算，6/6 通过；全文件 50.886 秒，不能替代全量门禁 |
| 首轮基础门禁 | Core lint 438 文件通过；Console build 通过，保留既有大 chunk 提示 |
| 首轮完整 Core suite | 2087 total / 2076 pass / 2 fail / 9 skip，512.124 秒；原日志与失败现场保留，详见下文 |
| 最终完整 Core suite | 2087 total / 2078 pass / 0 fail / 9 skip，508.075 秒；墙钟 509.072 秒，exit 0 |
| Core smoke | 通过，35.157 秒；本地夹具 recon 2 页、visual / DOM 100%，live bundle / watch / jobs persistent 均成功 |
| Console → Clone CDP | 真实点击后 taskStatus=done、cloneStatus=200、pageErrors=[]；29.953 秒，原 JSON 与两张截图归档 |
| 最终语法与文档 | Core lint 438 文件通过；Markdown 684 个本地目标 / 197 文件通过 |

fresh 运行与独立故障测试分别保留原始日志，不将重复捕获、资格案例或重跑计为更多测试。这里的浏览器证据来自本地固定页面，没有真实外部部署、账号或完整业务状态机。

[证据目录](evidence/browser-reading/README.md)保存完整首轮失败与最终成功阶段、专项日志、目录替换前后探针、性能与 junction 探针、CDP JSON / 截图以及最终 fresh 材料。[source-files.json](evidence/browser-reading/source-files.json)记录 51 份归档工件的源文件大小与 SHA-256；其中完整 fresh 原件压缩包包含 86 文件，已解包逐文件比较原始字节。stdout / stderr 为无损 gzip，原运行目录继续保留。该片自己的远端 CI 在提交后独立核对，先前纯投影提交的 CI 不能替代本片验证。

## 本提交远端 CI

已发布提交 `ee4d1a7e731811b0df3a0b9d27a177d2cf851689` 的自身 CI run `38992636174`、attempt 1 于 2026-10-17 01:51:59Z—02:13:20Z 完成，三个 job 全部成功。Core job 21 分 18 秒；Linux Core 为 2087 total / 2083 pass / 0 fail / 4 skip，cancelled / todo 均为 0。四个 skip 是两项 Windows 专用及两项待独立 Docker 执行的测试；此环境执行了本机因打开 lock FD 而跳过的 root rename 分支。

13 项 acceptance smoke 全部成功，其中新私有 reader 为 13/13、4 次 fresh Browser 运行、8 次成功 capture、2 次 owner 拒绝，8 个选侧案例为 4 合格 / 4 拒绝，观察的 forbiddenReaderEvents 为空。独立 Docker 检查 2/2、0 skip，不加进 Core suite 总数。

[CI 原始日志、JSON 与摘要](evidence/browser-reading/ci-main-ee4d1a7/README.md)已落盘。完整日志 1,551,632 字节，SHA-256 `d50451783994e29274bdf582970a22a672d0ec38f2d66876923460f662a6ea2f`；原日志 ZIP 437,529 字节、59 entries 可读，SHA-256 `5f905816591edcc4d39be44feef8a9a26202049ec3d65ac33904f71a14cb991c`。归档逐字节及 gzip 回环核对通过，强密钥格式扫描无命中。Actions artifacts=0，远端 fresh 截图原件树没有随该成功 run 上传，不能把日志归档表述为远端截图归档。这份 CI 只覆盖该精确提交，不覆盖随后 Schema3 工作。

reader 专项覆盖四组真实固定材料、52 个实际引用逐个缺失或损坏、nullable 两向材料、品牌 / root / run / alias / 链接、fd 短读与预算、JSON 复杂度、采集阶段竞态、managed 隔离及返回值隔离。最初专项有两条注入计数断言误报及对应父分组失败；修正测试计数后保留全部轮次，不将首轮失败改写为通过，也没有因这两条误报修改产品实现。

## 首轮失败与性能归因

owned recovery 旧测试在首次 lstat 时移走 root，原先预期 `ACCEPTANCE_RECOVERY_BLOCKED`。新增 owner 身份校验在更早位置发现原目录消失，实际返回 `ACCEPTANCE_OWNER_LOST`、HTTP 503。测试精确更新为该错误，并继续核对无写入、原 manifest 未改和 absent legacy root 的兼容行为；没有放松目录保护。

managed executor 的 same-key 用例在第二次 fresh execution 等待 completed 时超出原 15 秒预算：最后成功轮询在 10.548 秒，run 仍为 running、完成 1/2；16.806 秒出现一次 `ECONNRESET`，共 9 次轮询。磁盘随后记录 completed / passed，`endedAt-createdAt` 为 15.393 秒、job done 为 17.984 秒，两个目标请求均完成，pending 为空且 engine 存活。独立原文件复跑 6/6 通过，未调整超时；其中原失败用例的 16.356 秒是整个用例时长，不能当作单次 waitRun 时长。

针对 owner 加固另做安静环境交错 old HEAD / current 对照。每版 6000 次 owner.assertOwned 的每次中位数由 0.802 增至 1.830 毫秒；40 轮 head 加前后两次 owner 的模型由 75.245 增至 77.004 毫秒，约增加 2.34%；dispatch 加一次 owner 的模型由 7.131 增至 8.117 毫秒。owner-free head / full snapshot 中位数分别变化 0.240 / 0.599 毫秒。原生调用观察确认旧 owner 为 1 次 realpath / 1 次 lstat，加固后为 4 / 3；head 读取本身为 163 / 163。

这些是本地安静环境的微基准；带 owner 的组合是成本模型，并非生产 route 的累计测量，不能据此排除全量负载的放大作用，也不足以把那次超时单独归因为 owner 或网络偶发。当前保留原超时和身份保护，以完整门禁重跑结果报告现状。独立 ancestor junction 复现也表明，全局删掉 canonical realpath 会改变 release 的目录合同；本片没有为局部毫秒开销放宽该保护。

## 交付边界

本切片没有接入 Browser 目录写入、项目归属、批准、选用、HTTP/UI 或 executor；返回的原始字节仅在服务器内部使用。纯投影器与 Spec 原读取器保持冻结。requested root 采用 canonical resolution fence，不冻结同目标 alias 链接实体；最终 fence 不构成跨文件原子快照或永久部署证明。

下一阶段需要显式 `(runId, side)` 的来源绑定合同，将所选 plan URL 与独立 release URL 校核，保留现有 target-only run binding 的历史语义；随后接入完整批准预览、选择和固定来源执行。
