# 验收项目目录格式升级

日期：2026-10-16。范围：B2.0 存储升级与原项目目录流程兼容。对应[项目目录指南](../../competition/acceptance-catalog.md)，前一批实施与原始证据保留在[项目与版本记录](acceptance-catalog.md)。

本批为候选验收标准、批准记录和选用历史准备独立的格式边界。活动目录从 schema1 升到 schema2；候选、批准、选用集合仍严格为空。本批没有增加批准入口、托管执行、Browser 来源锁或持久缺陷关闭。

## 已实现的行为

- 独立严格验证 schema1 / schema2，不给旧对象静默补默认值，不接受未知版本或非空的尚未实现集合。
- 新建目录直接使用 schema2，revision=0；旧目录在已有 owner 和写入队列内升级，更换 generationId，revision=R+1，仅追加一个全局迁移实体和事件。
- 原项目、不可变版本、运行归属和事件前缀完整保留。全局迁移事件没有 projectId，不冒充项目操作。
- 升级前活动 head 与 previous 原字节按 SHA-256 去重，排他保存到最多两份 `catalog.v1.<sha256>.json`。全部容量、路径和已有前像一致性先预检，再发布完整前像。
- 同格式 previous 需同 generation，且是完整事件和不可变实体的历史前缀或相同快照。跨格式只接受迁移记录证明的 schema2 head + 精确 schema1 head 前像组合。
- 持久化前后检查 owner、根身份和原字节。先更新 rolling previous，再原子提交 head；head 是唯一语义提交点。失败时保留原件，重启可以按明确状态重试。
- 初始化迁移失败时读写不会退回 schema1；旧页面的 generation/revision 请求失效。正常重启不产生第二次迁移。

## 验证记录

真实旧数据迁移与浏览器流程已通过：**11/11 检查组、12 项 API 断言**。测试复制前一批已提交的真实 schema1 目录及三个 Spec run，不运行新的验收 worker；原件位于旧证据目录，全程只读。

| 验证层级 | 本批结果与证据 |
| --- | --- |
| 全量 core | **1155 项，1153 pass、0 fail、2 Docker 条件 skip，216.9 秒**；[最终摘要](evidence/acceptance-catalog-migration/checks/core-tests.txt) |
| 文件系统单测与故障注入 | schema / migration **77/77 通过，0 skip**；[原始输出](evidence/acceptance-catalog-migration/checks/focused-tests.txt) |
| 真实引擎与浏览器迁移 | **11/11 检查、12 API 断言、0 errors**；[检查清单](evidence/acceptance-catalog-migration/console/migration-checks.json)、[API 观察](evidence/acceptance-catalog-migration/console/api-cases.json) |
| 旧项目目录流程回归 | **17/17 检查、31 API 观察、0 目录目标请求**；覆盖真实 Spec worker、并发 CAS、双引擎及别名、重启和控制台；[结果](evidence/acceptance-catalog-migration/checks/catalog-browser-checks.json) |
| 原件与迁移副本 | **18/18 run 文件 SHA-256 保持一致**；[逐文件摘要](evidence/acceptance-catalog-migration/console/run-file-digests.json) |
| 桌面 / 手机 | 1440×1000、390×844，目录、归属和原失败报告无横向溢出；缺来源在独立副本验证；[8 张截图与原始 JSON](evidence/acceptance-catalog-migration/README.md) |
| lint / console build | **331 文件语法检查通过**；构建通过，保留既有 Graph3D 大 chunk 提示 |
| 文档链接 | **345 个本地目标 / 107 文件通过** |
| 基础克隆 smoke | recon 2 页、视觉与 DOM 100%、live bundle 通过、watch 与持久任务通过；[输出](evidence/acceptance-catalog-migration/checks/forge-smoke.txt) |

原始全量日志保存在忽略目录 `core/workspace/_runs/acceptance-catalog-migration-full-tests.log`。第一次全量还拾取了忽略目录中的临时探针，已将探针保留并改名，重新跑正式套件，采用上表的 1155 项结果。代码、脚本与测试的[验证时文件指纹](evidence/acceptance-catalog-migration/checks/source-file-digests.json)随本批归档，按 UTF-8 无 BOM、CRLF 规范化为 LF 后计算，兼容 Git 行尾转换；运行原件摘要仍按原始字节计算。[质量门摘要](evidence/acceptance-catalog-migration/checks/quality-gates.json)记录命令及结果。

真实旧目录包含 5 项目、5 版本、2 个归属、12 个事件。迁移后 revision **12→13**，旧实体和事件内容完整保留，独立迁移事件无 projectId；两次真实重启的目录字节均保持不变。之后新增一个项目、版本和归属，revision **13→16**，原 B1 流程继续可写，候选、批准和选用集合仍为空。

旧 generation 分别搭配旧 revision / 当前 revision 提交，都得到 409；原失败 run 的 API 和控制台门禁仍为失败。源缺失时保留 binding，单独显示 SOURCE_UNAVAILABLE，未将其算作可信证据。Node fetch / HTTP(S) 和测试浏览器针对旧夹具 origin 的请求阻断与计数为 **0**；数据根也未产生新 run。

真实旧 head 的 SHA-256 为 `1108e814ace681ffff6933e1c4d8fda7c01e6011ede9feb5f47c38285cfe1cd9`。[前像结果](evidence/acceptance-catalog-migration/console/migration-preimage.json)确认排他归档与原输入字节完全一致。此真实夹具没有提供 rolling previous，迁移记录的 sourcePreviousSha256 因而为 null；双前像及 previous 谱系由独立文件系统测试覆盖。

故障注入覆盖两个归档写入点、rolling previous、最终 head、head 已提交但调用报错、owner 丢失、根 inode 替换，以及提交前 head / previous 字节变化。无提交的失败不产生成功事件；已提交但响应失败的重启只认现有 head，不再次迁移。相同文件名的排他创建竞争只在字节完全一致时复用。坏备份、非祖先、未知格式、目录/路径别名、事件/字节/前像容量不足均保留原件并拒绝写入。这些是确定性的文件系统故障注入，不构成真实断电耐久证明。

上一提交 `8353595a555329e0ead1fb86688b6c01dbb9f67e` 的远端 CI `38905792592` 已于 2026-10-16 21:27（UTC+08:00）完成，三个 job 全部成功。全量 core 为 1078 项、1075 pass、0 fail、3 skip；独立 Docker 无外联验收 2/2 通过。该结果只证明上一提交，不能替代本批改动的验证。原日志保存在忽略目录 `core/workspace/_runs/ci-8353595-success.log`。

## 数据与能力边界

目录仍只保存组织和迁移记录；版本 URL / buildRef 是操作者声明。格式升级不验证、修复或改写历史 run，不使 manifest-only 归属获得可信报告资格，也不改变原失败门禁。

前像排他发布依赖同文件系统硬链接；不支持时安全拒绝升级。rolling previous 与 head 是两次写入，未声明跨文件原子性或断电耐久。最后一次 head 替换失败时 previous 可能已推进，原 head 与独立前像仍保留。没有自动恢复、原件清理、降级写入或从历史来源启动新运行的接口。

下一切片是仅 Spec 的来源完整性核验、候选合同预览、显式批准和选用历史；批准与执行分开，不能从目标实际响应反推 expected。Browser 基线须另做来源锁和所选侧 oracle 投影。
