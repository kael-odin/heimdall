# Browser 来源归属 HTTP 与工作台验收

日期：2026-10-17。基于来源归属提交 `3b7af9a`，本片把内部 Browser 来源绑定接入三个 HTTP 路由和项目目录工作台，并增加安全显示 DTO、按需来源核对及受保护证据展示。[操作与接口指南](../../competition/acceptance-browser-bindings-console.md)说明完整合同。

## 已实现行为

来源侧默认不选。操作方明确选择已完成的 Browser 运行、baseline / target 和项目版本后确认，POST 只发送双 CAS、runId、sourceSide、releaseId。完整 planned entry URL 和归属约束仍由原 store 校验，内部实体及摘要公式不变。

collection 和项目 detail 的 Browser 摘要只反映已存事实，不读取来源 JSON、PNG 或 projector。单条 GET 才重建所选来源；变化时历史 binding 保留，返回 preview:null 与固定诊断，不写目录，owner / root 失效保留 503。

显示 DTO 使用白名单，专用 URL 字段隐藏整段 query，显示预览不含步骤值、断言字面量和规则。页面结构文字不作为 HTML 或链接执行。三类证据从前端构造的受保护 run 路径按需读取，MIME / 大小 / SHA 验证通过后才创建展示内容；上下文变化与关闭均回收 Blob URL。

POST 只发送一次，未知结果不自动重放，刷新只核对已存历史。单条来源和证据读取带项目、binding、目录版本与选择轮次保护，A→B→A 后不能恢复迟到预览。Browser 完整批准预览、候选、批准、选用和托管执行仍未开放，`executionReady:false` 保持明确。

## 专项与真实浏览器

| 检查 | 实际结果 | 证据性质 |
| --- | --- | --- |
| 纯显示 DTO | 20/20，0 fail / 0 skip | URL 白名单、字段裁剪、历史诊断与实体摘要保持 |
| HTTP 集成及旧目录 API | 34/34，0 fail / 0 skip | 28 项新测试与 6 项旧 API，真实 owner/store、冻结来源和隔离引擎 |
| 前端 helper | 21/21，0 fail / 0 skip | 显式输入、显示 DTO、CAS / ABA、受保护路径与证据完整性 |
| 新工作台 CDP | 14/14，exit 0，35,537 ms | fresh mirror / regression、真实引擎 worker、原生界面操作 |

本次 CDP 默认命令一次通过，真实新采集两条运行。每条原比较均保持 failed，14 个检查槽位对应 4 条采集观察；核对健康侧没有把原比较改为通过。界面完成三次归属 POST，其中一次提交已落库但回包被测试网关替换为 HTML 502；“刷新并核对目录”确认它只存在一条记录，没有自动再 POST。

CDP 还验证同长度损坏 PNG 在摘要失败后没有创建 Blob 或图片；三种正确证据均按需打开；项目 A→B→A 后迟到 GET 不恢复预览；向原 report 追加一个空白字节后只读展示变化诊断，随后在 finally 恢复原字节。两条 run 的前后文件清单及 SHA 完全相同；归属 / 核对阶段目标站新增请求为 0，新增执行 run 为 0，Browser candidate / approval / selection 均为 0。

本机可用浏览器能力为仓库 Playwright + Chromium CDP，Browser plugin 不可用，证据中显式记录了该替代路径。8 张真实截图覆盖桌面表单、核对、证据、来源变化，以及 390px 深浅主题的表单和核对。页面非空、无错误覆盖层、pageErrors 为 []，所有记录视口无横向溢出。

HTTP 首两轮失败原样保留：初轮 26 total / 20 pass / 6 fail（含 2 个失败父节点），二轮 34 total / 32 pass / 2 fail（1 个失败叶子及其父节点）。修正的是测试对 queryPresent、owner 门禁所在入口和坏目录错误码的旧合同预期；没有改产品迁就测试，也没有增加 timeout。最终一轮 34/34 通过。

## 完整质量门与发布

最终串行质量门全部通过，12 份实现 / 测试 / 命令 / CI 源文件在门禁前后摘要一致：

| 门禁 | 最终结果 |
| --- | --- |
| Core lint | 449 个文件通过 |
| Console build | 成功，436 modules；仅既有 Graph3D 大 chunk 提示 |
| 完整 Core | **2273 total / 2264 pass / 0 fail / 9 skip**，553,978.1225 ms |
| Core 真实流水线 smoke | exit 0 |
| 项目目录兼容回归 | 17/17 检查、31 个 API 用例，14,765 ms |
| Spec 基线工作台回归 | 13/13，25,732 ms |
| 托管准备回归 | 25/25，2,150 ms；无引擎 / 浏览器 / 执行 |
| 执行工作台回归 | 16/16，90,620 ms |
| Console→Clone CDP | task done / clone HTTP 200 / pageErrors []，29,557 ms |

前端 helper 21/21 与第一次 build 的初始输出只有工具记录，没有伪造 wx 日志目录；最终完整 Core 和 build 的原始日志已落盘，覆盖相同冻结实现。完整 Core 只计本次完整运行一次，专项和 smoke 单独计数，不累加。

Impeccable 机械检测仅执行一次，新组件没有 finding；唯一警示是 Catalog 原有边线，未被本次 diff 修改。fresh finish reviewer 目视全部 8 张截图，结论 `ship`、material findings 为空；fresh documenter 核对既有 tokens / 组件及源码摘要，结论 `documentation-complete`，普通扩展保留既有设计系统。根 PRODUCT / DESIGN 缺失、sidecar 历史配套文档缺失及 Atlas brief 范围不匹配作为既有非阻断漂移披露，未顺手重写全局设计系统。界面审查没有额外独立键盘、辅助技术或数值对比度实测；目录兼容 smoke 自身的键盘 / 主题检查按其原范围记录。

[本机证据包](evidence/browser-bindings-console/README.md)共 116 份文件、4,704,502 bytes，含 13 组完整 tar.gz、240 份原件和 84 份索引 / 摘要 / 日志副本。独立核验再次解包全部归档，确认完整文件集合、SHA、原件逐字节和 gzip 无损回环；12 份冻结源码及 9 阶段退出结果一致。连同父提交 CI 包共 230 份证据的 Git 暂存 blob 与工作区原字节一致。四类强凭据模式扫描 382 项、命中 0；该有界扫描不等于能发现任意形式凭据。[发布检查](evidence/browser-bindings-console-publication/README.md)保存独立、暂存与文档链接结果。

来源归属父提交 `3b7af9a` 的[自身 CI](evidence/browser-bindings-ci-main-3b7af9a/README.md)已单独归档；本片不会用父提交的成功替代自己的远端 CI，推送后按本片精确 SHA 跟踪。

## 边界与下一步

这是一份来源组织核对预览，有意省略批准所需的完整内容。不能把显示 DTO 交回内部 schema、重算原实体摘要或作为 Browser 批准合同。原始采集详情经 SHA 核对后按保存字节作文本展示，可能包含页面文字、链接与断言观察；旧 release / run / plan / report / evidence 接口继续保留各自合同，本片不声明全系统脱敏。

来源归属不证明远端部署冻结、完整重定向链或最终完整 query。本次真实流程限定为受控本地站点；HTTP 反例使用已冻结来源，没有把它们算作新采集。完整 Core、专项和 smoke 数量分别报告，不叠加覆盖。后续继续建设 Browser 完整批准预览及候选 / 批准 / 选用 / 固定来源执行，并扩展持久 BUG 账本。
