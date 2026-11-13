# Heimdall 当前状态（STATUS）

> 更新：2026-11-14 · **本页是“当前为真”的唯一入口**。历史接手记录与逐日审计已归档，见文末。

## 一句话

面向获授权网站，采集证据、辅助 AI 重建与独立部署，度量还原度，诊断 SEO/GEO，并按充分的需求与接口信息检测前后端缺陷。

## 现在的主线

**持续增强三项能力，用真实案例推动改进**。Heimdall 采集和核验证据，外部 AI 代理补全实现与提出修复方案：

1. **站点重建与独立交付**：捕获页面、资产和可观察行为，辅助 AI 补写缺失功能，验证多视口还原度与离线交付；未知后端规则保留为待确认事项。
2. **SEO/GEO 诊断与优化**：基于采集证据评分，输出可追溯、可复测的改进方案；GEO 当前是准备度启发式，尚未验证真实模型引用命中率。
3. **前后端缺陷检测**：结合页面、业务需求、账号权限、接口契约和声明检查点检测问题；分别说明已验证、未测和证据不足的范围。

优先复用现有入口、修正真实案例中的误报与漏测，保持核心代码为主体，运行证据放在仓库外。验收子系统保持冻结，作为正式门禁被调用。

2026-11-14 [评分证据失效与扫描复用](ROADMAP.md#可信交付)：单页 `score.json` 绑定 clone 输入哈希；控制台和 AI 读取路径会排除旧分数，并复用多视口验证已经核实的 `inputSha256`，避免对已验证页面重复哈希整棵 clone 树。真实 CSS 变化验收覆盖 API、`site`、`clone`、`site-assessment`，目标链路通过；IANA 8 页与 Datasette 83 页当前 CLI 基线分别为 `site` 中位数 265/349 ms、`site-assessment` 中位数 255/336 ms，历史分数均被排除；并发、内存和浏览器验证累计成本仍待测。

2026-11-13 [64 位整数资源关联实测](audits/2026-11-13/qa-int64.md)：真实 Datasette + SQLite 八场景，修正两次错误通过与三次健康误拒绝；长整数原 token 贯通动态路径、字段引用与 MCP，数字与字符串仍区分。每次仅页面自身两次 GET，绑定值不进入报告。复用原模块和测试，未支持的大整数写法保留未核实，整数常量需在安全范围；生产认证、事务与完整业务仍未验证。源码 CI 8/8，Core 3,332 通过 / 4 条件跳过，Docker 独立 2/2、MCP 7/7。

2026-11-14 [Datasette 独立部署复验](audits/2026-11-13/datasette-standalone.md)：在源站停止后重新导出 83 个 live 页面和 68 条公开只读数据；修复健康扫描把同路径无查询 HAR 错算为查询变体覆盖的假通过。最新候选的 250 条运行路径 0 失败，83 页浏览器探针 9 页发现 `CodeMirror is not defined`，当前复核结果会同时给出 `ReferenceError` 类型和脱敏 `message`，实际 HTTP 错误还带受控 `resourceType`；`site-assessment` 现在把这些有限失败摘要交给 AI 交付计划，形成修复后复测入口，并把 `/library.db` 识别为需要人工授权审核的二进制分发缺口；二进制缺口待授权后会提示 `binaryPaths` 与 `--include-readonly-binaries` 复测路径；真实缺口为 664 个站内链接、`/library.db` 二进制下载、3 条操作流未测和 1 条适配器路由未测；严格发布继续阻断，未宣称整站等价。

2026-11-13 [标题与描述长度实测](audits/2026-11-13/seo-metadata-length.md)：四类固定字符数扣分改为人工检查提示，GEO 摘要项只确认非空文本。四页冻结样本复算中，豆瓣 SEO 46→54、GEO 61.5→65.6，RFC 9309 与 Google 标题指南各恢复 2 分，缺失描述对照不变；相关测试 259/259，托管 CI 8/8，Core 3,332 通过 / 4 条件跳过，Docker 独立 2/2。当前 SEO 评分 **13**、测量 **8**、GEO **8**，仍为 64 条规则；旧基线须换新路径审核，分数变化不代表搜索或引用效果改善。

2026-11-13 [候选 URL 与视口趋势隔离实测](audits/2026-11-13/candidate-trend-identity.md)：完整 URL 保留查询和片段，趋势还要求实际视口集合、参考和分段声明一致，旧混合键不复用。IANA 冻结首页七次受控路由访问中，原先的变好/变差/振荡误导被纠正，逐次分数与通过/失败保持不变；重复 URL 回到自己的前次记录。只改原运行与测试文件，不增加依赖或工具；完整站点和正式包仍需验收。

2026-11-13 [镜像参考缓存与还原度实测](audits/2026-11-13/mirror-reference-integrity.md)：CSS 已改变而 HTML 时间未变时，旧参考仍给 IANA 首页三个视口 100%；改为复用现有内容哈希核对分段、元素、参考图片与拍摄条件后，同一差异分别为 84.744% / 86.599% / 80.993%，恢复为 100%。损坏证据与旧遮罩不复用，趋势按参考 ID 隔离；复用原测试文件，没有新增依赖或运行模块。该轮只验证冻结首页与本地参考，不替代完整站点、正式包或业务验收，SEO/GEO 口径不变。

2026-11-13 [动态资源响应关联实测](audits/2026-11-13/qa-response-bindings.md)：被动观察支持较早响应的类型值引用，核对创建后是否按动态 ID 读取、更新同一资源，不新增请求或写权限。真实 JSON Server 八场景符合预期，路径串号、应答 ID 错误、类型错误及重复请求均保留未完成；默认阻断零业务请求，缺少读取声明的对照仍漏检。复用原模块与两个测试文件，参考依赖及运行证据在仓库外；完整业务与生产认证仍未验证，SEO/GEO 口径不变。

2026-11-13 [HTTP canonical 与冲突声明实测](audits/2026-11-13/seo-http-canonical.md)：RFC Editor 两个真实页面通过 HTTP Link 声明 canonical，原工具均误报缺失；冻结重放后 SEO 21→27、GEO 27.1→33.3，Example Domain 对照不变。HTML 与响应头统一核对并保留来源，不任选冲突目标；非自指或跨域本身改为不扣分观察。当轮 SEO 评分 **12**、测量 **8**、GEO **7**，仍为 64 条规则；目标内容、索引选择与实际引用效果仍未验证。

2026-11-13 [成对 Cookie 与独立会话后端实测](audits/2026-11-13/backend-cookie-session.md)：修复 B3 生成服务丢失同名 Set-Cookie 头的问题，复用 live 运行时已有函数。基于真实 cookie-session 的观察补写有限会话后端，在 Windows 和实际生成的 Node 22 断网、只读根容器中各通过同一组 24 个 HTTP 检查点，替换容器后会话继续有效；7 个镜像运行文件哈希一致，没有原工作区挂载。真实浏览器检出旧头处理造成的会话丢失，健康与恢复版通过；另修 204 空体取消误报及默认匿名探测认证路由的误导。账号选择入口是隔离实验的会话初始化，未实现生产身份认证、撤销或完整权限模型。

2026-11-13 [认证与资源归属实测](audits/2026-11-13/qa-auth-ownership.md)：固定版本真实认证服务的双账号十场景验证匿名拒绝、主人访问、跨账号拒绝、无效令牌及恢复。页面正常但网关放错账号或归属字段错误时，响应声明保留未完成；预期 401/403 不误判登录失效。修复共享脱敏函数对已知 Bearer 裸令牌的遗漏，并在错误消息截断前脱敏，避免留下前缀；实际 JWT 的追加复测通过，两次第三方来源请求未收到认证头。参考依赖和运行证据均在仓库外，复用现有测试文件；该轮未补写认证后端，完整权限模型和其他认证机制仍未验证。

2026-11-13 [写入接口应答实测](audits/2026-11-13/qa-write-responses.md)：现有响应观察贯通 PUT/PATCH/DELETE，CLI、MCP、HTTP 共用声明与执行逻辑；仅观察页面原请求，是否放行仍由既有写策略决定。真实 JSON Server 七场景中，健康/恢复通过，页面正常但写入应答状态、字段或完整性违约均保留未完成；只验页面的对照漏掉 PUT 应答错误，阻断场景没有页面业务 API 请求抵达网关。未增加依赖、模块或测试文件，SEO/GEO 口径不变；该轮未验证认证、权限与完整业务。

2026-11-13 [多语言正文测量与短页误报实测](audits/2026-11-13/seo-multilingual.md)：冻结 Mozilla 宣言的韩、日、中、英四页及 Example Domain，统一初始 HTML 和渲染后正文分词；韩文原计数 206 修正为 1,048，SEO 76→82。固定字数改为不扣分观察；Example Domain 初始 HTML 长于可见正文，移除 40 词下限后 GEO 14.1→22.8。五页在 Windows Node 26 与断网 Node 22 容器中复算一致。该轮 SEO 评分 **11**、测量 **7**、GEO **6**，64 条规则；旧基线保留，分数变化来自工具纠偏，不代表搜索或引用效果提升。

2026-11-13 [分页与分面机制实测](audits/2026-11-13/seo-pagination-mechanism.md)：Hacker News 真实分页共用标题，原先同时被通用与分页规则扣分；两页冻结样本 37→43，补入精确基础地址首页的三页样本 39.3→43.3，WordPress 对照均不变。分页与分面地址比较复用严格 HTTP(S) 资源身份函数，部分或无效 canonical 不再把整组参数页当作已收敛，优化建议按内容与发布意图分情况给出。当轮 SEO 评分口径 **10**、测量口径 **6**、GEO 方法 **5**，仍为 64 条规则；已推送的中间口径 9 单独保留，分数变化不代表站点效果改善。

2026-11-13 [有状态后端与动态资源路由实测](audits/2026-11-13/stateful-backend.md)：以固定版本真实 JSON Server 的 HTTP 观察补写独立后端，冻结实现后在 Windows 与实际生成的 Node 22 断网只读容器中各通过 24/24 HTTP 检查点及一次同卷重启。新增共享的单段参数路由匹配，贯通运行时、B3 契约和严格导出覆盖统计；Heimdall QA 对两种注入故障均返回未完成并分别记录页面违约，健康与还原版通过。仅覆盖本例资源语义，默认参数/写路由检查、认证与权限仍保留未知；SEO/GEO 口径不变。

2026-11-13 [JSON-LD 标准语义实测](audits/2026-11-13/jsonld-semantics.md)：修复 W3C 冻结页面的别名误报，未核实上下文保留未知并阻断基线，两个对照页不变；直接浏览器访问 W3C 的 403 单独保留。该次采用 SEO 评分口径 7、测量口径 6、GEO 方法 5，共 64 条 SEO 规则；分数变化不代表网站搜索效果改善。上一轮[推荐字段评分纠偏](audits/2026-11-13/structured-data-scoring.md)的证据仍保留。

2026-11-13 [生成包 Dockerfile 实测](audits/2026-11-13/generated-docker.md)：修复 B3 镜像默认映射端口不可达、状态目录未接入卷的问题。商品后端 6/6 冻结留出与 IANA 八页本地搜索 21/21 HTTP 检查，在实际生成的镜像、断网只读根且不挂载原工作区时通过；受控账本在同卷替换容器后保留。IANA 未捕获链接继续阻断严格发布，尚不证明完整业务持久化。

2026-11-13 [hreflang 机制实测](audits/2026-11-13/seo-hreflang.md)：完整地址匹配不再丢弃查询与来源差异，语言检查限定 Google 标记形式，`x-default` 改为不扣分建议；Mozilla 冻结重放 82→84，Rust/Python 对照不变。该轮采用 SEO 评分口径 **8**、测量口径 **6**、GEO 方法 **5**，64 条规则；代码表成员、目标等价和双向关系未验证。

2026-11-13 [响应多字段联合验收](audits/2026-11-13/qa-response-fields.md)：单次响应支持 1–20 项 JSON 标量断言，兼容原对象写法且不重发请求。冻结商品数据与本地受控故障六场景通过，覆盖单字段漏检对照、总数错误/缺失、页面错误及恢复；接口不符仍标记未完成，不自动当成产品缺陷。

同轮下游复核发现站点评估会把“接口未核实但零可提单”的 QA 标成就绪，已复用 CI 完整性判断修正。已有六份实际运行记录只读复算后，错误/缺失总数保持待核实，正常/修复记录保持就绪；旧摘要证据不足则保留未知并要求复测。报告与缺陷单引用改用真实运行目录，六案共 12 个证据入口全部可解析。

## 现在能跑什么

```bash
# 幂等安装 / 启动 / 可选的 AI 客户端配置
node bin/heimdall.mjs setup

# 单页克隆（不需要先起引擎）
node core/src/cli.mjs forge https://example.com home

# 全流程：控制台 + 引擎（幂等）
node bin/heimdall.mjs setup --no-connect

# 一条命令跑完侦察→克隆→验证→资产→交付
node core/src/cli.mjs handoff https://example.org --max-pages 40

# AI 重建竖线（夹具 F1）
heimdall clone http://127.0.0.1:5090/
heimdall rebuild init <siteId> --page home
heimdall brief --project . --detail sections
heimdall compare --project .
heimdall gate report --project . --level gold
heimdall rebuild deliver --project .
```

## 怎么验（2026-11-03 起）

仓库已经公开；`CI` 与 `Docs` 已重新启用，本地和 Hosted Node 22 都按同一套确定性门禁收口：

```bash
pnpm -C core lint          # 语法 + JSON
pnpm -C core check:docs    # 文档链接
pnpm -C core check:frozen  # 验收指纹冻结文件（14 个源文件的字节哈希）
pnpm -C core test:full     # 全量（含真浏览器、验收存储与控制台 E2E），约 28 分钟
pnpm -C core test:acceptance  # 只跑验收套件
pnpm -C console build
pnpm acceptance:demo:smoke # D7 全链路真实 UI
pnpm -C packages/mcp test  # MCP 协议测试
pnpm run audit             # core / console / MCP 三套依赖审计
pnpm check                 # 本地总门禁
```

2026-11-04 Hosted Node 22 两分片合计：全量 **3,014 / 3,018 通过，0 失败，4 跳过**。
`lint` 711 文件、文档 698 个目标 / 140 个文件、冻结验收 14 个文件均通过。
验收基准 18/18、13 个已知 BUG 全检出且 13/13 定位到注入源码；QA 基准 21/21、0 误报。
Console 最大生产 chunk 为 477.84 kB，无超过 500 kB 的警告；三套官方 registry 审计均无已知漏洞。
Node 22 的权威结果由 Hosted CI 的两份真实分片共同组成；2026-11-05 本机完整
`pnpm check` 通过，快速集为 **1,210 / 1,210**，lint 718 文件，文档 701 个目标 /
141 个文件，D7 真实浏览器验收 `accepted:true`。新增安装测试后仍以精确提交的
Hosted CI 结果为最终依据。

## 已知边界（不藏）

- 只碰公开页面或操作者本人有权访问的页面；不绕过登录、验证码、访问控制。
- 交互镜像依赖 `*.localhost` 解析；被代理接管 DNS 的环境里打不开，静态镜像不受影响。
- WebGL、运行时画布、视频、滚动编排：只做降级或明确标不支持。
- 大站（>500 页）受并发与页数上限约束；当前并发 2。
- 后端只能克隆“被观察到的行为”，不声称业务等价。
- 固定夹具成绩很强，但尚未取得获授权、持续可复现的外部项目数据集；不能把 18/18 或 21/21
  直接外推成“任意真实网站都能通过”。
- 验收目录默认 Schema3，Browser 链需要 Schema4；演示前先显式维护：
  `node core/src/acceptance/catalog-maintenance-cli.mjs --create --target-schema 4`。
- 引擎启动时若验收目录锁被其他引擎占用，会打印锁文件路径；确认没有其他引擎后，删除该锁文件再启动，不要删除其他验收数据。

## 文档地图

| 想知道什么 | 读哪里 |
| --- | --- |
| 项目价值、启动、产物 | [README](../README.md) |
| 控制台与 CLI 操作 | [USAGE](../USAGE.md) |
| 产品定义与验收等级 | [PRD](../PRD.md) |
| 边界、风险、演示日清单 | [RISKS](../RISKS.md) |
| 5 分钟演示脚本 | [DEMO-SCRIPT](../DEMO-SCRIPT.md) |
| 当前架构（对着代码维护） | [docs/guide/01-architecture.md](guide/01-architecture.md) |
| AI 接入层方案与路线 | [docs/prd/ai-native/](prd/ai-native/README.md) |
| 接入 Claude Code / Desktop 与 A-3 手测 | [docs/guide/06-ai-integration.md](guide/06-ai-integration.md) |
| 验收工作台各专题 | [docs/competition/](competition/acceptance-workbench.md) |
| 无参照物检测的固定基准 | [qa-detection-benchmark](competition/qa-detection-benchmark.md) |
| 待办与长期维护 | [docs/ROADMAP.md](ROADMAP.md) |
| 审计与实施记录 | [docs/audits/README.md](audits/README.md)（证据已外部归档） |

## 2026-11-03 审查修复收口

- D7 真实 UI 全链路通过：采集、来源归属、候选、已知 BUG、两项人工成员、部分修复禁关、
  完全修复后明确关闭、Markdown 下载；最终结果 `accepted:true`，普通控制台错误为 0。
  同源验收响应在页面 `fetch` 时保留 canonical 字节，不再依赖导航后仍能通过 CDP 回读。
- 取消整站克隆会级联取消仍在运行的页面 forge；`/px/` 只允许有限同源跳转并剥离 Cookie；
  克隆渲染资产按目录与 MIME 开放只读 CORS。
- 恢复 MCP 干净安装、插件产物检查、Windows `pnpm` 参数白名单、原子写文件与 POSIX 目录
  `fsync`、Console WebGL 星图拆包，并把依赖审计接进总门禁与 CI。
- 开源治理补齐 MIT、SECURITY、CONTRIBUTING、CHANGELOG、Dependabot，pnpm 固定到
  `11.28.10`。当前结论仍是“可认真试用和内部验收”，不是“任意站点开箱即成熟产品”。

## 2026-11-05 一键安装与 AI 接入收口

- 新增 `heimdall setup`：按需检查 Node/pnpm、安装三套缺失依赖、Chromium、构建控制台和
  MCP、复用或启动 `:8900` 单端口引擎、打开 UI，并配置检测到的 Claude Code / Claude
  Desktop / Codex。
- `clone-heimdall.cmd` 已改为真正的首次安装器 + 启动器。双击后打开
  `http://127.0.0.1:8900`，不再依赖 `:5173`；重复双击只复用已就绪部分。
- `doctor` 扩充为 13 项，增加依赖、控制台、MCP 和客户端检查；`doctor --fix` 与
  `setup --no-connect --no-open` 共用安全修复实现。
- `connect` 的自测现在使用与实际写入配置完全相同的 `HEIMDALL_API`；dry-run 不启动
  MCP，已有配置也会先备份再改，失败仍回滚。
- 本机实测识别到 Claude Code 插件 `0.2.2`、Claude Desktop 与 Codex；三者均通过
  `doctor`，完整 MCP 客户端各拉起 18 个工具。
- Hosted 精确提交 `1dff01cb14d3878f102fc964485b0b8eaa05bf76`：
  [CI `42016376206`](https://github.com/kael-odin/heimdall/actions/runs/42016376206)
  8 / 8 job 成功，Docs `42016376116` 成功。

## 2026-10-30 仓库瘦身

- **文档**：450 份 / 558MB → 88 份 / 4.8MB。逐日审计报告与 536MB 证据移出工作树，索引见 [docs/audits/README.md](audits/README.md)，原件在外部归档与 git 历史。
- **测试**：默认 `pnpm test` 改为快速集（142 个文件 / 1,140 条 / 约 4–5 分钟）；`pnpm test:full` 保留全量；`pnpm test:acceptance` 只跑验收。
- **工程**：新增 `pnpm check` 一键门禁；根目录空锁文件删除并忽略；Node 固定 22（Docker 同步）；`graphify-out/`、`core/spikes/` 不再出现在 `git status`。

## 2026-10-30 修复包：候选侧数值

- 修复包的每个区域新增 `element.cand`（候选元素矩形 + 计算样式）、`element.styleDiff`（`prop / ref / cand / delta`）与 `element.boxDiff`；区域还会补扫 `element.diffs`，把字号、颜色这类落在更小子元素上的差异带出来。
- `packet.txt` 打印「候选样式 / 样式差」，例如 `fontSize 参考 52px / 候选 46px（−6）`；匹配依据与置信度写在 `match` 里，匹配不到时仍只给参考值，不猜。
- F1 夹具验证：字号、背景色、间距三类注入缺陷都能在修复包里给出候选值与带符号差值。

## 2026-10-31 A-3：Claude Code 插件闭环

- Claude Code 插件 `plugin:heimdall:heimdall` 已安装并连通；当前能力注册表有 18 个工具；本阶段新增 QA CI、SEO 审计、SEO 矩阵、站点变更监控和站点评估。
- 本会话用 MCP 工具完成 F1 重建：6/6 分段 `pass-candidate`，整页 375 99.89% / 768 99.91% / 1440 100%，正式门禁 `passed silver`（验收视觉 3/3、结构 3/3、健康 12/12）。
- 交付包：`agent/deliver/home-20261030T173510Z-cbc82f/`（状态 passed）。
- Claude Desktop 界面 `heimdall_doctor` 9/9 通过（2026-10-31，操作者贴回结果）；配置与 stdio 也已验证。

## 2026-11-04 MCP 扩展与 QA CI

- `heimdall connect` 新增 Codex TOML 目标；Claude Desktop 的检测不再要求配置文件预先存在。
- MCP 新增 `heimdall_seo_audit`、`heimdall_seo_matrix`、`heimdall_site_watch`，并支持读取 SEO、监控和矩阵证据资源。
- 新增 `heimdall qa ci`：保留人工 QA 报告，同时输出机器可读门禁文件、GitHub Actions 注解和步骤摘要。
- 新增可复制的 GitHub Actions QA 模板和 Claude Code / Codex 标准工作流文档。

## 2026-11-12 公开案例摘要

- 新增只读 `heimdall_public_case_summary`，CLI、MCP、HTTP 共用同一能力定义。
- 它只读 `docs/cases/<case>/manifest.json` 和三份脱敏证据摘要，返回页面/视口覆盖、QA 门禁、基线回归、SEO 结果、已证明能力、未覆盖范围和一致性问题。
- Xspark 公开案例已加入 MCP 回归：5 个页面、10 次页面/视口检查、QA 门禁 `passed`、0 条可提单发现、SEO `90.8 / A`。
- 这仍是单个公开案例摘要，不代表任意站点的通用准确率；原始 findings、HAR、会话和 Token 不进入工具输出。

## 2026-11-11 GEO 行动计划

- SEO JSON 和 HTML 报告继续保留原有 GEO 分数与 `recommendations` 兼容字段，同时新增 `geo.actionPlan[]`。
- 每项 GEO 待办带优先级、严重度、影响页数、检查权重、脱敏证据、预计改动面和固定复测方式，Agent 摘要会显示前三项。
- 已用仓库内 Xspark 官网脱敏 SEO 证据做离线回归；这不是重新访问官网，也不改变 Xspark 原历史报告和检测器决策。

2026-11-12 修正 [GEO 证据完整性](audits/2026-11-12/geo-evidence-integrity.md)：GEO v3 排除失败页的内容整改，仅用首次导航响应核实初始 HTML，按适用检查权重区分完整、部分与不可用；站点评估不再把缺失或旧口径 GEO 判为就绪。三个公开站点、五页真实审计均保留了引用维度的未知项；本轮原始证据全部外置，旧报告保留且须重新审计。

随后升级到 GEO v4：Google 页面级索引与摘要限制和 canonical 分开核实，新增 `nosnippet` / `max-snippet:0` 证据并保持爬虫作用域。SEO 评分与采集口径均为 5，已有基线与趋势按版本隔离；缺少新字段的旧报告继续保留未知。三站五页真实复测、同批前后对照及本地故障注入通过，分数变化只代表方法调整；真实检索和模型引用效果仍未验证。详见同一报告的 v4 章节。

## 2026-11-11 B1 契约增强

2026-11-12 根据真实分页留出失败，补齐 `probe contract` 与 `probe adapter` 的公开只读查询许可：复用 `read-data-plan.json`，通过 `--include-readonly-data` 显式启用。商品和作品两组原件在实际 CLI 中由 B0 / 无法生成变为 B1 / 可生成，但各自留出仍失败，未宣称分页业务已实现。来源混杂、无效计划和带认证的公开候选继续拒绝，详见[真实 API 报告](audits/2026-11-12/backend-public-api.md)。

随后以三次训练和完整脱敏商品快照补写一个站点专用读取实现：相同六个留出上，观察回放为 0/6，补写后共享 B2 与独立逐值比较均为 6/6；Windows 和无外联 Linux 包独立运行通过。分页错位副本揭示结构检查边界，现已用显式 GET 查询响应断言贯通实际 QA CLI：真实数据加受控页面共 9 次调用，健康/修复通过，后端错位以未完成阻断，前端错位按实际损失触发门禁。每次只有一个后端 GET，报告不记录查询值；缺少 `loss` 的发现仍按既有政策降级。它仍只是公开读取案例，后端就绪保持人工审查；下一步接入更完整的交付旅程和其他真实业务。

- 显式使用 `--include-api-har` 或 `--include-api-bodies` 时，清洗 HAR 会为 API 请求保留请求体 Schema 和鉴权形态摘要；默认模式仍不扩大隐私范围。
- `api-contract.json` 与 `health.apiContract` 现在能告诉 AI 哪些端点观察到请求 Schema、出现过哪类鉴权，以及哪些结论仍未知。
- 请求值、认证值、响应示例、刷新规则、权限、状态机和真实副作用仍不会进入契约；当前仍是观察型 B1，不是后端替代。

## 2026-11-11 B2 最小验证环

- `heimdall probe adapter --site S --include-api-bodies` 会按端点做确定性训练/留出拆分：样本数至少 3 的端点保留至少 1 条留出样本，重复请求不算独立样本。
- 观察回放适配器只从训练集生成；适配器目录仍只含 `manifest.json` 和 `index.mjs`，验证结果写在上级的 `adapter-report.json`，不会破坏可部署适配器的两文件约束。
- `adapter-report.json` 对留出请求核对状态码、MIME、脱敏 JSON 形状和训练集中稳定字段，并单列未观察路径、未覆盖参数、样本不足和留出集为空。通过阈值为留出等价度至少 90%；没有留出样本时是 `not-validated`，不是通过。
- 该环只证明观察数据上的有限泛化，不证明认证、权限、状态机、业务规则、持久化或真实副作用。Xspark 试点目前只有脱敏 QA 聚合证据，没有可作为 API 留出样本的公开 HAR，因此不把 Xspark 的 38/71、2/4 统计硬塞进 B2 API 结论。

## 2026-11-11 站点评估包

- 新增只读 `heimdall_site_assessment`：一次返回镜像页数、多视口验证、SEO/GEO 摘要、公开 API 契约、适配器留出验证、可选 QA 最近运行、证据分类和下一步。
- 它只读取清洗后的公开报告与 manifest，不读取原始 HAR、登录档、操作计划或适配器源码；`verified`、`observed`、`inferred`、`unknown` 分开输出。
- 评估结果新增 `deliveryPlan`：按页面/资产、视觉验证、SEO/GEO、API 契约、B2 适配器、QA 检查点和认证/权限/状态未知项分组，给出 `capture`、`ai_review_with_open_actions`、`human_review` 或 `ready` 阶段；动作和复测条件都带安全属性，不把建议动作冒充已执行。
- 该能力是 AI 的导航层，不替代克隆、SEO、QA 或后端实现；没有镜像时总体状态仍是 `needs_capture`，适配器通过也只表示观察样本的有限验证。
- 修正站点评估的总体状态：`overall` 现在跟随 `deliveryPlan.decision.stage`，区分 `needs_capture`、`needs_human_review`、`ready_for_ai_review` 和 `ready`；新增 `readiness` 摘要，按 clone/SEO/GEO/backend/QA 给出状态、证据和下一步，避免“有一页镜像就看起来已经准备好”的误导。

## 2026-11-12 后端补全任务包

- `deliveryPlan.backendCompletion` 现在把 B1/B2 之间的下一步压成一个只读任务包：已观察端点、响应形状证据、认证/权限/状态/副作用未知项、需要人工授权的业务旅程、建议生成的本地文件、测试数据和验证命令。
- 端点和响应形状只来自清洗后的 `api-contract.json`；适配器留出验证通过时只标记回放证据，仍不声称真实后端等价。
- `inferred` 是 AI 可以据此起草的内容，`invented` 单独计数且当前为空；没有观察型契约时任务包明确为 `blocked_on_observation`，不会自动发明业务 API。
- MCP 提示词已要求 AI 同时读取 `deliveryPlan.backendCompletion`，继续沿用 `requiresHumanApproval` 和确定性复测边界；本轮没有新增独立 MCP 工具。

## 2026-11-12 适配器缺口账本

- 生成的观察回放适配器现在携带脱敏路由元数据；它能区分已声明路由、未覆盖查询参数和未观察查询变体，但不会保存查询值或请求体。
- 运行包含适配器的包时，未声明请求会按 `method + pathname + query parameter names` 聚合写入包外 `HEIMDALL_RUNTIME_DATA_DIR/adapter-gap-ledger.json`；重复请求只增加 `count`。
- `/__heimdall/adapter-gaps` 返回账本，`/__heimdall/health` 返回摘要；账本会给出最近似已知路由，并把缺响应体、未验证写入、认证/权限未知保留为未决项。
- `adapter-report.json.gapLedger` 记录训练/留出阶段的离线缺口；`heimdall_site_assessment` 读取它或同级 `adapter-gap-ledger.json`，把缺口变成 `api-adapter-gap-ledger` 待办。它仍不证明真实后端业务等价。

## 2026-11-12 B3 最小服务脚手架

- 新增 CLI-only 命令 heimdall backend scaffold <siteId> [--out D] [--force]；它不进入能力注册表，因此 MCP 工具仍保持 18 个。
- 生成物包括 package.json、server.mjs、checks.mjs、脱敏 api-contract.json、state-rules.json、Dockerfile 和人话 README；有合法 B2 适配器时只复制 runtime-adapter/manifest.json 与 index.mjs。
- 生成服务提供 GET /__heimdall/health、GET /__heimdall/contract 和 GET /__heimdall/adapter-gaps。没有适配器的已观察路由返回 501，避免把空壳误报成完成；适配器仍只是观察样本回放。
- `checks.mjs` 不再只看服务能否启动：会逐条检查观察路由覆盖、已观察状态码、MIME 和有限 JSON 字段结构，并读取运行时缺口账本；结果落盘为脚手架目录内的脱敏 `backend-check.json`。
- `backend-check.json` 的失败项现在附带 `repairTask`，并汇总为 `repairTasks`；任务区分路由缺失、响应契约、查询参数缺口和写入验证，不携带请求值。
- `heimdall_site_assessment` 会读取 `backend-check.json` 的安全摘要，把未运行、失败、未完成和通过分开返回，并把脱敏修复任务交给 `deliveryPlan.backendCompletion.repairTasks`；这仍不证明认证、权限、状态机或真实副作用。
- [公开 API 实测](audits/2026-11-12/backend-public-api.md)修复了必填 JSON 字段被小写化的误报，以及 `number` 放过非数值的漏报；健康→本地注入两类缺陷→恢复复验已跑通。原工作区移开时独立包仍通过检查，但一个接口的一次观察没有留出验证，后端业务等价仍未证明；旧包需要在新目录重新生成并迁移定制代码。
- 同轮远端 CI 暴露显示读取的两处原子发布竞态；已在共享读取器保留同次请求固定版本，Linux 35 项回归、双平台独立进程压力和真实控制台流程通过。原地篡改、托管记录与固定来源仍拒绝不一致事实，详见同一实测记录的“后续 CI 复验”。
- 后续用 DummyJSON 30 条商品和芝加哥艺术博物馆 12 条作品复测，修复可空、混合类型的契约丢失与健康响应误报；两个独立包通过，三类本地类型缺陷均检出。检查支持有限组合 schema，超深或分支超限拒绝生成；每接口只有一次响应，留出仍为 `not-validated`，详见同一实测记录的“后续真实接口”。
- state-rules.json 的认证、权限、状态机、持久化和副作用规则默认留空，invented 数量为 0；AI 或开发者必须在授权旅程后补规则，再用 npm run check 和既有验证套件复测。
- `heimdall_site_assessment` 现在会识别默认 `backend-scaffold` 是否已完整生成，并把缺失或半成品转成一个带人工确认边界的下一步动作，避免 AI 只看到抽象的建议文件。

## 2026-11-12 QA 实战指标总线

- 新增只读能力 `heimdall_qa_metrics`，CLI 别名为 `heimdall qa metrics`；它可读取脱敏聚合 JSON、单个 `run.json` 或 QA 工作区运行摘要。
- 结果统一给出复核报警、误报占比、经典 FPR 可用性、定向 oracle 漏报率、运行时长 p50/p95、失败分类和覆盖量；百分比从分子分母重算，不信任输入里的旧百分比。
- 定向 oracle 现在同时按 `family` 输出混淆矩阵和漏报率，AI 可以区分接口、权限、表单、安全或业务规则哪一类在漏报；缺失、`unknown`、`unclassified` 仍不能进入扩展决策。
- 经典 FPR 只有在正常样本穷举且有 TN 时才计算；没有这个条件就明确显示不可计算。Xspark 现有证据仍为误报占已复核报警 `38/71 = 53.52%`，定向漏报 `2/4 = 50%`，不是全站 FPR 或全站漏报率。
- `detectorExpansion` 复用冻结的保守决策规则，并自动暴露给 CLI、MCP 和 HTTP；当前 Xspark 离线重算仍是 `blocked`，下一步是补完整证据、压已有规则误报和增加业务检查点。
- `qa_metrics` 的定向 oracle 不再写死 Xspark 两类：只要样本声明了非空领域名，就可用于接口、权限、表单、安全或其他业务流程；通用检测器仍只在重复跨项目、完整测量和低误报证据下进入 `consider`。
- `heimdall_site_assessment` 会复用同一个指标内核，从匹配站点的脱敏 `run.json` 汇总 QA 覆盖、运行时长、失败分类和检测器决策；缺少报警标签或定向 oracle 时仍明确显示不可计算并保持 `collect-more-evidence`，不会改变既有 readiness 阶段。

## 2026-10-31 产品打磨

- `rebuild init` 不再固定抢 5199：不传 `--port` 时自动找空闲端口；显式传了而端口被占用则直接报错，不偷偷换。
- `compare` 的摘要第一屏直接给「首要差异」，例如 `fontSize 参考 52px / 候选 46px（-6）`，代理不必先翻修复包全文。
- AI 活动页新增「最近一次修复包」：显示最近一次**有差异**的区域与样式差；最新一次是干净收尾时，会同时标出「最新一次无差异」。
- `styleDiff` 兼容旧参考索引：缺逐边值时从 `padding/margin/border/gap` 简写推导，避免把「没记录」误报成 0。

## 2026-11-01 无参照物检测：QA 从“跑不通”扩到“跑得通但不对”

- `qa run` 默认在每个页面跑 23 个页面内检测器，分六类：无障碍（`alt`、可访问名、表单标签、重复 `id`、标题层级、`lang`、`iframe title`、`tabindex`）、布局（文字裁切、图片拉伸、点击目标过小）、内容（占位/调试文案、模板变量、乱码、无效值）、安全（混合内容、`_blank` 缺 `noopener`、http 表单、疑似密钥）、性能（LCP、CLS、过大图片）、可用性（白屏）。发现走同一套指纹、证据门槛、裁决记忆与 `bugs.md`。
- `qa run --explore` 显式开启有界交互探索：每页最多 6 个控件、60 秒预算，找“点击无反应 / 点出异常 / 点出 404”；跳过破坏性文案、表单提交、外链、下载，HTTP 请求按站点策略处理。方法和文案过滤不能保证操作没有副作用。默认关闭，因为它会改变页面状态。
- `qa baseline` 把一次运行登记为基线，之后每次运行对同站同页同视口截图做比对，低于阈值生成 `regression` 发现（附基线截图、本次截图、差异图）；`--no-baseline` 关闭。
- 固定注入基准 `node core/scripts/benchmark-qa.mjs`：21 个缺陷案例 + 3 个健康案例，最近一次 21/21 检出、0 误报，单页静态检测约 2.1 秒、含交互段约 11 秒。夹具与口径见[基准说明](competition/qa-detection-benchmark.md)。
- Xspark 真实试点已把失败分类、测量完整性和检测器扩展判断机器化：历史 20 次运行仍为冻结分母，补充复测存在不完整证据，当前先补证据、修现有规则和增加业务检查点，通用检测器扩展暂时阻断。详见 [试点报告](audits/2026-11-05/xspark-pilot.md)。
- 2026-11-12 Xspark 授权真实复测完成五入口、10 次完整运行：新基线后的官网/仪表板没有稳定可提单回归，两套后台重复出现已有无障碍名称问题；精确单页仍有受限出口阻断，D13 不计为通过。详见 [真实复测记录](audits/2026-11-12/xspark-live-recheck.md)。
- 2026-11-12 IANA 公开站点试点：真实 Chromium 完成 8 页、24 视口视觉验证；原候选包的严格离线交付仍被 2 个动态第三方脚本、2 个未解析资源、223 个未捕获链接引用和 8 页未执行浏览器离线探针阻断。详见 [试点记录](audits/2026-11-12/iana-public-pilot.md)。
- 2026-11-12 修正 strict 诊断流程后已在 IANA 副本复测：8/8 页浏览器探针执行、0 未测，补抓 jQuery 后 7 页通过、首页仍受 Google 搜索外联阻断；未捕获链接与跨域别名跳转门禁继续保留，严格离线交付仍未通过。
- 2026-11-13 在同批捕获的另一副本中补写了范围明确的 8 页本地全文搜索：新候选离线浏览器 8/8、声明旅程 7/7、接口检查 12/12 通过，搜索适配器 1/1 路由已执行。导出现在可在未捕获链接存在时继续诊断已知旅程；248 个缺失链接仍阻断严格发布，旧正式包保留。Google 排名与全站覆盖未验证，修改后交互镜像不沿用旧视觉结论。
- 本地搜索包随后完成 Windows/Linux 各 21 项 HTTP 检查，Linux 断外联；三视口实际 QA CI 21/21 通过。两轮布局迭代使像素相似度从 90.954%/92.331%/93.402% 提升到 99.842%/99.909%/99.946%，高度差清零；快速裁判仍为 near/bronze，未达 silver 或正式通过。源码 `c5059eaa` 的完整 CI 8/8 成功，独立运行、视觉及原采集哈希证据见同一试点记录。
- 每次完成 `live` 导出后会写脱敏 `live-export.json`，站点评估通过 `clone.delivery` 和 `readiness.delivery` 暴露最近结果、失败候选包引用及复测动作，视觉通过时也能看到离线失败。`last_check_passed` 只指上次完成的导出，输入改变后须重跑；旧记录缺失、非严格发布与无效记录均不推断严格通过。
- IANA 试点复盘后修复了健康扫描对 `&quot;` / `&amp;` 等 HTML 实体编码 CSS 引用的归一化；用原候选包离线复扫，8 页保持不变，`image001.png` 假缺口消失，未解析资源降为 1 条。该原候选包的 Google CSE 运行时脚本和未捕获页面仍阻断 strict，历史试点报告保留原始证据，不把这次复扫写成“已通过”。
- 验收子系统未改动：`FROZEN-VERIFIER.sha256` 的 14 个文件字节不变。
- 原 IANA 试点的 1,213 个文件、约 406 MiB 已迁到仓库外归档，逐文件哈希一致；同一实测报告保留历史位置和新的证据路径，工作树不再保存这批运行产物。

## 历史归档

- 逐日审计报告与证据：`docs/audits/README.md` 索引，原始文件在 `D:/Github-Star/heimdall-evidence-archive/2026-10-30/` 与 git 历史。
- 截至 2026-10-13 的开发记录、旧路线图、旧使用说明：`docs/archive/`。
