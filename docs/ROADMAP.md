# Heimdall 路线图

更新：2026-10-18。这里记录当前仍需完成或长期维护的工作。2026-10-13 前的逐项历史与已完成条目在 [归档路线图](archive/ROADMAP-through-2026-10-13.md)；本轮修复前证据、复验及剩余边界见 [审查报告](audits/2026-10-14/README.md)。

本机旧产物已做[只读盘点](audits/2026-10-14/evidence/historical-inventory.md)：历史 atlas 可比较的 641 个 URL 中 397 个有对应克隆，62 份原工作区多视口验证均为旧口径。按 2026-10-15 最新验证器指纹的[隔离批处理快照](audits/2026-10-14/evidence/historical-v2-final-20261015/README.md)，407 个带克隆页中 **2 页完整测量**（`angular.dev/ai` 90.55% B、`home` 94.80% B）、**3 页未测成**（`apify.com/ideas`、`jobs`、`apify-instagram-scraper` 渲染未收敛）、**402 页待测**；另有 1 页 `no_clone`，不计入分母。旧的[四页已测快照](audits/2026-10-14/evidence/historical-v2-batch/README.md)只供追溯，不能沿用 Apify 旧分数。新批处理已支持超长页分段截图，但该页仍须解决采集完成条件。批处理只做三视口视觉验证，不包含交互；原件保持只读，运行状态在被 Git 忽略的 `core/workspace/_runs/historical-v2-batch/`。以下任务不得原地覆盖旧证据。

本轮[公开页面独立交付验收](audits/2026-10-15/public-site-acceptance.md)显示：`example.org` 首页 1/1 完成克隆、三视口验证与隔离离线部署；`hobix.com/learn/examples/A01/` 的受限三页样本完成九视口验证、`root=landing` 严格离线导出及搬迁后断外联导航验收，新版有界浏览器探针复验 3/3 通过；`vite.dev` 的 57 个已发现 URL 完成 57/57 克隆和 v2 三视口验证，平均 91.51%，但 `root=mirror` 严格导出仍被 1 个 YouTube 嵌入、54 处 CarbonAds 脚本引用和 23 个未镜像链接阻断。这些样本都不能证明任意站点已可完整复刻。

2026-10-16 的[第三方运行时与未镜像链接观测](audits/2026-10-16/third-party-runtime-report.md)已把 Vite 的 23 个未镜像链接拆成 12 个源文档链接与 8 个路径别名，并把 CarbonAds、YouTube 显式归类为 `unsupported-runtime`。严格导出仍失败并保留候选包；该报告只提升失败定位能力，不表示缺口已解决。

同日[公开文本与路径别名奇偶性](audits/2026-10-16/public-text-and-alias-parity.md)复验把公开文本预算提升为默认 128 / 上限 256，修正 `config.md` 误判私有路径的问题；Vite 44/44 个公开文本目标全部捕获，12 个 `.md` 缺口消失。7 个源站 404 别名共 10 次引用被改写到镜像命名空间并按可复现 404 处理。随后代码已把跨域别名跳转升级为独立的 `unsupported-external-redirect` 策略（见[策略记录](audits/2026-10-16/unsupported-external-redirect-policy.md)），可在 strict 下显式接受并保留证据。CarbonAds 已支持默认阻断、显式 `--remove-carbonads` 降级（见[策略记录](audits/2026-10-16/carbonads-removal-policy.md)）；YouTube 已支持默认阻断、显式 `--replace-youtube` 本地占位（见[策略记录](audits/2026-10-16/youtube-placeholder-policy.md)）。三者叠加后 Vite 57 页的静态资源缺口清零，但浏览器探针发现 Iconify、sponsors、运行时 CarbonAds、YouTube 外联和 3 个 `.riv` 资源仍导致 57/57 失败，包未发布。

浏览器探针证据已并入 `health.thirdPartyServices`（见[归类记录](audits/2026-10-16/browser-runtime-services.md)）：静态扫描清零后，`externalRequest` 会按服务归类并继续进入 strict 阻断，未识别 origin 保守标记为 `external-runtime`。这解决的是失败可解释性，不表示运行时缺口已处理。

同日新增[运行时服务显式缓存策略](audits/2026-10-16/runtime-service-cache-policy.md)：只按策略文件声明缓存安全 GET 响应，补齐 Iconify 镜像域名、JS 基址改写、带查询 `_ext` 哈希实体路由、CarbonAds/YouTube 运行时脚本改写和 `.riv` 静态化。Vite 公开样本 57/57 页完成严格导出，浏览器探针 0 失败、0 未测、0 个运行时外部 origin；复制到不含原工作区的目录后搬迁复验仍为 57/57、0 失败。该结果只覆盖本样本与已声明策略，不表示任意站点已可完整复刻。

同日完成 [vitest.dev 221 页公开样本全站 strict 离线验收](audits/2026-10-16/vitest-full-strict-offline-acceptance.md)：221/221 页克隆并交付，213 个公开文本文档全部捕获，Iconify 21 个安全 GET 全部缓存，隐私扫描 clean，strict blockers 全量为 0；正式包复制到不含原工作区的独立目录后，根路径与 `/lm/vitest.dev/` 均 200，221 页断外联浏览器复验 0 失败、0 未测、0 个运行时外部 origin。视觉验证为 219 页完整测量、平均 94.10%，2 页因源站渲染未收敛未测成。该样本未覆盖登录、写操作和实时业务，仍不能证明任意站点完整复刻。

同日[公开页面离线验收](audits/2026-10-16/public-page-offline-acceptance.md)确认 `example.com` 单页可完成 strict 导出、独立 Node 服务与浏览器访问；`vitest.dev` 单页在 heal / materialize 后同源与跨源静态资源缺口清零，剩余 16 个阻断均为未克隆站内链接。验收还修复了 `dns-prefetch` 被子串匹配误判为 `prefetch` 的 strict 假缺口。两个样本均为 `captured-only`，不能证明整站覆盖。

## 比赛方向：项目还原度与 BUG 自动验收

2026-10-16 已实现[项目验收工作台](competition/acceptance-workbench.md)：独立 baseline / target 输入、Mirror / Regression 模式、375 / 768 / 1440 三视口、页面结构与运行健康检查、click / fill / press 与可见性 / 文本 / 属性 / URL 断言；双方重复截图识别不稳定差异，遮罩覆盖过大与全页预算超限进入复核。输出明确的问题归因、复现步骤、截图 / 差异图 / DOM / 网络摘要、计划与验证器指纹、证据 SHA-256。AI 解读仅按需发送脱敏摘要，不能修改门禁。固定夹具的检出率、误报与门禁及控制台闭环接入 CI，实际结果见[实施验收记录](audits/2026-10-16/acceptance-workbench.md)。

[D5 自身 CI 超时记录与调度修复](audits/2026-10-18/acceptance-defect-ticket-ci-timeout.md)单独保留 D5 精确提交的 cancelled 终态：全量 Core 与前 19 项 smoke 成功，第 20 项取消，Docker 未运行。双核默认文件并发由 1 调到 2，45 分钟时限与完整门禁保留；该提交自身 Linux CI 结果见下方来源会话诊断记录。

调度提交 `209cf40` 自身 CI 已确认为[来源会话断言 failure](audits/2026-10-18/acceptance-source-session-ci.md)，Core 唯一失败，后续 20 项 smoke 与 Docker 均 skipped。本片仅补全原断言的脱敏失败报告；受控负载复现不能代替旧 CI 根因，也未放宽 timeout 或宣称修复。后续精确提交仍须完整 Linux 门禁，间歇失败风险继续跟踪。

当前进展与后续重点：

1. Spec 已增加[批准清单与 OpenAPI JSON 只读契约](competition/acceptance-spec.md)，区分来源事实、未批准候选、批准清单与遗漏项，覆盖 HTTP 200 业务错误码。[实施记录与证据](audits/2026-10-16/acceptance-spec.md)包含 11 案例基准、17 项真实控制台检查与完整来源快照。下一步扩大获授权的真实接口样本、参数 / 多响应 / schema 支持及认证，保持未实现约束明确受阻。
2. 用获授权的真实开发项目验证 Mirror 的视觉阈值、字体 / 延迟数据 / 布局稳定窗口；固定注入夹具不能证明真实项目泛化。
3. 已增加[显式运行对复验](competition/acceptance-comparison.md)：稳定身份区分定义、依据、实际视口与环境；重新核对当前报告及证据，输出仍失败、可靠复验通过、新增失败、未复验和不可比。[实施记录](audits/2026-10-16/acceptance-comparison.md)包含固定假修复反例和真实控制台验证。现已交付[本地项目、不可变版本与历史运行归属](competition/acceptance-catalog.md)，通过单写者所有权、目录双 CAS、严格持久化与[真实双引擎/重启/控制台验收](audits/2026-10-16/acceptance-catalog.md)。[目录格式单次升级](audits/2026-10-16/acceptance-catalog-migration.md)独立验证旧格式、保存原始前像、切换 generation 并校验备份谱系。现已接入 [Spec 需求候选完整预览、显式批准和独立选用历史](competition/acceptance-baseline.md)，来源在写入前与正式提交前重验；[实施验收](audits/2026-10-16/acceptance-baseline.md)覆盖完整草稿、失败目标、冲突、来源变化与取消。托管 Spec 已增加准备、固定身份存储与[核验读取](audits/2026-10-17/acceptance-managed-reading.md)，目标版本来源独立保存；[专用 HTTP 真实执行](audits/2026-10-17/acceptance-managed-execution.md)现支持完整新确认接纳、共享槽和取消。已接入[owner 启动恢复](audits/2026-10-17/acceptance-owned-recovery.md)，整批预检后只收束 running、不重发请求；已增加[明确目标版本的执行 UI](audits/2026-10-17/acceptance-execution-ui.md)、持久凭据恢复与请求停止。Browser 已从来源归属、完整候选推进到[D3 单次批准固定来源执行](competition/acceptance-browser-execution.md)，并保存显式检查问题与前后操作复验记录；[D5 人工缺陷单](competition/acceptance-defect-tickets.md)已接入固定成员成单与显式关闭，其余消费者继续独立迁移。原 Regression 仍由用户提供上一版本 URL，不自动批准新基线。
4. 业务适配器：认证、独立测试账号、写操作精确许可、只读 DB 对账和状态机，先用脱敏 Xspark 夹具，后接授权测试环境。
5. Figma 元数据、设计容差与 PRD 来源追踪；录制交互和生成候选断言，人工批准后执行。
6. D4 已增加[未知启动的完整决定核对与永久拒绝](competition/acceptance-browser-start-resolution.md)：原六字段回执、完整 accepted / rejected 证明、迟到启动阻断与跨页 Web Locks；原确认只在证明核验后精确解除。D5 已在 D3 检查级账本之上接入[固定成员人工缺陷单](competition/acceptance-defect-tickets.md)：从同次登记的可靠失败成单，最新同范围登记可靠通过全部成员后显式关闭，后续可靠失败派生重开。[本机验收记录](audits/2026-10-18/acceptance-defect-tickets.md)保存该片完整门禁与公开证据。未知人工动作保留原确认，只 GET 核对、不自动重发 POST；人工动作的永久拒绝尚未提供。全局 Browser approval / selection、操作归档与其余消费者仍独立建设。

B2.2-a 已补充[托管 Spec 准备内核](competition/acceptance-managed-spec.md)：当前选用与明确目标版本在同一目录队列中核验，重建规范合同并保存不可变派发准备；同键只查询原记录，准备不改目录修订、不创建 run / task、不发请求。B2.2-b 的[runner 控制基础](audits/2026-10-16/acceptance-spec-execution-control.md)增加可取消 fetch / body / 事件等待与同步 active 检查，操作核对物理只读并固定已见祖先身份。[来源关联与隔离](audits/2026-10-17/acceptance-managed-provenance.md)增加纯 provenance / linkage 校验和普通入口防降级，坏派发记录阻塞恢复写入但保留目录读取。[固定身份存储](audits/2026-10-17/acceptance-managed-store.md)增加 owner 约束的 create / progress / finish / settle、证据交叉核对及明确的终态提交点。[托管读取切片](audits/2026-10-17/acceptance-managed-reading.md)已完成 head / list、完成快照、核验下载、比较及 HTTP / 控制台安全投影；已接入[owner 启动恢复](audits/2026-10-17/acceptance-owned-recovery.md)，完成有界清单、整批预检、固定字节收束、诊断 readiness 与失败写入阻断；已接[owner 内真实执行](audits/2026-10-17/acceptance-managed-execution.md)、普通/托管共享槽、取消 / watchdog / shutdown 和任务投影，浏览器可观察 HTTP 启动的运行与下载核验原件。明确目标版本的[执行按钮与原操作恢复](audits/2026-10-17/acceptance-execution-ui.md)已接入。Browser 的完整来源复核、候选写入与重启读取已接入，并新增[D3 单次批准执行与检查级复验](competition/acceptance-browser-execution.md)和[D5 固定成员人工闭环](competition/acceptance-defect-tickets.md)；全局 Browser 批准与选用仍待建设，操作归档管理与 candidate / triage 独立迁移。候选、归属及 Spec 批准响应仍为 `executionReady:false`，D3 执行权限来自本次新的完整确认。

Browser 所选侧来源已交付[纯字节核验内核](competition/acceptance-browser-source.md)：独立重建六基础槽及 point 槽、核验原件和所有实际引用证据、重算稳定性并从所选侧生成新 oracle；四组真实 Browser 样本与离线反例见[实施记录](audits/2026-10-17/acceptance-browser-source.md)。[owner/fence 私有读取器](competition/acceptance-browser-reading.md)原生读取 nullable 角色和全引用，保留 managed 隔离；[读取验收](audits/2026-10-17/acceptance-browser-reading.md)记录新采集闭环与对抗检查。[Schema3 分步迁移](competition/acceptance-catalog-schema3.md)建立独立来源表与兼容格式，保留完整 Spec 历史；[来源侧归属与重核验](competition/acceptance-browser-bindings.md)显式选择 baseline / target 并归属 project / release，全库同 run 与 side 唯一，target 与旧运行归属双向相容，完整 planned URL 严格匹配版本，head 提交前重建完整 projection，单条诊断读取保留历史，新采集 mirror / regression 与事务反例见[绑定验收](audits/2026-10-17/acceptance-browser-bindings.md)。现已增加[HTTP 与工作台](competition/acceptance-browser-bindings-console.md)：已存列表不读来源，单条按需重核验，专用 URL 字段隐藏整段 query，三类证据经受保护接口与 MIME / 大小 / SHA 校验后展示，迟到读取与未知 POST 通过共享目录状态恢复，详见[工作台验收](audits/2026-10-17/acceptance-browser-bindings-console.md)。显示预览仍为 `completeSourceProjection:false`；[D2 完整复核与持久候选](competition/acceptance-browser-candidates.md)已接入完整明文复核、明确确认、只读对账与重启读取，候选响应继续为 `executionReady:false`。D3 已实现[固定来源单次批准执行](competition/acceptance-browser-execution.md)：固定所选侧原件，只采集本次目标，显式登记检查问题，并保留可靠复验通过、再次发现及未能核验的历史。D5 的[人工缺陷单](competition/acceptance-defect-tickets.md)固定成员和来源摘要，分开显示处理状态与当前核验，支持显式关闭、失败重开及 Markdown / JSON 导出；结论只覆盖声明的固定检查。全局 Browser approval / selection 与操作归档继续独立推进。

D1 已实现 [Schema4 与显式维护](competition/acceptance-catalog-schema4.md)：独立 `browserCandidates` 纯格式、组织与来源摘要、显式迁移及旧历史兼容。已有 Schema3 / Schema4 普通启动只打开并验证；旧 Schema1 / Schema2 返回 `MIGRATION_REQUIRED`，须停止同根引擎后显式预览并确认升级到 Schema4，中断后也需重新预览；新空目录由引擎明确创建 Schema3。D1 阶段本机回归、旧数据真实迁移、Browser 混合历史与自身 CI 状态见[实施验收](audits/2026-10-17/acceptance-catalog-schema4.md)。[D2 实施验收](audits/2026-10-17/acceptance-browser-candidates.md)记录完整来源复核、显式保存候选和重启后来源重核验的真实闭环；[D1 自身 CI 复核](audits/2026-10-17/acceptance-catalog-d1-ci.md)保留已通过步骤与旧 preparation 夹具失败，D2 已完成显式维护适配。[D3 实施记录](audits/2026-10-17/acceptance-browser-execution.md)单独记录固定来源执行、检查级持久问题账本与显式复验；各阶段测试与精确提交 CI 状态以对应实施记录为准。

运行轮询已补充[原子发布期间的稳定展示读取](audits/2026-10-17/acceptance-display-head-race.md)，修复普通 worker 更新进度时的误拒绝。展示版本不能授权来源快照、证据下载或写操作；原工作台精确提交的 CI 失败与修复验证分别归档。

## 主目标：独立站点镜像

目标是持续提高可克隆站点的覆盖率，并使导出包在声明的范围内真正脱离原站运行。每个包按 [产品定义](../PRD.md) 标注可查看快照、可离线浏览、可离线交互或完整业务替代等级；覆盖率、失败原因和未测范围与等级一起交付。实现顺序：

1. **真实离线门禁**：在候选包中启动独立服务，用浏览器加载每个声明的页面并阻断所有外联；动态请求、脚本报错、本地 HTTP 失败和未测页都进入 `health.json`，未通过不得发布为离线可用。
2. **页面状态与依赖图**：从 URL 图扩展到 URL、视口、会话与操作后的状态；记录每个状态实际使用的脚本、样式、媒体、API 和跨域资源，支持有界的点击/输入/滚动探索，并明确未探索的分支。
3. **本地运行时**：区分可直接本地化的资源、可安全回放的只读数据、需要业务适配器的有状态请求及不支持的实时连接。独立交付模式禁止静默回源。
4. **兼容性矩阵**：用获授权的 SSR、SPA、长页、query/分页、认证、iframe/Shadow DOM、Canvas/WebGL 和实时请求站点逐类验收。每类包含缺页、缺资源和接口失败反例；所有分数对应同一版验证器与完整覆盖率。
5. **部署验收**：在不含原工作区的干净环境运行 Node/Docker 包，阻断原站网络，完成关键路径、数据分发检查和回滚演练，再扩大站点样本。

当前 `--strict` 已在静态和 HTTP 检查后加入 Chromium 逐页断外联加载探测；外联请求、WebSocket、本地 4xx/5xx、脚本异常及未测页会阻断候选包发布，旧正式包保留。逐页探测默认覆盖全部包内路由，至少观察 3000 毫秒，再等待 500 毫秒网络安静，默认最长 8000 毫秒；到上限仍未安静则失败。普通包最多并行探测 4 页，适配器包顺序执行；`health.browserProbe.observation` 记录逐页观察结果，`health.coverage` 另对齐侦察 URL、克隆页与 live 路由。工作区有显式 `operation-plan.json` 时，还会在候选包内断网重放声明的动作与最终断言。未声明操作、延迟超过观察窗口的请求、登录和有状态业务仍未得到通用保证。

侦察已从导航后固定等待 400 毫秒、读取一次链接，改为观察渲染链接最少 1200 毫秒、静默 350 毫秒、最多 3000 毫秒；晚出现的同源 query 链接会进入 BFS。HTTP 错误、非 HTML 和跨源落地不建页面节点；同源重定向使用最终 URL。客户端 `history` 改址先标为 `directNavigation=unverified-client-route`，只有该 URL 实际直访取得 HTML 才清除。`atlas.meta.renderedLinks` 记录观察预算和触顶页数。安静页可能在 1200 毫秒结束，之后出现的链接仍会漏；已发现的客户端路由也不等于独立直访可用。Vite 在同一 57 URL、深度 1 预算下重跑新版侦察，结果与旧 atlas 完全一致，57 页均完成观察且无客户端路由未验证；这只能说明本预算下未发现新增链接，不能证明整站全集。

严格导出已支持 CLI 和控制台的 `--all-discovered` 入队、对声明流程的源站只读对照、精确许可的 GET 回放、候选包凭据特征扫描，以及受控 SSR/SPA 包在移走源工作区后的 Node 断网浏览。侦察新增 robots 声明、递归及压缩 sitemap，并在 atlas 里记录页面数、深度与 sitemap 扫描预算；`health.coverage` 用同一已发现 URL 分母列出按当前默认配方估算的排除、实际入队、克隆、v2 验证和交付数量。预算触顶与扫描失败仍标为范围受限。`--compare-source` 逐流程核对请求的精确路径及查询、次数、状态与 MIME；许可 GET 另核对清洗后正文指纹。`--include-adapter` 为逐站有状态业务提供显式接管入口，只有已声明、已在离线操作计划中触达的路由才允许严格交付。本机严格探针不隔离适配器 Node 进程外联，`health.adapter.serverEgress=not-tested`；实际适配器必须另做无外联部署验收。Linux CI 已通过受控 SSR、SPA、数据驱动 SPA 和适配器卷持久化的 Docker 无外联网络验收（主分支提交 `75dceeb`）；本机 Docker 守护进程不可用。上述夹具与门禁仍不构成任意站点完整复刻。下一批按依赖顺序推进：

1. 将现有按声明流程的请求依赖对照扩展到 iframe、Shadow DOM、延迟请求和多会话状态。2026-10-16 已覆盖 iframe/subframe 归属、Shadow DOM 请求捕获、最后一个状态后的延迟请求阻断、按 flow 声明的命名登录态，以及同一 flow 内的 `useSession` 上下文切换（见[操作依赖审计](audits/2026-10-16/operation-frame-late-parity.md)、[会话切换审计](audits/2026-10-16/in-flow-session-switch-parity.md)与[适配器会话引导审计](audits/2026-10-16/adapter-session-bootstrap.md)）。源站可切换匿名 / 命名登录态；离线包支持匿名切换，并可通过本地适配器的 `sessions` 清单显式引导命名会话。缺失路由、失败响应或无 `Set-Cookie` 都以 `sessionUnsupported` fail-closed；本地引导不参与源站/离线依赖等价。独立登录、会话延续与写入业务仍需逐站适配器。视觉相似、请求匹配和只读响应相同都不等于业务结果一致。
2. 为登录、账户状态、写入型 API 和实时连接逐站实现适配器及契约验收；现有适配器只是接入协议，没有通用业务实现。`--include-api-har` 不能替代有状态业务实现。
3. 用授权真实站点复核 `health.coverage` 的同分母口径，处理 sitemap 不可用、JS 生成页面、隐藏入口及近乎无限的 URL 空间；已发现范围不等于整站全集。
4. 扩展分发审查到个人数据、业务机密及二进制资源，并按授权站点人工审核；当前扫描只识别一组凭据特征，大包扫描超限会标为不完整。
5. 数据驱动 SPA 已和 SSR、普通 SPA 一起通过 Linux CI 的 Node/Docker 断网验收；继续加入适配器的包外状态卷、写入及重启持久化验收，再用获授权真实站点跑全链路断网部署，扩展到认证、长页、查询页、iframe 和动态业务样本。这仍是受控样本，并非站点架构的完整覆盖。

第一阶段的退出条件：三个不同架构的受控站点可在干净环境独立部署；阻断原站后，声明范围内的所有页面和操作均通过真实浏览器验收；其余能力明确标为未支持，而不是以在线代理成功冒充离线克隆。

## 可信交付

- [ ] 续跑 `core/scripts/verify-historical-batch.mjs` 的隔离多视口验证：先为 Apify 三个未测页定义有界、可复现的动态请求/布局完成条件，再测其余 402 页；`pages.csv`、`viewports.csv` 已记录状态、尺寸、覆盖率、缺口和失败原因，完成后复核全量对照表。
- [x] 新单页 `score.json` 在无可抽取字段时返回数据未测并归一剩余权重，多帧首帧完全一致时不再被差帧覆盖；`scoreFormulaVersion: 2` 区分新旧口径，旧产物只读保留。历史单页分数仍待批量重算。
- [ ] 用一套有授权的真实站点完成“侦察 → 全页克隆 → 全站验证 → 离线 strict → 独立包断网浏览 → 接手”回归，记录每一步的目标数和通过数。
- [ ] 用专门的认证测试站覆盖登录、Cookie 轮换、POST/API、重定向、登出及 HAR 清洗；明确哪些交互能离线回放，哪些必须回源。
- [ ] 对带 query、长路径和分隔符碰撞的现存站点做覆盖率复核；旧目录保持可读，并给出必要时的显式迁移工具。
- [x] 为同一 hostname 的多个 origin（协议或端口不同）提供稳定 sibling ID：旧目录保持，身份贯通侦察、克隆、API、静态 atlas、控制台选择、交互镜像、一次性票据与独立导出；受控双端口 fixture、最终整套门禁与[独立 CDP 真克隆](audits/2026-10-14/evidence/cdp-origin-final/cdp-real-forge.json)已通过，真实部署仍待复验。
- [x] 静态 strict 扫描 HTML `<style>` 块和 `style` 属性中的 `url()`、`@import`，缺失的内联 CSS 资源计入 `unresolved` 并阻断导出；运行时动态请求仍在断网浏览器验收范围。

## 产品与规模

- 验收摘要已在控制台报告页提供：发现、计划、实际、v2 完整验证、未测、资源缺口、失败与证据状态；[受控浏览器证据](audits/2026-10-14/evidence/acceptance-summary/browser-checks.json)覆盖桌面/390px、刷新、JSON 打开与 Markdown 下载。旧产物的缺失或过期证据明确标注，不算通过。
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
- “最近删除”已有容量告警、只读预览和空终态记录的显式清理，隔离区内按硬链接去重统计占用；[受控测试与截图](audits/2026-10-14/evidence/cleanup-and-chooser/)已保存。隔离数据默认持续保留，不自动清空。
- [x] 为仍可恢复的隔离数据提供显式 dataRoot 外备份、逐文件 SHA-256/tree hash、清理前 revision 复核、从备份重建和中断收据；同文件系统备份默认拒绝清理，跨设备/跨故障域与长期容量治理仍待设计。
- 交付包保留策略已有预览 revision、候选指纹复核、同卷隔离与恢复收据；执行前需核对候选，隔离不释放空间。真实旧包未清理。
- [ ] 设计交付包隔离区的容量治理、独立备份与永久清理门槛；复用最近删除的保守策略，不能把“已隔离”误报成“已释放”。
- [ ] 反向代理部署时显式配置并验证 `HEIMDALL_TRUSTED_HOSTS`、Token、静态文档隔离与镜像子域路由。

每项完成时附运行命令、产物路径和实际结果；仅有代码合入或单测通过不足以关闭整站验收项。
