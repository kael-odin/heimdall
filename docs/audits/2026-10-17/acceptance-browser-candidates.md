# Browser 完整复核、候选保存与历史重读

日期：2026-10-17。D2 基于 `c170f503964601b7d125c2f902760c1235cc2e39`，实现“已有 ax → 完整来源复核 → 明确保存 bc → 刷新或重启读取同一 bc → 按需重核验来源”。操作和 API 说明见[使用指南](../../competition/acceptance-browser-candidates.md)，原件见[证据索引](evidence/acceptance-browser-candidates/README.md)。

## 实现范围

复核构建器使用严格 private reader 捕获的全部来源材料，独立校验五块清单和摘要，保留完整原计划的 JSON key 顺序、URL query、步骤和断言字面量。完整 DTO 明确 `completeSourceProjection:true`，普通归属展示 DTO 保持不完整和原有去敏语义。D1 的 Schema4 及来源、组织、候选摘要公式保持不变。

写入严格接受 generation、revision、sourceBindingId、contentDigest 四字段。写队列内检查 CAS、Schema4、项目和版本关系、重复 ax、计数容量，再完整捕获来源；previous 发布后重新核验完整 review，最后检查 head 原字节。每 ax 最多一条 bc，单次成功增加一个 revision 与事件。完整响应包含 candidate / event / lineage，提交前检查 12 MiB 预算；不通过截断规避预算。

单独图片接口只返回同次完整捕获中的所选侧 screenshot / repeat；collection 仅返回已存 metadata，不读取来源。坏来源的 durable GET 保留 candidate、返回 `review:null` 与诊断；所有权、root 或 catalog 故障仍为 503。晚期拒绝可能只旋转 previous，不能发布候选或事件。

前端完整明文仅留在内存，并通过文本节点与显式折叠展示。关闭、项目 / ax / bc / lineage 变化、ready 失效、取消读取及卸载时清理原文、确认和 Blob URL；ABA 与请求序列阻止迟到读取回填。合法 201 后目录刷新失败仍保留已确认事实；丢响应和坏 201 锁住提交，只允许先读 collection 按 ax + contentDigest 对账。

## 真实浏览器证据

最终 fresh smoke 使用真实 Mirror / Regression workers 与 Chromium CDP，**13/13** 检查通过，源码 557 项在本次运行前后相同。

- 受控 baseline / target 有视觉差异，两侧声明行为健康；原比较均保持 failed。完整计划展示有序 query、fill 值与断言字面量，全部十类明文块及行为观察可展开。
- 首次普通引擎创建 Schema3，原生工作台显示维护提示且不迁移；停止引擎，真实 CLI 预览并按完整 CAS 确认迁移至 4，普通重启后进入候选复核。
- baseline、target 分属两个项目版本，各保存一条独立 bc。baseline 正常保存恰一条 POST、一个事件和一个 revision；target 的 POST 在服务器真实返回 201 后，被测试代理精确改为一次 502，再通过原生按钮 GET 对账，未重发 POST。
- 专用截图和 repeat 均显示；同长度图片字节被受控改动后，前端 SHA 核对拒绝创建 Blob。项目 A→B→A 的迟到完整读取不能复活。
- 来源 report 增加空白是明确测试注入；坏来源下 metadata 历史保留，恢复原 bytes 后同一 bc 可重新复核。引擎重启后读取同 bc，catalog head / previous 不变。
- 所有来源文件最终 SHA / bytes 与原件一致；候选阶段额外 target 请求为 0；没有批准、选用或 dispatch。页面异常为 0，HTTP 错误仅允许精确注入的该条 POST 502，没有普遍过滤 409 / 404 / 503。
- 桌面 1440×1000 和手机 390×844、深浅主题四张有效截图；长 URL 换行、无水平溢出，所有创建的 Blob URL 在关闭与重启前撤销。

项目、版本和 ax 归属为明确标注的 HTTP 测试 setup；D2 复核、确认、保存、对账与重读使用原生 UI。完整复核不是新的执行授权，全部响应仍为 `executionReady:false`。

首轮开发 smoke 因测试误取最后一条观察而失败：来源观察排序不保证行为观察最后。改为依据返回 DTO 的步骤值选择对应 observation；没有改变产品断言或原 Acceptance console。失败截图、DOM、引擎日志与来源运行完整保留。后续两轮均 13/13，最终轮对应前端最后的 ready 失效清理。

## 本机验证

| 范围 | 结果与边界 |
| --- | --- |
| 完整 Core | 2379 total / 2367 pass / 0 fail / 12 skip；643532.9322 ms；557 项源码前后不变 |
| 语法 | 463 files；exit 0 |
| Console build | 439 modules；exit 0；保留原有大 chunk 提示 |
| 完整 review / source / projection 专项 | 278/278；包含既有来源校验；开发专项日志独立于最终整仓结果 |
| 新 store 专项 | 14/14；只读快照、重启、并发、计数容量、late guard、head CAS、owner loss 和 PNG 捕获 |
| 新 HTTP 专项 | 12/12；实际本地 HTTP、全部六种 Schema3 操作、方法 / query / 路径 / 16KiB 边界、损坏历史与安全错误序列化 |
| 前端 helper / SFC | 8/8 helper；JS syntax 与三 Vue parse / compileScript / compileTemplate 通过 |
| 新 D2 原生 UI | 最终 13/13；真实 CDP、引擎、CLI 维护和 worker |
| 旧入口与集成回归 | 原 Acceptance console 17/17；forge / Console→Clone CDP 通过；显式迁移 21/21；Spec baseline 13/13；managed execution UI 16/16；Browser Schema4 混合历史 19/19；preparation 27/27；八组全部 exit 0 |
| 文档链接 | 最终发布检查 843 个目标 / 232 份 Markdown，exit 0；首次 833 个目标与后续 837 个目标检查均保留，不回写已冻结的十二组门禁 |
| 远端 CI | 本片提交自身 Linux CI 单独核验；不沿用父提交通过步骤 |

store 开发轮全部 14 项通过，但其他代理当时仍新增源码，其包装器 `sourcesUnchanged:false`，不冒充最终冻结验证。最终完整 Core 已包含这组测试且 557 项源码不变。API 开发首轮两条断言把严格拒绝状态写错为 404，实际为 400；修正明确预期后 12/12，前次日志保留，没有放宽路由校验。

## D1 CI 的后续适配

父提交自身 CI 的[精确复核](acceptance-catalog-d1-ci.md)已完成，整轮 failure。完整 Core、原 Acceptance console、Linux 原生首次 fstat 时序和前序 Spec / catalog smokes 通过；旧 preparation smoke 因复制 Schema2 fixture 后依赖隐式升级而失败。

本片只修正其 setup，改为真实 owner 下显式 `previewMigration→完整确认→applyMigration`，原 25 项语义保留，新增两项维护检查。修正后本机 27/27，零 fetch、零 target 请求、零新运行；对应修复的 Linux 状态仍需本片自身 CI。CI 失败 artifact 现在补充完整 preparation 与 D2 UI 原件，避免只保留摘要而丢现场。Linux Core 已观察约 18 分钟，另有串行真实浏览器 smokes，job 上限调整为 45 分钟，不改变任何用例断言、超时或错误过滤。

## 独立审查与停止线

后端独立只读审查追踪引擎鉴权、真实 owner、完整响应预算、提交后段完整重核验、同次 Map 图片字节和坏来源读取边界，未报告本次可触发缺陷；它不替代动态门禁。

Impeccable 独立 finish review 对最终四视口及三 Vue / helper 给出 `ship`；documenter 确认普通扩展继承现有暖中性表面、clay accent、原生折叠和移动堆叠。有效 detector 仅一轮，唯一 side-tab 提示是 HEAD 已存在的 `.catalog-boundary`；未修改既有品牌系统。缺 PRODUCT / DESIGN 与旧系统漂移明确记录，没有补造设计稿或声称整仓设计质量通过。

本片未增加 Browser 批准、选用、固定来源 executor、操作归档或持久 BUG 账本。原 Mirror / Regression 和 Spec 确定性缺陷检出继续可用；本地受控测试不能证明任意站点、登录流程或状态业务的通用验收能力。
