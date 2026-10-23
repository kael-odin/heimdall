# Browser 来源侧归属实施验收

日期：2026-10-17。基于已发布的 Schema3 迁移提交 `db3cd3f`，本片增加严格来源实体、双向 target 归属约束、绑定提交前完整来源重建，以及服务器内部单条只读复核。[内部操作指南](../../competition/acceptance-browser-bindings.md)说明实际合同和边界。

## 实现范围

每个 `ax-UUID` 将明确 `(runId, side)` 归属到 project / release，保存完整纯 Browser 来源投影摘要。全库同 run + side 唯一；baseline 与 target 分开，target 与旧 runBinding 在两个写入方向及 schema 全库核对项目、版本 ID。完整 planned entry URL 严格匹配版本 URL，包含 query。

绑定使用真实 owner、私有 reader 与纯 projector；在 rolling previous 发布后、head 提交前再次捕获并比较完整投影。变化拒绝新 head，owner / root 失效保持 503。单条读取只复核来源与固定摘要，不写目录、不修复材料、不访问目标或启动 runner。Browser source digest 使用原 domain 公式，组织上下文由完整实体事件摘要覆盖，既有黄金投影不变。

本片不增加 HTTP / UI、Browser 候选、批准、选用或托管执行；返回始终 `executionReady:false`。Spec 链与 managed 合同独立回归。

## 当前验证

| 检查 | 实际结果 |
| --- | --- |
| 纯 schema、原 Spec / Browser projector 与 golden | 最终 75/75，0 fail / 0 skip；32.888 秒；首轮 74/74 单独保留，不累计 |
| Store 归属、事务与单条读取 | 最终 58/58，0 fail / 0 skip；62.783 秒；包含 10 个分组父节点和 48 个叶子用例 |
| Fresh mirror / regression 来源绑定 | 最终默认命令成功，30/30；28.363 秒；两个真实 Chromium 运行、4 条侧归属、6 次单条重读 |
| 完整 Core | 2204 total / 2195 pass / 0 fail / 9 skip；540.992 秒；一次完整最终运行，exit 0 |
| Core lint / Console build / Core smoke | 均成功；lint 444 文件；Core smoke 覆盖两页、跨 origin 样式、live bundle、watch 和持久任务 |
| Catalog / Schema3 迁移 / Spec baseline 浏览器回归 | 分别 17 / 15 / 13 项检查成功；14.577 / 16.092 / 22.665 秒；迁移另有 16 个 API 用例 |
| Managed 准备 | 25/25；1.749 秒；没有启动引擎、浏览器或执行请求 |
| 执行工作台 | 16/16；95.292 秒；真实重复点击、未知响应恢复、共享槽、停止与手机布局 |
| Console→Clone CDP | 29.900 秒；taskStatus=done、cloneStatus=200、pageErrors=[]，真实按钮操作与截图 |
| 文档链接与独立发布检查 | 732 个本地目标 / 206 份 Markdown，exit 0；独立原件、清单、gzip / tar 回环与强凭据格式扫描通过 |

独立审查核对完整 projection 比较、初次 / 提交后错误语义、任意 503 传播、双向 stored target 归属、单条读取无 writer 路径、真实 owner 品牌，以及 V1/V2 和迁移事件顺序，未发现阻塞缺陷。

Store 首轮为 57 total / 54 pass / 3 fail；其中包含失败父分组，实际叶子失败 2 个。两项均是新测试对既有合同的预期不准确：把 manifest 改为 running 后，reader 实际返回 `SOURCE_INTEGRITY_FAILED /409`、reason=`SOURCE_SNAPSHOT_INVALID`；未选用 Spec 基线时，既有 managed prepare 会初始化空 namespace，但不产生 dispatch record 或新 run。修正新测试后完整专项重跑；没有为它们改变产品、单条读取的零写断言或超时预算。

真实采集的 mirror / regression 都是 completed、comparison gate=failed：两侧页面健康，受控 target 有预设外观差异。每条运行包含 29 份原件、26 个 evidence 条目和 14 项比较检查；健康侧仍可绑定，原比较结果保持。采集阶段共 16 次受控目标请求；绑定和读取阶段目标请求、fetch 及进程启动均为 0。Browser candidate / approval / selection 和新增执行运行均为 0。最终默认命令与早期显式 OUT 命令分别保留，不累计为更多合同覆盖；早期运行后仅补建默认输出的父目录，最终源码又完整重跑。

## 完整证据与发布状态

[本机证据包](../../archive/audits/2026-10-17/evidence/browser-bindings/README.md)共 **249 文件 / 10,750,555 字节**，13 个 tar 保存 440 份完整原件，217 份直接副本或日志 gzip 回环通过；11 份本次实现源码在完整门禁前后保持相同摘要。最终 fresh OUT 为 130 文件 / 2,116,169 字节，包含 runtime 原件与独立复制的两条 run 树；它们是同次采集的不同证据副本，不能算成四次运行。

包内保留专项首轮失败、纯 schema 两轮、store 最终重试、fresh 两轮及其命令/检查、六套兼容流程完整输出和 CDP 证据。打包器对每个 tar 解压核对完整集合、大小、SHA 和原字节，最后独占写入完成凭据。协调者另行核对来源、gzip、解包文件及 Git 暂存字节；[独立发布检查](evidence/browser-bindings-publication-checks/README.md)记录文档链接与强凭据模式扫描的实际结果。完整 Core、专项、UI 和 fresh 检查分别计数，不累加重叠覆盖。

上一片 `db3cd3f` 的精确 CI 已单独归档并记录于[Schema3 验收](acceptance-catalog-schema3.md)，不作为本片 CI。来源归属本片提交 `3b7af9ae644cba0f1b045fe58b29fcb48268d4e0` 的自身 [CI 归档](evidence/browser-bindings-ci-main-3b7af9a/README.md)现已完成：run `39000366975`、attempt 1、main / push，三个 job 全成功。Linux Core **2204 total / 2200 pass / 0 fail / 4 skip**，14/14 验收 smoke、独立 Docker 2/2 全部通过。

该 CI 包共 **114 文件 / 6,634,876 字节**。GitHub 原 ZIP 为 458,402 字节，含 60 entries / 60 份日志 / 2,070,355 解压字节；逐份核对 ZIP 原字节、CRC、SHA 链，gh 与 ZIP 的 Core / Docker TAP 及 14 份 smoke JSON 一致。按记录的六类强凭据模式扫描 60 份日志为 0 匹配；Actions artifacts 为 0，没有远端截图或 run 树可归档，也未用本机材料冒充。

原日志真实尾空格保留，包内精确 Git 属性只控制相关原文本的行尾与空白检查；首版元数据和一轮本机收尾失败现场保留在 history。最终完成链与 86 份原输出逐字节复核通过。这个 CI 只对应来源归属本片，后续 [HTTP / 工作台接入](acceptance-browser-bindings-console.md)另做自己的质量门和提交 CI。

## 证据边界

每次 capture 内部的 run / 文件身份固定，不等于跨两次 capture 的永久 inode 固定；两次捕获间逐字节相同的重建可保持相同投影。绑定声明项目入口归属，不证明远端部署永久不变、完整重定向查询参数、全部业务正确或认证状态。

本机专项、首轮失败、最终重试、fresh 真实流程与远端 CI 分开记录，不将重叠测试数量相加。后续 HTTP 列表将仅展示 stored summary，单条读取再复核，避免把列表访问扩大成全库 PNG 解码。
