# Heimdall 路线图

更新：2026-11-12。这里记录当前仍需完成或长期维护的工作。2026-10-13 前的逐项历史与已完成条目在 [归档路线图](archive/ROADMAP-through-2026-10-13.md)；本轮修复前证据、复验及剩余边界见 [审查报告](./audits/README.md)。

持续目标为站点重建与独立交付、SEO/GEO 诊断优化、基于充分业务信息的前后端缺陷检测，优先级和边界见 [当前主线](STATUS.md#现在的主线)。2026-11-12 已用三个公开站点、五页样本修正 [GEO 证据完整性及 Google 摘要指令](audits/2026-11-12/geo-evidence-integrity.md)，当前为 SEO 评分/采集 5、GEO 4；真实模型引用、爬虫访问策略与授权业务旅程继续保留为未完成工作。

本机旧产物已做[只读盘点](./audits/README.md)：历史 atlas 可比较的 641 个 URL 中 397 个有对应克隆，62 份原工作区多视口验证均为旧口径。按 2026-10-15 最新验证器指纹的[隔离批处理快照](./audits/README.md)，407 个带克隆页中 **2 页完整测量**（`angular.dev/ai` 90.55% B、`home` 94.80% B）、**3 页未测成**（`apify.com/ideas`、`jobs`、`apify-instagram-scraper` 渲染未收敛）、**402 页待测**；另有 1 页 `no_clone`，不计入分母。旧的[四页已测快照](./audits/README.md)只供追溯，不能沿用 Apify 旧分数。新批处理已支持超长页分段截图，但该页仍须解决采集完成条件。批处理只做三视口视觉验证，不包含交互；原件保持只读，运行状态在被 Git 忽略的 `core/workspace/_runs/historical-v2-batch/`。以下任务不得原地覆盖旧证据。

本轮[公开页面独立交付验收](audits/2026-10-15/public-site-acceptance.md)显示：`example.org` 首页 1/1 完成克隆、三视口验证与隔离离线部署；`hobix.com/learn/examples/A01/` 的受限三页样本完成九视口验证、`root=landing` 严格离线导出及搬迁后断外联导航验收，新版有界浏览器探针复验 3/3 通过；`vite.dev` 的 57 个已发现 URL 完成 57/57 克隆和 v2 三视口验证，平均 91.51%，但 `root=mirror` 严格导出仍被 1 个 YouTube 嵌入、54 处 CarbonAds 脚本引用和 23 个未镜像链接阻断。这些样本都不能证明任意站点已可完整复刻。

2026-10-16 的[第三方运行时与未镜像链接观测](./audits/README.md)已把 Vite 的 23 个未镜像链接拆成 12 个源文档链接与 8 个路径别名，并把 CarbonAds、YouTube 显式归类为 `unsupported-runtime`。严格导出仍失败并保留候选包；该报告只提升失败定位能力，不表示缺口已解决。

同日[公开文本与路径别名奇偶性](./audits/README.md)复验把公开文本预算提升为默认 128 / 上限 256，修正 `config.md` 误判私有路径的问题；Vite 44/44 个公开文本目标全部捕获，12 个 `.md` 缺口消失。7 个源站 404 别名共 10 次引用被改写到镜像命名空间并按可复现 404 处理。随后代码已把跨域别名跳转升级为独立的 `unsupported-external-redirect` 策略（见[策略记录](./audits/README.md)），可在 strict 下显式接受并保留证据。CarbonAds 已支持默认阻断、显式 `--remove-carbonads` 降级（见[策略记录](./audits/README.md)）；YouTube 已支持默认阻断、显式 `--replace-youtube` 本地占位（见[策略记录](./audits/README.md)）。三者叠加后 Vite 57 页的静态资源缺口清零，但浏览器探针发现 Iconify、sponsors、运行时 CarbonAds、YouTube 外联和 3 个 `.riv` 资源仍导致 57/57 失败，包未发布。

浏览器探针证据已并入 `health.thirdPartyServices`（见[归类记录](./audits/README.md)）：静态扫描清零后，`externalRequest` 会按服务归类并继续进入 strict 阻断，未识别 origin 保守标记为 `external-runtime`。这解决的是失败可解释性，不表示运行时缺口已处理。

同日新增[运行时服务显式缓存策略](./audits/README.md)：只按策略文件声明缓存安全 GET 响应，补齐 Iconify 镜像域名、JS 基址改写、带查询 `_ext` 哈希实体路由、CarbonAds/YouTube 运行时脚本改写和 `.riv` 静态化。Vite 公开样本 57/57 页完成严格导出，浏览器探针 0 失败、0 未测、0 个运行时外部 origin；复制到不含原工作区的目录后搬迁复验仍为 57/57、0 失败。该结果只覆盖本样本与已声明策略，不表示任意站点已可完整复刻。

同日完成 [vitest.dev 221 页公开样本全站 strict 离线验收](./audits/README.md)：221/221 页克隆并交付，213 个公开文本文档全部捕获，Iconify 21 个安全 GET 全部缓存，隐私扫描 clean，strict blockers 全量为 0；正式包复制到不含原工作区的独立目录后，根路径与 `/lm/vitest.dev/` 均 200，221 页断外联浏览器复验 0 失败、0 未测、0 个运行时外部 origin。视觉验证为 219 页完整测量、平均 94.10%，2 页因源站渲染未收敛未测成。该样本未覆盖登录、写操作和实时业务，仍不能证明任意站点完整复刻。

同日[公开页面离线验收](./audits/README.md)确认 `example.com` 单页可完成 strict 导出、独立 Node 服务与浏览器访问；`vitest.dev` 单页在 heal / materialize 后同源与跨源静态资源缺口清零，剩余 16 个阻断均为未克隆站内链接。验收还修复了 `dns-prefetch` 被子串匹配误判为 `prefetch` 的 strict 假缺口。两个样本均为 `captured-only`，不能证明整站覆盖。

2026-11-12 修正 strict 导出的诊断顺序后，已在 [IANA 副本](audits/2026-11-12/iana-public-pilot.md)执行 8/8 页浏览器探针；补抓 jQuery 后 7 页通过，0 页未测，动态搜索、未捕获链接和跨域跳转仍阻断严格交付。导出结果现经 `live-export.json` 进入站点评估与 AI 修复待办；下一步仍需解决运行时行为和明确交付范围，不降低发布门禁。

2026-11-13 已在另一 IANA 副本补写 8 页本地全文搜索，当前离线浏览器 8/8、声明旅程 7/7 通过。导出在存在未捕获链接时继续执行已知旅程诊断，全部链接缺口仍阻断发布。下一步继续核对交互镜像视觉差异、扩大实际捕获与业务范围；本地搜索范围不代表 Google 排名或全站搜索等价。

## AI 原生接入（已进入交付加固）

2026-10-25 起草的 [AI 接入层 PRD](prd/ai-native/README.md)：一个能力注册表生成 CLI / MCP / HTTP / 技能四个外壳，让外部代理调用 Heimdall；以「AI 提议、确定性门禁裁决、失败回落镜像」的闭环做前端重建，行为与后端只做被观察到的部分。Phase 0 的四个 spike 已于 10-25 完成并回写假设表（[结论](prd/ai-native/10-roadmap-risks.md)）：修复包原型过线，分段重建 6 次运行全部过 silver，但每段成本比估算高 3–6 倍；正式裁判须绕开验收的截图预算与健康前提。客户端界面手测完成后冻结为 v1.0，再按其路线图开工；spike 代码在 `core/spikes/ph0/`，不进主干。

2026-11-05 已补齐第一版统一安装体验：`heimdall setup` 和 `clone-heimdall.cmd`
按需安装依赖与 Chromium、构建控制台/MCP、启动 `:8900` 单端口并配置 AI 客户端；
`doctor --fix` 复用同一安全实现。下一步不是继续加工具，而是在干净 Windows / Linux
上做安装回归、发布不可变版本，并把 QA CI 接到真实授权项目。

## 比赛方向：项目还原度与 BUG 自动验收

2026-10-16 已实现[项目验收工作台](competition/acceptance-workbench.md)：独立 baseline / target 输入、Mirror / Regression 模式、375 / 768 / 1440 三视口、页面结构与运行健康检查、click / fill / press 与可见性 / 文本 / 属性 / URL 断言；双方重复截图识别不稳定差异，遮罩覆盖过大与全页预算超限进入复核。输出明确的问题归因、复现步骤、截图 / 差异图 / DOM / 网络摘要、计划与验证器指纹、证据 SHA-256。AI 解读仅按需发送脱敏摘要，不能修改门禁。固定夹具的检出率、误报与门禁及控制台闭环接入 CI，实际结果见[实施验收记录](./audits/README.md)。

2026-10-28 在工作台上补了两层证据：失败检查的**元素定位**（样式规则、脚本行、标记位置与基线对照，结果存旁路 `localization.json`，不改报告与核验指纹）和**从基线自动生成候选验收点**（单步交互前后可观察变化的断言，按执行器语义在计划视口重放）。固定基准的第二个臂只使用自动生成的点，13 个已知 BUG 全部检出、0 误报、18/18 案例校验通过；定位 13/13 落到注入源码行。本机验证与证据见[实施记录](audits/2026-10-28/acceptance-exploration.md)。

2026-11-01 给 QA 工作区补了**无参照物检测**（23 个页面内检测器：无障碍、布局、内容、安全、性能、白屏）、**有界交互探索**（默认关闭，找点击无反应/点出异常/点出 404）和**跨运行视觉回归**（`qa baseline` 登记基线后逐页比对截图）。固定注入基准 21 缺陷 + 3 健康案例，最近一次 21/21 检出、0 误报，口径与边界见[基准说明](competition/qa-detection-benchmark.md)。2026-11-05 已完成 [Xspark 真实试点](audits/2026-11-05/xspark-pilot.md)：20 次运行、184 次页面与视口检查，部分查询放行后的候选提单误报占比为首轮 50%、复跑 52%。2026-11-10 已把失败分类、测量完整性和检测器扩展判断机器化；补充复测存在不完整证据，当前先补证据、修现有规则和增加业务检查点，通用检测器扩展暂时阻断。固定夹具的零误报不能外推到真实项目。

2026-11-12 将 Xspark 的统计判断收进通用 `heimdall_qa_metrics`：CLI、MCP、HTTP 共用同一统计内核，可读取脱敏聚合或 QA `run.json` 摘要；下一步仍是用更多获授权项目补齐正常样本和业务 oracle，不能把 Xspark 一批数据外推成通用准确率。

2026-11-12 新增 `heimdall_public_case_summary`：AI 可以读取已提交的 Xspark 公开案例摘要，先看证据覆盖和未覆盖范围，再决定是否进入新的真实试点。它不读取原始发现、HAR 或登录态；下一步仍是把更多授权项目沉淀成同样的公开/脱敏案例，而不是继续堆通用检测器。

2026-11-11 的本机夹具发现并修复入口跳转导致的验收假通过：首次操作前跳转或重载会阻断，旧报告保留且不会自动变可信。新验证器仅完成本机测试，独立审查未完成；正式门禁的多视口入口仍有兼容限制，见[工作台指南](competition/acceptance-workbench.md)和[本机记录](audits/2026-11-11/verify-resume.md)。本次没有重新访问 Xspark，也不改变试点统计。
[D5 自身 CI 超时记录与调度修复](./audits/README.md)单独保留 D5 精确提交的 cancelled 终态：全量 Core 与前 19 项 smoke 成功，第 20 项取消，Docker 未运行。双核默认文件并发由 1 调到 2，45 分钟时限与完整门禁保留；该提交自身 Linux CI 结果见下方来源会话诊断记录。

调度提交 `209cf40` 自身 CI 已确认为[来源会话断言 failure](./audits/README.md)，Core 唯一失败，后续 20 项 smoke 与 Docker 均 skipped。本片仅补全原断言的脱敏失败报告；受控负载复现不能代替旧 CI 根因，也未放宽 timeout 或宣称修复。后续精确提交仍须完整 Linux 门禁，间歇失败风险继续跟踪。

当前进展与后续重点：

1. Spec 已增加[批准清单与 OpenAPI JSON 只读契约](competition/acceptance-spec.md)，区分来源事实、未批准候选、批准清单与遗漏项，覆盖 HTTP 200 业务错误码。[实施记录与证据](./audits/README.md)包含 11 案例基准、17 项真实控制台检查与完整来源快照。下一步扩大获授权的真实接口样本、参数 / 多响应 / schema 支持及认证，保持未实现约束明确受阻。
2. 用获授权的真实开发项目验证 Mirror 的视觉阈值、字体 / 延迟数据 / 布局稳定窗口；固定注入夹具不能证明真实项目泛化。
3. 已增加[显式运行对复验](competition/acceptance-comparison.md)：稳定身份区分定义、依据、实际视口与环境；重新核对当前报告及证据，输出仍失败、可靠复验通过、新增失败、未复验和不可比。[实施记录](./audits/README.md)包含固定假修复反例和真实控制台验证。现已交付[本地项目、不可变版本与历史运行归属](competition/acceptance-catalog.md)，通过单写者所有权、目录双 CAS、严格持久化与[真实双引擎/重启/控制台验收](./audits/README.md)。[目录格式单次升级](./audits/README.md)独立验证旧格式、保存原始前像、切换 generation 并校验备份谱系。现已接入 [Spec 需求候选完整预览、显式批准和独立选用历史](competition/acceptance-baseline.md)，来源在写入前与正式提交前重验；[实施验收](./audits/README.md)覆盖完整草稿、失败目标、冲突、来源变化与取消。托管 Spec 已增加准备、固定身份存储与[核验读取](./audits/README.md)，目标版本来源独立保存；[专用 HTTP 真实执行](./audits/README.md)现支持完整新确认接纳、共享槽和取消。已接入[owner 启动恢复](./audits/README.md)，整批预检后只收束 running、不重发请求；已增加[明确目标版本的执行 UI](./audits/README.md)、持久凭据恢复与请求停止。Browser 已从来源归属、完整候选推进到[D3 单次批准固定来源执行](competition/acceptance-browser-execution.md)，并保存显式检查问题与前后操作复验记录；[D5 人工缺陷单](competition/acceptance-defect-tickets.md)已接入固定成员成单与显式关闭，其余消费者继续独立迁移。原 Regression 仍由用户提供上一版本 URL，不自动批准新基线。
4. 业务适配器：认证、独立测试账号、写操作精确许可、只读 DB 对账和状态机，先用脱敏 Xspark 夹具，后接授权测试环境；Xspark 试点已证明这条优先级高于继续增加通用检测器。
   - 2026-11-12 落地 CLI-only 的 B3 最小脚手架：heimdall backend scaffold <siteId> 读取脱敏契约，生成可启动的 Node 服务、健康端点、检查脚本、Dockerfile、状态规则草稿，并在已有 B2 适配器时复制两个受约束文件。它不新增 MCP 工具、不发明业务规则；没有契约的站点仍明确为 blocked 起点，生成服务也不会伪装成源站后端。
   - 2026-11-12 补上脚手架的确定性复测闭环：npm run check 现在核对观察路由覆盖、状态码、MIME、有限响应结构和运行时缺口，并把结果写入 `backend-check.json`；失败项会生成脱敏 `repairTasks`，站点评估把它们交回 AI。它仍只是观察回放与实现起点，不是源站业务等价证明。
   - 2026-11-12 用[公开 API 真实响应](audits/2026-11-12/backend-public-api.md)跑通健康、本地缺陷注入、恢复复验及原工作区缺席时的独立 Node 部署，修复字段身份、数值校验与可空混合类型丢失。后续商品与博物馆两个响应独立包通过，合法可空变体通过、三类错误类型检出。接下来仍需多个独立业务样本、状态机与写入旅程；不把一次响应回放算作留出验证。
   - 后续两站 10 次独立分页 GET 的留出实测各为 4 次训练、1 次留出：训练回放均通过，未观察查询均为本地 404，留出验证明确失败。已复用 `read-data-plan.json` 和 `--include-readonly-data` 将逐条批准的公开查询贯通契约与适配器 CLI，并用同一原件复测；默认清洗、来源与认证边界保留。下一步仍需补写逐站查询行为与独立部署验收，生成成功不等于留出通过。
   - 商品公开读取已补写一个站点专用实现：同样三次训练、六次留出，观察回放 0/6、补写实现 6/6，Windows 与无外联 Linux 独立包通过。结构检查漏掉本地分页错位，现已用显式 GET 查询断言贯通 9 次实际 QA CLI 调用：健康/修复通过，后端不符以未完成阻断，前端不符按实际损失触发门禁。下一步将独立预期接入更完整的交付旅程，并补充其他真实业务。快照读取不证明认证、写入、持久化或全后端等价。
   - 2026-11-11 已先落地最小 B1 契约闭环：`core/src/live/contract.mjs` 统一生成观察型 `api-contract.json`，交付包的 `health.json` 提供端点、响应 schema、错误样本和未知项摘要，`heimdall probe contract` 复用同一推断逻辑。当前仍没有夹具拆分、状态规则和业务行为实现，不能当作后端替代。
   - 2026-11-11 追加 B1→B2 桥接：`heimdall probe adapter --site S --include-api-bodies` 现在按端点确定性拆分训练集 / 留出集，只用训练集生成两个文件的观察回放适配器，并在适配器目录旁写出 `adapter-report.json`。报告比较留出请求的状态码、MIME、JSON 形状、稳定字段，并列出未观察路径和未覆盖参数；样本不足明确为 `not-validated`。这仍不实现认证、状态机、权限或真实副作用，不能当作后端等价。
   - 2026-11-11 继续补厚 B1：契约现在保留请求体 Schema、观察到的鉴权形态摘要和对应未知项，但仍不保存请求值、认证值或刷新规则；这些信息只用于 AI 生成适配器草稿，不能替代 B2 行为验证。
   - 2026-11-11 新增 `heimdall_site_assessment`：把已有克隆、多视口验证、SEO/GEO、公开 API 契约、适配器留出验证和可选 QA 最近运行压成一个只读评估包。它只读清洗摘要，不读取原始 HAR、登录档、操作计划或适配器源码；`verified`、`observed`、`inferred`、`unknown` 分开输出，作为 AI 的导航层而不是新的业务后台。
   - 2026-11-12 在同一只读入口加入 `deliveryPlan`：把缺口、未知项、建议动作和确定性复测条件统一成结构化阶段决策，先解决“已有很多零散检测器但 AI 不知道下一步做什么”的问题；暂不新增独立 MCP 工具。
   - 2026-11-12 追加 `deliveryPlan.backendCompletion`：将观察型端点/响应形状、人工业务旅程、测试数据、建议本地文件和验证命令整理成 B1→B2 任务包；只读摘要仍不证明认证、权限、状态机、持久化或真实副作用。
   - 2026-11-12 追加适配器缺口账本：观察回放模块携带脱敏路由元数据，运行时把未声明路径、未覆盖查询参数和查询变体按次数写入包外状态卷，并通过 `/__heimdall/adapter-gaps` 暴露给 AI；`site-assessment` 会把离线账本变成待办。下一步仍是逐站补认证、状态机、写入和真实副作用验证，不能把账本清空当成后端等价。
5. Figma 元数据、设计容差与 PRD 来源追踪；录制交互和生成候选断言，人工批准后执行。
6. D4 已增加[未知启动的完整决定核对与永久拒绝](competition/acceptance-browser-start-resolution.md)：原六字段回执、完整 accepted / rejected 证明、迟到启动阻断与跨页 Web Locks；原确认只在证明核验后精确解除。D5 已在 D3 检查级账本之上接入[固定成员人工缺陷单](competition/acceptance-defect-tickets.md)：从同次登记的可靠失败成单，最新同范围登记可靠通过全部成员后显式关闭，后续可靠失败派生重开。[本机验收记录](./audits/README.md)保存该片完整门禁与公开证据。未知人工动作保留原确认，只 GET 核对、不自动重发原 POST。D6 已实现[人工动作完整决定核对与永久拒绝](competition/acceptance-defect-ticket-decisions.md)，同动作成单 / 关闭事件与拒绝争用一个不可变决定；页面独立核对完整原件与请求身份后精确解除对应确认，拒绝不改变单据处理历史。D6 已通过本机完整 Core 和 27 阶段 Browser，[原提交 CI 已核验为 failure](./audits/README.md)：完整 Core 与前端构建成功，独立四案的浏览器正文取证失败。[动作回复边界增强](./audits/README.md)已通过本机 Windows / Linux 专项，新提交自身的完整 CI 仍待核验。全局 Browser approval / selection、操作归档与其余消费者仍独立建设。
7. [x] D7 本地固定示例完整流程：2026-11-03 已在最终控制台构建上从全新会话的真实 UI 走通采集、明确来源归属、完整候选合同保存、发现视觉 / 行为 BUG、两项固定成员人工成单、1/2 禁关、2/2 复验通过后明确关闭，以及 Markdown 下载；结果 `accepted:true`，普通控制台错误为 0。使用真实浏览器，所有确认由操作者明确执行；正常流程不注入故障，未知结果恢复另由 D4 / D6 专项验证。结论仅覆盖本地固定示例的声明检查，不称外部泛化或 AI 推理。取得获授权的外部项目 URL 和明确版本后，再拓展真实项目验收，保留失败和未测范围。

B2.2-a 已补充[托管 Spec 准备内核](competition/acceptance-managed-spec.md)：当前选用与明确目标版本在同一目录队列中核验，重建规范合同并保存不可变派发准备；同键只查询原记录，准备不改目录修订、不创建 run / task、不发请求。B2.2-b 的[runner 控制基础](./audits/README.md)增加可取消 fetch / body / 事件等待与同步 active 检查，操作核对物理只读并固定已见祖先身份。[来源关联与隔离](./audits/README.md)增加纯 provenance / linkage 校验和普通入口防降级，坏派发记录阻塞恢复写入但保留目录读取。[固定身份存储](./audits/README.md)增加 owner 约束的 create / progress / finish / settle、证据交叉核对及明确的终态提交点。[托管读取切片](./audits/README.md)已完成 head / list、完成快照、核验下载、比较及 HTTP / 控制台安全投影；已接入[owner 启动恢复](./audits/README.md)，完成有界清单、整批预检、固定字节收束、诊断 readiness 与失败写入阻断；已接[owner 内真实执行](./audits/README.md)、普通/托管共享槽、取消 / watchdog / shutdown 和任务投影，浏览器可观察 HTTP 启动的运行与下载核验原件。明确目标版本的[执行按钮与原操作恢复](./audits/README.md)已接入。Browser 的完整来源复核、候选写入与重启读取已接入，并新增[D3 单次批准执行与检查级复验](competition/acceptance-browser-execution.md)和[D5 固定成员人工闭环](competition/acceptance-defect-tickets.md)；全局 Browser 批准与选用仍待建设，操作归档管理与 candidate / triage 独立迁移。候选、归属及 Spec 批准响应仍为 `executionReady:false`，D3 执行权限来自本次新的完整确认。

Browser 所选侧来源已交付[纯字节核验内核](competition/acceptance-browser-source.md)：独立重建六基础槽及 point 槽、核验原件和所有实际引用证据、重算稳定性并从所选侧生成新 oracle；四组真实 Browser 样本与离线反例见[实施记录](./audits/README.md)。[owner/fence 私有读取器](competition/acceptance-browser-reading.md)原生读取 nullable 角色和全引用，保留 managed 隔离；[读取验收](./audits/README.md)记录新采集闭环与对抗检查。[Schema3 分步迁移](competition/acceptance-catalog-schema3.md)建立独立来源表与兼容格式，保留完整 Spec 历史；[来源侧归属与重核验](competition/acceptance-browser-bindings.md)显式选择 baseline / target 并归属 project / release，全库同 run 与 side 唯一，target 与旧运行归属双向相容，完整 planned URL 严格匹配版本，head 提交前重建完整 projection，单条诊断读取保留历史，新采集 mirror / regression 与事务反例见[绑定验收](./audits/README.md)。现已增加[HTTP 与工作台](competition/acceptance-browser-bindings-console.md)：已存列表不读来源，单条按需重核验，专用 URL 字段隐藏整段 query，三类证据经受保护接口与 MIME / 大小 / SHA 校验后展示，迟到读取与未知 POST 通过共享目录状态恢复，详见[工作台验收](./audits/README.md)。显示预览仍为 `completeSourceProjection:false`；[D2 完整复核与持久候选](competition/acceptance-browser-candidates.md)已接入完整明文复核、明确确认、只读对账与重启读取，候选响应继续为 `executionReady:false`。D3 已实现[固定来源单次批准执行](competition/acceptance-browser-execution.md)：固定所选侧原件，只采集本次目标，显式登记检查问题，并保留可靠复验通过、再次发现及未能核验的历史。D5 的[人工缺陷单](competition/acceptance-defect-tickets.md)固定成员和来源摘要，分开显示处理状态与当前核验，支持显式关闭、失败重开及 Markdown / JSON 导出；结论只覆盖声明的固定检查。全局 Browser approval / selection 与操作归档继续独立推进。

D1 已实现 [Schema4 与显式维护](competition/acceptance-catalog-schema4.md)：独立 `browserCandidates` 纯格式、组织与来源摘要、显式迁移及旧历史兼容。已有 Schema3 / Schema4 普通启动只打开并验证；旧 Schema1 / Schema2 返回 `MIGRATION_REQUIRED`，须停止同根引擎后显式预览并确认升级到 Schema4，中断后也需重新预览；新空目录由引擎明确创建 Schema3。D1 阶段本机回归、旧数据真实迁移、Browser 混合历史与自身 CI 状态见[实施验收](./audits/README.md)。[D2 实施验收](./audits/README.md)记录完整来源复核、显式保存候选和重启后来源重核验的真实闭环；[D1 自身 CI 复核](./audits/README.md)保留已通过步骤与旧 preparation 夹具失败，D2 已完成显式维护适配。[D3 实施记录](./audits/README.md)单独记录固定来源执行、检查级持久问题账本与显式复验；各阶段测试与精确提交 CI 状态以对应实施记录为准。

运行轮询已补充[原子发布期间的稳定展示读取](./audits/README.md)，修复普通 worker 更新进度时的误拒绝。展示版本不能授权来源快照、证据下载或写操作；原工作台精确提交的 CI 失败与修复验证分别归档。

## 主目标：独立站点镜像

目标是持续提高可克隆站点的覆盖率，并使导出包在声明的范围内真正脱离原站运行。每个包按 [产品定义](../PRD.md) 标注可查看快照、可离线浏览、可离线交互或完整业务替代等级；覆盖率、失败原因和未测范围与等级一起交付。实现顺序：

1. **真实离线门禁**：在候选包中启动独立服务，用浏览器加载每个声明的页面并阻断所有外联；动态请求、脚本报错、本地 HTTP 失败和未测页都进入 `health.json`，未通过不得发布为离线可用。
2. **页面状态与依赖图**：从 URL 图扩展到 URL、视口、会话与操作后的状态；记录每个状态实际使用的脚本、样式、媒体、API 和跨域资源，支持有界的点击/输入/滚动探索，并明确未探索的分支。
3. **本地运行时**：区分可直接本地化的资源、可安全回放的只读数据、需要业务适配器的有状态请求及不支持的实时连接。独立交付模式禁止静默回源。
4. **兼容性矩阵**：用获授权的 SSR、SPA、长页、query/分页、认证、iframe/Shadow DOM、Canvas/WebGL 和实时请求站点逐类验收。每类包含缺页、缺资源和接口失败反例；所有分数对应同一版验证器与完整覆盖率。
5. **部署验收**：在不含原工作区的干净环境运行 Node/Docker 包，阻断原站网络，完成关键路径、数据分发检查和回滚演练，再扩大站点样本。

当前 `--strict` 已在静态和 HTTP 检查后加入 Chromium 逐页断外联加载探测；外联请求、WebSocket、本地 4xx/5xx、脚本异常及未测页会阻断候选包发布，旧正式包保留。逐页探测默认覆盖全部包内路由，至少观察 3000 毫秒，再等待 500 毫秒网络安静，默认最长 8000 毫秒；到上限仍未安静则失败。普通包最多并行探测 4 页，适配器包顺序执行；`health.browserProbe.observation` 记录逐页观察结果，`health.coverage` 另对齐侦察 URL、克隆页与 live 路由。工作区有显式 `operation-plan.json` 时，还会在候选包内断网重放声明的动作与最终断言。未声明操作、延迟超过观察窗口的请求、登录和有状态业务仍未得到通用保证。

侦察已从导航后固定等待 400 毫秒、读取一次链接，改为观察渲染链接最少 1200 毫秒、静默 350 毫秒、最多 3000 毫秒；晚出现的同源 query 链接会进入 BFS。HTTP 错误、非 HTML 和跨源落地不建页面节点；同源重定向使用最终 URL。客户端 `history` 改址先标为 `directNavigation=unverified-client-route`，只有该 URL 实际直访取得 HTML 才清除。`atlas.meta.renderedLinks` 记录观察预算和触顶页数。安静页可能在 1200 毫秒结束，之后出现的链接仍会漏；已发现的客户端路由也不等于独立直访可用。Vite 在同一 57 URL、深度 1 预算下重跑新版侦察，结果与旧 atlas 完全一致，57 页均完成观察且无客户端路由未验证；这只能说明本预算下未发现新增链接，不能证明整站全集。

严格导出已支持 CLI 和控制台的 `--all-discovered` 入队、对声明流程的源站只读对照、精确许可的 GET 回放、候选包凭据特征扫描，以及受控 SSR/SPA 包在移走源工作区后的 Node 断网浏览。侦察新增 robots 声明、递归及压缩 sitemap，并在 atlas 里记录页面数、深度与 sitemap 扫描预算；`health.coverage` 用同一已发现 URL 分母列出按当前默认配方估算的排除、实际入队、克隆、v2 验证和交付数量。预算触顶与扫描失败仍标为范围受限。`--compare-source` 逐流程核对请求的精确路径及查询、次数、状态与 MIME；许可 GET 另核对清洗后正文指纹。`--include-adapter` 为逐站有状态业务提供显式接管入口，只有已声明、已在离线操作计划中触达的路由才允许严格交付。本机严格探针不隔离适配器 Node 进程外联，`health.adapter.serverEgress=not-tested`；实际适配器必须另做无外联部署验收。Linux CI 已通过受控 SSR、SPA、数据驱动 SPA 和适配器卷持久化的 Docker 无外联网络验收（主分支提交 `75dceeb`）；本机已于 2026-11-13 用现有 Node 22 镜像完成 IANA 局部搜索包的无外联运行，尚未构建该生成包的 Dockerfile。上述夹具与门禁仍不构成任意站点完整复刻。下一批按依赖顺序推进：

1. 将现有按声明流程的请求依赖对照扩展到 iframe、Shadow DOM、延迟请求和多会话状态。2026-10-16 已覆盖 iframe/subframe 归属、Shadow DOM 请求捕获、最后一个状态后的延迟请求阻断、按 flow 声明的命名登录态，以及同一 flow 内的 `useSession` 上下文切换（见[操作依赖审计](./audits/README.md)、[会话切换审计](./audits/README.md)与[适配器会话引导审计](./audits/README.md)）。源站可切换匿名 / 命名登录态；离线包支持匿名切换，并可通过本地适配器的 `sessions` 清单显式引导命名会话。缺失路由、失败响应或无 `Set-Cookie` 都以 `sessionUnsupported` fail-closed；本地引导不参与源站/离线依赖等价。独立登录、会话延续与写入业务仍需逐站适配器。视觉相似、请求匹配和只读响应相同都不等于业务结果一致。
2. 为登录、账户状态、写入型 API 和实时连接逐站实现适配器及契约验收；现有适配器只是接入协议，没有通用业务实现。`--include-api-har` 不能替代有状态业务实现。
3. 用授权真实站点复核 `health.coverage` 的同分母口径，处理 sitemap 不可用、JS 生成页面、隐藏入口及近乎无限的 URL 空间；已发现范围不等于整站全集。
4. 扩展分发审查到个人数据、业务机密及二进制资源，并按授权站点人工审核；当前扫描只识别一组凭据特征，大包扫描超限会标为不完整。
5. 数据驱动 SPA 已和 SSR、普通 SPA 一起通过 Linux CI 的 Node/Docker 断网验收；继续加入适配器的包外状态卷、写入及重启持久化验收，再用获授权真实站点跑全链路断网部署，扩展到认证、长页、查询页、iframe 和动态业务样本。这仍是受控样本，并非站点架构的完整覆盖。

第一阶段的退出条件：三个不同架构的受控站点可在干净环境独立部署；阻断原站后，声明范围内的所有页面和操作均通过真实浏览器验收；其余能力明确标为未支持，而不是以在线代理成功冒充离线克隆。

## 可信交付

- [ ] 续跑 `core/scripts/verify-historical-batch.mjs` 的隔离多视口验证：先为 Apify 三个未测页定义有界、可复现的动态请求/布局完成条件，再测其余 402 页；`pages.csv`、`viewports.csv` 已记录状态、尺寸、覆盖率、缺口和失败原因，完成后复核全量对照表。
  - 2026-10-25 口径警告：自 `7100132`（2026-10-15 00:54）起，克隆入口 HTML 带 `sandbox`（无 `allow-same-origin`）下发，页面成为不透明源，`@font-face` 字体文件与 CSS `mask-image` 因此按 CORS 模式请求；服务不回 `Access-Control-Allow-Origin`，克隆侧的本地 Web 字体全部加载失败、退回系统字体，遮罩图形也画不出来。`verify` 先经引擎 `/static`、自 `96ade77` 起经 `core/src/clone-preview-server.mjs` 渲染克隆，`shot_clone`（`file://` 入参）与 `fixup` 也走后者，所以**这段时间里对带本地字体的克隆测出的 v2 分数与单页 `score.json`，与修复后的分数不可直接比较**，旧分数只说明"字体缺失时有多像"。2026-10-25 已修预览服务；2026-11-03 又为引擎 `/static` 的克隆字体 / 图片 / CSS 加上仅限克隆目录与渲染 MIME 的 `Access-Control-Allow-Origin: *`，HTML、脚本、JSON 与截图仍不开放，真实 Chromium 已验证字体、CSS mask 和不透明源数据边界。本机 8 个带本地字体的克隆按 1440 宽整页、用 verify 的同一计分函数对比采集时的原站截图，预览服务修复后分数上升 1.5～10.5 个百分点（thordata 94.63→97.80、stripe 86.64→97.12、linear 96.60→100.00、vercel 97.87→99.98、tailwindcss 93.92→99.54、supabase 98.20→99.66、apify 98.15→99.64、framer 89.84→97.25），克隆页高与原站一致的从 1 页变为 7 页。`scoreVersion` 仍是 2：本机现存 42 份 v2 `verify.json`（含审计证据副本）的 `generatedAt` 都早于 `7100132` 的提交时间（最晚 2026-10-15 00:22），当前有效的 angular.dev `ai` 90.55%、`home` 94.80% 两页的克隆既无 `@font-face` 也无本地遮罩图，不受影响；受影响期内写出的 `score.json` 只来自 127.0.0.1 本地夹具，重跑即可。升版本只会把这些不受影响的结果一并打成旧口径。为让修复前后的测量不被当成同一验证器，`clone-preview-server.mjs` 已计入批处理的 `verifierSha256`，旧 verifier 的 measured 记录会被标记重测；当时普通 `verify --resume` 不看指纹，需要人工识别受影响结果；这一旧限制已于 2026-11-11 修复，不要删除历史 `verify.json`。
  - 2026-11-11 进展：[普通续跑与独立导出覆盖已校验验证器、克隆输入和截图证据](audits/2026-11-11/verify-resume.md)，续跑不匹配时先留档再重测。已修复新交付包中静态克隆字体与遮罩无法加载的问题；旧包须重新导出。导出净化改变文件时，覆盖计数保守标为未验证；仍需支持直接验证最终交付包。续跑和覆盖计数都不证明在线源站或系统字体未变；历史批处理的旧指纹结果也须复测。
  - [ ] 控制台 `/api/pages` 和 AI 工具的验证数据仍可能沿用旧内容；统一校验指纹与无效化记录，并在真实大站测量扫描成本，避免用缓存掩盖文件变化。
  - 2026-10-24 进展：`verify` 已支持 `--resume`（断点续跑，复用已测且未变过的页）、`--allow-bounded`（版面已定、只剩长轮询/埋点的页按有界置信度计入，摘要单列 `bounded` 并给卡点直方图）与 `--jobs N`（默认 1）。批处理脚本本身仍是逐页独立子进程，尚未接入新的有界置信度口径；那三个未测页先用 `verify <host> <page> --allow-bounded` 单个复核，再决定是否需要脚本级改造。
- [x] 新单页 `score.json` 在无可抽取字段时返回数据未测并归一剩余权重，多帧首帧完全一致时不再被差帧覆盖；`scoreFormulaVersion: 2` 区分新旧口径，旧产物只读保留。历史单页分数仍待批量重算。
- [ ] 用一套有授权的真实站点完成“侦察 → 全页克隆 → 全站验证 → 离线 strict → 独立包断网浏览 → 接手”回归，记录每一步的目标数和通过数。
  - 已提供入口：`node core/src/cli.mjs handoff <url>` 串完侦察→克隆（增量）→验证（断点续跑）→资产→交付，并写一份说清覆盖范围与卡点的 `handoff/README.md`；本机已用本地夹具站点跑通全链路（2/2 页完整测到、交付包生成），**真实授权站点尚未跑过**。
- [ ] 用专门的认证测试站覆盖登录、Cookie 轮换、POST/API、重定向、登出及 HAR 清洗；明确哪些交互能离线回放，哪些必须回源。
- [ ] 对带 query、长路径和分隔符碰撞的现存站点做覆盖率复核；旧目录保持可读，并给出必要时的显式迁移工具。
- [x] 为同一 hostname 的多个 origin（协议或端口不同）提供稳定 sibling ID：旧目录保持，身份贯通侦察、克隆、API、静态 atlas、控制台选择、交互镜像、一次性票据与独立导出；受控双端口 fixture、最终整套门禁与[独立 CDP 真克隆](./audits/README.md)已通过，真实部署仍待复验。
- [x] 静态 strict 扫描 HTML `<style>` 块和 `style` 属性中的 `url()`、`@import`，缺失的内联 CSS 资源计入 `unresolved` 并阻断导出；运行时动态请求仍在断网浏览器验收范围。

## 产品与规模

- 验收摘要已在控制台报告页提供：发现、计划、实际、v2 完整验证、未测、资源缺口、失败与证据状态；[受控浏览器证据](./audits/README.md)覆盖桌面/390px、刷新、JSON 打开与 Markdown 下载。旧产物的缺失或过期证据明确标注，不算通过。
- [ ] 在真实大站上测量侦察截断、并发、超时和内存，用数据决定分页队列、增量 CSR 指纹与更大规模抓取是否值得投入。
- [ ] 若开始长期维护控制台，将站点上下文和任务订阅从 `Atlas.vue` 抽为可独立测试的逻辑单元，先覆盖跨站、并发和刷新恢复，再移动模板。
- [ ] 若 `/api/pages` 扫描在大站成为瓶颈，先设计异步索引和外部文件变更通知；整份响应的 8 秒缓存会违反当前 score/verify 下一请求即时可见的约定，`assets` 字段则已有最多 8 秒索引陈旧窗口。
- [ ] 对 shadow DOM、第三方嵌入、无限滚动和运行时 WebGL 等复杂页面制定“支持 / 降级 / 不支持”的可观察分类；异步请求晚于 v2 有界稳定窗口才开始的页面需显式等待条件。
- [ ] 验证 Token 下受限静态产物的中键/右键打开路径、HTTPS 反代、非 localhost HTTP、不同控制台/API origin 的镜像入口；同主机、跨端口、跨主机的左键/键盘/Chromium 原生新标签已通过。
- [ ] 在真实断网浏览器中验收静态包的关键资源与导航，以及交互包的页面脚本、动态 import、fetch 和表单；区分静态 strict 探针通过与完整交互可用。
- [ ] 盘点既有 `core/deliverable/` 包并按需重新导出；历史工作区 HTML 与旧包未自动净化。受控恶意 HTML 浏览器回归已通过，新包还需用获授权样本站点逐包验收静态页面、报告与交互镜像。
- 静态和交互导出已改候选构建，历史克隆 HTML 仅在候选副本净化，提交前验证；失败保留旧正式包和诊断候选。旧包仍需逐包重新导出与部署验收。

## 运维

- [ ] SEO 定时门禁启用前，录入授权目标与受版本控制的有效基线，再恢复 schedule；空目标、缺基线和损坏基线不得假绿。
- [ ] 定期审计依赖公告和实际调用路径；跨主版本升级像素评分库时保留对照运行，避免无意改变历史评级。
- 历史产物修复工具（`fullshot.mjs`、`repair-css-refs.mjs`）已在[维护说明](guide/04-legacy-maintenance.md)按适用症状、预览和备份流程归档；长期未调用且无引用时再评估移除。
- 当前文档链接已接入 `pnpm docs:links`/CI。交付包 URL 改写正则已预编译并去重，整包耗时收益仍需真实大包测量。
- “最近删除”已有容量告警、只读预览和空终态记录的显式清理，隔离区内按硬链接去重统计占用；[受控测试与截图](./audits/README.md)已保存。隔离数据默认持续保留，不自动清空。
- [x] 为仍可恢复的隔离数据提供显式 dataRoot 外备份、逐文件 SHA-256/tree hash、清理前 revision 复核、从备份重建和中断收据；同文件系统备份默认拒绝清理，跨设备/跨故障域与长期容量治理仍待设计。
- 交付包保留策略已有预览 revision、候选指纹复核、同卷隔离与恢复收据；执行前需核对候选，隔离不释放空间。真实旧包未清理。
- [ ] 设计交付包隔离区的容量治理、独立备份与永久清理门槛；复用最近删除的保守策略，不能把“已隔离”误报成“已释放”。
- [ ] 反向代理部署时显式配置并验证 `HEIMDALL_TRUSTED_HOSTS`、Token、静态文档隔离与镜像子域路由。

每项完成时附运行命令、产物路径和实际结果；仅有代码合入或单测通过不足以关闭整站验收项。
