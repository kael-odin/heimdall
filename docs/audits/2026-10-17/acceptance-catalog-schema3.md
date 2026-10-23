# Schema3 分步迁移与 Spec 历史兼容

日期：2026-10-17。基于已发布的 Browser 私有读取片 `ee4d1a7`，本片为后续 Browser 选侧归属建立目录格式基础。合同与命令见[内部指南](../../competition/acceptance-catalog-schema3.md)。Browser 来源表当前严格为空，不增加批准、绑定、UI 或执行授权。

## 实现与边界

旧 V1/V2 的严格验证和原 `1→2` 构造器保留，新增 V3 验证与独立 `2→3` 构造器。新目录直接为 3，旧目录由 initializer 队列逐步迁移；每步独立换 generation、增加 revision 和全局迁移事件。前像按原件实际版本分别保存，不改原始运行、实体、摘要或历史事件。最新 head3 初始化同样核验 rolling previous，合法 head 仍可诊断读取。

第二步失败时保留已经提交的有效 V2 及真实前移现场，重启仅续迁第二步。严格相邻桥接拒绝 `head3 / previous1`、来源 raw bytes 格式差异、generation 不符和实体 / 事件分叉。原始前像仍通过排他发布保留，没有删除或自动回滚。

## 当前验证

| 检查 | 实际结果 |
| --- | --- |
| 纯 schema 专项 | 23/23；原 11 项与新增 12 项，0 skip |
| 迁移专项 | 最终 97/97，0 fail / 0 skip；2.452 秒；首轮 91/91 与中间轮 93/93 分别保留，不累计 |
| Catalog / Baseline / Managed / API 兼容 | 61/61，0 fail / 0 skip；17.760 秒墙钟 |
| 真实迁移 smoke | 成功，15/15 检查、16 个 API 用例；15.753 秒；旧目标请求 0，页面错误 0 |
| B1 迁移后的 Spec 完整性回归 | 15/15，0 fail / 0 skip；校验两条迁移事件后继续创建候选、批准、取消及重选，重启保持历史 |
| 完整 Core suite | 最终 2130 项 / 2121 通过 / 0 失败 / 9 skip；512.822 秒，独立重试日志 exit 0 |
| Core lint / Console build / Core smoke | 均成功；lint 440 文件；Core smoke 真实两页、跨 origin 样式、live bundle 和持久任务检查通过 |
| Catalog / Baseline 浏览器回归 | 均成功，分别 18.727 / 25.091 秒 |
| Managed 准备内核 | 成功，1.657 秒；该阶段没有启动引擎、浏览器或执行请求 |
| 执行 UI | 成功，16/16 检查；89.509 秒；覆盖重复点击、响应乱序、刷新恢复、共享运行槽、停止和桌面 / 手机布局 |
| Console→Clone CDP | 成功，29.574 秒；真实按钮操作，taskStatus=done、cloneStatus=200、pageErrors=[] |
| 文档链接 | 成功，694 个本地目标 / 201 份 Markdown；exit 0 |

早期兼容探针为 61 项 / 60 通过 / 1 失败：测试把 `schemaVersion=3` 当作未知格式；该版本现已支持，所以将这条负例精确改为 4。没有更改无效 run / dispatch envelope 的 `schemaVersion=2` 反例，也没有为该测试放松 validator。最终 61 项已完整重跑并落日志；早期工具输出是诊断观察，不计作更多覆盖。

完整 Core 首轮为 2130 项 / 2120 通过 / 1 失败 / 9 skip，514.426 秒。唯一失败在 `acceptance-baseline-integrity.test.mjs` 的 B1 迁移回归：旧断言预期 `revision + 1`，实际 `1→2→3` 应为 `revision + 2`（该夹具实际 5、旧预期 4）。修正后明确核对 Schema3、两条有序迁移事件与各自 fromRevision，并保留原 Spec 历史前缀、批准及选用的全部断言。该修改只更新测试合同，没有更改产品代码、来源保护或超时预算；随后专项 15/15 通过，完整 suite 另存新日志重试。首轮失败不计入最终通过数。

完整 V2 历史分别覆盖原生 V2，以及先经 `1→2`、随后形成 Spec 候选 / 批准 / 取消 / 重选的 V2。逐实体序列化字节及 digest、旧事件前缀、原选用 ID 和源 run 字节保持不变；在 3 上仍能重验候选并准备 managed dispatch。独立专项覆盖第二步各发布阶段失效、两文件字节变化、原件保存与重启。

真实引擎 / 浏览器验证采用历史夹具副本，B1 原件 18 文件与原生 V2 Spec 原件 14 文件保持不变；V2 历史包含 2 候选、5 批准、7 选用 / 取消。桌面与 390px 下可读取原失败报告、迁移后组织归属及原 Spec 历史和当前选用；检查旧目标请求、意外 worker 创建与页面错误。它不证明真实外部部署、账号业务或 Browser 批准能力。

## 证据与范围

[本机完整证据](../../archive/audits/2026-10-17/evidence/catalog-schema3/README.md)保留最终门禁、首轮完整 Core 失败、专项各轮、真实流程输出、直接可浏览截图、冻结源码和 SHA 清单。日志 gzip 及完整材料 tar 均回环核对原始字节，提交前再独立核对清单和 Git 暂存字节。完整 Core 的 9 个 skip 保留为 skip，不计为已通过；此前 Browser reader 提交的独立 Linux CI 也不作为本片的 CI 结果。

证据包实际为 249 文件、8,514,055 字节；8 个 tar 包含 179 份原件，225 份副本 / gzip 回环通过。协调者使用独立脚本再次检查 247 项清单、完整文件集合、225 份来源与副本及 8 包解压后的 179 份文件，结果一致；76 份源码快照、32 张 PNG 和 14 条布局记录均按实际集合计数。完成凭据为最后独占写入的 `COMPLETED.json`，包内清单明确排除自身和这份凭据。

首次暂存空白检查将冻结迁移测试副本的 CRLF 识别为尾空白。原件保持不变，在证据父目录只为这一精确路径声明 `whitespace=cr-at-eol`；没有转换其字节或重写摘要。独立暂存字节核对覆盖本片证据与前片 CI 归档，强凭据格式扫描（含解压日志和材料）无命中。

迁移输出目录有 34 份原件和 7 条布局记录、12 张截图；其中没有仍存活的临时复制 run 树。归档另收两套已提交 Spec 源夹具的 catalog 和完整 run 原件，并把 32 项源文件 SHA 与 smoke 摘要逐项匹配。源材料、运行时副本摘要和迁移输出是不同证据，不将它们合并计作更多运行。

这是本机受控真实流程与离线对抗回归。当前 Browser 表严格为空，下一片才实现显式选侧归属；Browser 的批准、选用与托管执行仍待后续接入。

## 本片发布后的独立 CI

提交 `db3cd3fd9efe7e46ae079cab8d529e64a14b842b` 的 main push 运行 `38996824641`（attempt 1）于 2026-10-17 完成，三个 job 均为 success。Linux 完整 Core 为 **2130 total / 2126 pass / 0 fail / 4 skip**；13 条 acceptance smoke 全部成功，Docker 独立步骤 **2/2**。远端与本机的平台 skip 不同，分别按各自日志计数，不互相代替或累加。

[精确 CI 归档](evidence/catalog-schema3-ci-main-db3cd3f/README.md)保留 API 元数据、jobs、原始日志 ZIP、完整解压日志、原始命令与 SHA 清单。该运行没有发布 Actions artifacts，因此归档不包含远端临时 fresh 截图树，也不据此声称完成远端截图字节复播。这份结果仅覆盖 Schema3 迁移提交；后续 Browser 侧归属实现需要核对自身提交的 CI。
