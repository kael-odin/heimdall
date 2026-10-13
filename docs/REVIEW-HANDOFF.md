# REVIEW-HANDOFF · 下一轮该动哪里

> 这份文件是**给下一轮接手的人（或 AI）看的**，不是历史记录。
> 它回答两个问题：**哪里的代码最值得优化**、**哪里的能力最需要提升**。
> 每一条都尽量带上「在哪一行 / 怎么证实的 / 改了会怎样 / 风险」，而不是形容词。
>
> 上一轮（2026-10-13）已经做掉的，见文末「已做」与 [../HANDOFF.md](../HANDOFF.md) §38。
> 还没做的待办在 [ROADMAP.md](ROADMAP.md)；这份文件比它更细，且**带证据**。

---

## 0. 先读这三段，能省你半天

1. **这个仓库的纪律是「先证明，再改」**。每条修法都先写一个会失败的断言（红线），
   改完变绿，再把旧写法注回去确认它**真的会红**。看 `core/test/` 里任何一条带
   "实测过" 注释的用例都是这个形状。**没有测试的改动，在这里不算改完。**
2. **报告上的数字必须与产物是一回事**。这个项目里最有价值的一类修复，
   都是"某个自检在撒谎"或"某个缺口没被算进去"。下面 A/B 两节里过半的条目是这一类。
3. **不要为了整齐去重构**。`engine-server.mjs` 1594 行、`Atlas.vue` 1996 行都不算问题；
   仓库里已经权衡过两次"抽出 25 个 prop 比留在原地更糟"。**下面每一条我都标了"该做/不该做"。**

复现基线（2026-10-13 实测）：`pnpm -C core lint` 170 文件 OK ·
`pnpm -C core test` **506 通过 / 0 失败 / 0 跳过**（约 50s）·
`pnpm -C core smoke` 离线 E2E 通过（visual 100.0% / dom 100.0%）· `pnpm -C console build` 通过。

---

## A. 代码：最值得优化的地方

按「证据强度 × 影响面 ÷ 风险」排。**A1–A6 是我建议优先看的**。

### A1 · 资源引用重写仍是"字符串替换"，属性级还有三处会咬人
`core/src/crawler/build_clone.mjs:273-307`、`core/src/crawler/linker.mjs:175-200`

本轮已经修掉最险的一层：整表替换改成**单次扫描 + 长键优先**
（`dom-refs.replaceRefTable`，见 §C1）。但同一段代码里还有三处更细的：

- **`srcset` 用逗号切分**。`data:image/svg+xml,…` 这个值**自己带逗号**，
  于是被切成假 URL 段。收集端（`capture.mjs:328`）和重写端（`build_clone.mjs:280`）
  用的是同一套切法 —— 同一个错误被写了两遍。
- **属性重写只匹配双引号**（`/\b(src|srcset|href|data|poster|content)="([^"]*)"/g`）。
  单引号属性、无引号属性一律漏过。
- **`<use xlink:href>` 单独走一条正则**，`poster`/`data-*` 各走各的。

**建议**：合成一个"属性级重写器"，一次遍历 `src / srcset / poster / href / data-* / <use>`，
`srcset` 按 `,\s+(?=\S)` 分词并跳过 `data:` 段。`parse5` 已经在依赖里
（`differ/domdiff.mjs` 在用），也可以直接上 DOM。
**风险**：中。这是每页每次构建都走的路径，改完必须重跑 `pnpm smoke` 与一个真实站点。

### A2 · 像素分没扣掉"动态掩码"，但对外宣称扣了
`core/src/differ/diff.mjs:59-99` vs `core/src/deliver.mjs:284`

`diff.mjs` 已经能算出 `dynamic` 掩码（多帧之间的差异像素集合），但
`pixel = 1 - best/total` 的分母用的是**整张图**，掩码只用于"差异形态"的判定。
而交付包里写着"多帧最优匹配，**动画噪声已排除**"。
两句话不是一回事：一个每秒都在动的区域，即使每帧都匹配上了，仍然会压低像素分。

**两种改法，选一个，别都放着**：① 从 `best` 和 `total` 里都扣掉掩码像素（口径追上文案）；
② 文案改成"动画区域按多帧最优匹配计入"。①会让全语料的分数上升 —— 那意味着
**已有的 `score.json` 需要重跑**，属于"改数字"而不是"改产物"，要单独一批做。
**风险**：高（影响全量历史读数）。所以它排在"A1 之后、但值得单开一轮"。

### A3 · 数据维度"抽不到东西"时给满分
`core/src/harvest/harvest.mjs:129` — `const data = present.length ? … : 1;`

页面上一条 meta/heading/price/cta/link/table 都没抽到时（纯 JS 注入、或结构罕见），
`present` 为空 → `data` 直接取 **1.0**，然后 `diff.mjs:99` 按 `0.2 × data` 计入总分。
**一页"没测到"被记成了"测得完美"** —— 这与仓库里已经修过的三条
（HAR 覆盖率把 404 算成离线可用、verify 给测不到的页打 0 分、回收自检 fail-open）
是同一类错误，只是还没轮到这里。

**建议**：`present.length === 0` 时返回 `null`，`diff.mjs` 按"该维度不参与"重新归一
（`total = (0.5·pixel + 0.3·dom) / 0.8`），并在 `score.json` 里写明 `data: null, reason: 'no extractable data'`。
**风险**：中（会同时抬高一部分页的分数，但方向是"更诚实"）。

### A4 · 一个页面上"是静态资源吗"有三份互相不同的判据
- `live/heal.mjs:54` `isStaticAsset` —— 看 MIME + 扩展名兜底
- `live/health.mjs:21` `ASSET_EXT` + `ASSET_REL`
- `crawler/capture.mjs:532` `SKIP_KINDS`

后果很直接：**离线本地化用一个判据，校验它健不健康的用另一个**。
"本地化了但 health 不认"或反之，都会表现成一句含糊的结论。
**建议**：`isStaticAsset` 胜出，另外两处改成调它。
**风险**：低。三处都有测试（`live-health.test.mjs`、`dom-refs.test.mjs`）。

### A5 · `engine-server.mjs`：抽两层就够，**别动任务核心**
1594 行、~45 条路由。本轮已经把 13 份"读 body + try/catch JSON.parse"收成 `readJsonBody`（§C2）。
剩下的两处抽取**是纯收益**：

| 抽什么 | 大致行数 | 为什么安全 |
| --- | --- | --- |
| 静态/代理/镜像服务（`sendFile`/`serveMirror`/`/px/`/`/lm/`/`/static/`/SPA 回退） | ~280 | 纯函数，不碰 `tasks`，只依赖 `isProxyHost` |
| workspace 索引读取 + 缓存（`cached`/`assetIndex`/`countLivePages`/`isProxyHost`） | ~200 | 它们共享同一个"8s TTL + 任务结束时失效"契约，本来就该在一起 |

**不要做的**：把 13 个 `runningX` 单例和 `makeTask`/`spawnTask`/槽位记账拆散。
那段耦合是**承重的** —— 仓库里 `forge-slots.mjs` 的注释记着，上一版正是因为
"归还一个没占过的槽"让并发上限静默失效。拆开就等着重犯。
**风险**：抽取中等、拆核心高。做完之后主文件落在 700–800 行，对"HTTP 服务 + 编排器"是合理的。

### A6 · `console/src/Atlas.vue` 1996 行：只有两个抽取值得做
| 候选 | 需要多少 prop/emit | 结论 |
| --- | --- | --- |
| `useEngineTask()`：12 个 SSE 任务处理器（约 300+ 行几乎逐字重复：建任务 → 限 20 条 → 发 POST → `EventSource` → 解析 → `exit` 收尾） | 0 / 0（是 composable，不是组件） | **做**。全仓库最大的一处重复，且没有 prop 代价 |
| `useLlmForm()`：LLM 表单状态（`Atlas.vue:94-110, 935-987`） | 0 / 0 | **做**。它是拆设置页的前置条件 |
| 报告页各张卡片（改站起点 / 分数走势 / 全站体检…） | 每张 3–10 props | 值得，**一张一张来** |
| `ReportsView` 整段（`Atlas.vue:1650-1861`） | **35+** | **别做** |
| `SettingsView` 整段（`Atlas.vue:1863-1967`） | 25 props / 11 emits | **别做**（除非先有 `useLlmForm`） |

顺带：`api.js` 里的 `apiFetch/apiJson/apiPost` 从来没被调用过，本轮已删（§C5）。
剩下的小重复：`typeColorThemed` 三份（`Atlas.vue:46`、`DetailDock.vue:120`、`PagesView.vue:34`）、
时长格式化三份（`ActivityRail` / `DetailDock` / `format.js`）、`JobsView.vue:35` 又写了一份日期格式化。

### A7 · 三个"没接线的能力"（不是 bug，但是演示时的机会）
`core/src/engine-server.mjs` 里有三条路由**没有任何调用方**（全仓库 grep 证实）：
`GET /api/llm/status`（:724，控制台走的是 `/api/settings/llm`）、
`POST /api/jobs/:id/cancel`（:793）、`DELETE /api/session/:host`（:987）。

第三条尤其可惜：**"登错了想清掉登录态"目前只能去删 `workspace/<host>/session.json`**。
引擎侧能力现成，缺的只是控制台上一个按钮。前两条可以先删（留着一份"看起来该用"的死入口更误导）。

### A8 · 同步 IO 仍在请求线程上
- `GET /api/pages/:host`（`engine-server.mjs:1071`）：**没有缓存**，每页 4 次
  `readFileSync` + `JSON.parse` + 1 次 `statSync`，N 页就是 ~5N 次同步调用，控制台每次刷新都打。
- `assetIndex()`（:645）已有 8s TTL，但**首次**仍会占住事件循环一两秒（200.19 万条上限的递归 walk）。
- `push()`（:363）每条事件一次同步 SQLite 写 —— 子进程每行输出都会走到。
- `/api/history/:host`（:1126）最多 31 次同步 DB 查询。

**建议**：`/api/pages` 挂到同一套 `cached()` 上（它已经被任务结束时的 `bustCaches()` 覆盖）；
其余保持观察，别提前优化。

### A9 · 大模块零覆盖（先补测试，再改行为）
`seo/collect.mjs`(340 行)、`live/export.mjs`(331)、`queue.mjs`(269)、
`verify/verify.mjs`、`watch/watch.mjs`、`session/login.mjs` —— 这几个**一条单测都没有**，
而它们都是"产出用户直接看到的东西"的模块。`live/export.mjs` 尤其值得：
交付包是最终交付物，现在只能靠 `pnpm smoke` 那条路径覆盖。

### A10 · 两条会"静默漏掉"的守卫
- `core/test/seo-rule-count.test.mjs:56` 与 `core/test/bundle-selfcontained.test.mjs:33`
  都有 `if (!existsSync(f)) continue` —— 文件被改名/挪走时，守卫**悄悄不检查它**，照样绿。
  建议改成"列出来的每个文件都必须存在，缺了就失败"。
- **仍然偶发**：全量测试在忙机器上曾出现一次 `pass 500 / fail 1`，之后六次重跑全绿，
  现场没留下 —— 至今不知道是哪条。已加固（真空闲端口、30s 就绪预算、失败时把断言/页面异常/引擎日志/截图落盘到
  `core/workspace/_e2e-failure.*`），但**没有**声称修好。下次再遇到，先看那份现场。

### A11 · 性能上的三处"顺手就能拿"
- `live/heal.mjs:300`：**每个 key × 每个文件**都新建两个 `RegExp` —— 改成循环外编译一次。
- `live/export.mjs:131-193`：整份 HAR 读进内存再 `JSON.stringify` 合并；
  单页 `content:'embed'` 的 HAR 可以到几百 MB，多页导出是真实的 OOM 峰值。
- `crawler/capture.mjs:540`：资产**串行**下载（注释说是有意为之，为了心跳）。
  一个 40 张图的页面就是 40 次串行往返 —— 值得做个"小并发 + 保心跳"的折中。

---

## B. 能力：最需要提升的地方

按"用户能多明显地看出差别"排。

### B1 · 保真度只测首屏 —— 这是最大的一条
`core/src/crawler/shot_clone.mjs:19`：视口 `1440×900`，**没有 `fullPage`**；
`differ/diff.mjs:40` 用它算 `total = W·H`。
于是**一个长营销页下面 80% 坏掉，分数照样接近满分**。
讽刺的是 capture 阶段其实已经抓了 `shot-src-full.png`（`capture.mjs:452`，给对比视图用）。

**建议**：把长页拆成"首屏 + 若干纵向带"分别评分，总分按面积加权；
或者直接 `fullPage: true` 再把总像素量归一。**这是唯一一条会改变所有历史分数的能力项**，
要么一次做完并全量重跑，要么先只加一个"首屏分"之外的"全页分"并列显示（后者风险小得多，建议先做后者）。

### B2 · 三条"是 JS 依赖，但只有两条被上报"
仓库已经诚实处理了 WebGL 画布（`countOpaquePng` 自证非空图）与
`<mux-player>` 这类媒体组件（读 `poster` 换成 `<img>`，并在 `clone-gaps.json` 里记 `mediaPosterized`）。
**没被同等对待的是 Framer 的 SSR 变体块**（`framer.com/design`）：
整块作品轮播是黑的，58 张图全都在 DOM 里、也都本地化了 —— 只是"按视口显哪一份"是 JS 加类决定的。
这里的问题不是"没做到"，而是**它会让 `domdiff` 的结构/类名分偏高**（隐藏变体还留在 DOM 里），
而 `gaps.json` 里没有对应类别。至少要像媒体组件那样**上报**。

### B3 · 跨域 CSS `@import` 不递归
`core/src/css-refs.mjs:19` 的 `scanCssRefs` 只匹配 `url(`；
裸字符串写法 `@import "x.css";` 收不到（而 `health.mjs`、`audit/assets.mjs`、
`repair-css-refs.mjs` 各自带一份 `@import` 正则 —— 又一处重复）。
捕获回来的跨域表里如果还有 `@import`，也不会接着抓。
实测 linear/framer/vercel 都没命中，**换个站可能会**。

### B4 · 软 404 判据只看 `text/html`
`core/src/asset-ext.mjs:101` `isSoftHtml` 只在响应 MIME 是 `text/html` 且 URL 不以 `.html` 结尾时成立。
SPA/边缘节点对不存在的资源返回 `application/json` 或 `text/plain` 外壳时，
**会被当成真资产写盘，并计入"已本地化"**。判据应该看"内容是不是那个站的外壳"，
而不是看 content-type。

### B5 · 站点群还没有门户（开了没做）
单个交付包是自包含的（零依赖 `serve.mjs` + Dockerfile + compose），
但 `heimdall-live.json` 里只有**一个** `host`，`rewriteHtml` 只重写 `https://<host>/`，
`root: mirror` 又占住 `/`。所以"一台机器同时起 N 个站"目前只能一端口一站或上反向代理。
**要补的其实很小**：路由本来就是 `/lm/<host>/…` 的形状，
让一个 `serve.mjs` 认多 host + 加一个列出所有站的门户页即可。

### B6 · 交付包"可改"程度
资源清单 / 域名替换 / 文案清单都已就位，还差**"就近打开资源"**与**"替换后自检"**。
（"就近打开"在控制台侧已经有了 `revealPath`，交付包里没有对等物。）

### B7 · 已知且已诚实上报的边界（不用再花力气"做出来"）
离线包无法伪造跨域 **API 数据**（HAR 回放只覆盖走 `serve.mjs` 的同源那部分）、
第三方嵌入（YouTube / 地图 / 统计）抓不回来、动效相位（JS 驱动的 WebGL 场景两边都冻不住）。
这些在 `gaps.json` / `health.json` / landing 页里都写清楚了。
**它们的价值在于"说清楚"，不在于"变没"** —— 别把预算花在这里。

> ⚠️ 这一条原先还把"**动效**"整个算了进来，那是错的。2026-10-13 已经证明：
> 揭示类与脚本用 `Element.animate()` 创建的动画**可以**改写回 CSS 复刻（见 §C12）。
> 真正做不了的只有"只在运行时才存在"的那部分 —— 等双帧捕获做出来再说。
> **别把"没做"和"做不到"混成一句话**，这是这份文件里最容易犯的错。

---

## C. 2026-10-13 这一轮改了什么

每条都有对应测试或实测证据。

| # | 改了什么 | 在哪 | 证据 |
| --- | --- | --- | --- |
| C1 | 资源引用整表替换改成**单次扫描 + 长键优先**（前缀、重扫、N 次全文扫描三个问题一起解决） | `dom-refs.replaceRefTable`；`build_clone.mjs`、`linker.mjs` 改调它 | `dom-refs.test.mjs` 3 条；其中一条把旧写法注回去证明**真的会改错**（`.../a.png?v=2` → `assets/a.png?v=2`，静态服务忽略查询串 → 静默拿到另一个文件的字节） |
| C2 | 13 个启动路由的请求体读取收成 `readJsonBody`，**自带 64KB 上限** | `engine-server.mjs` | 原来 13 份 `req.on('data')` 无上限；全局 Content-Length 检查挡不住分块传输。`pnpm smoke` + 全量测试通过 |
| C3 | SSE 推送逐个订阅者 `try`（一个断开的标签页不再能带走整个引擎进程） | `engine-server.mjs` `writeSubs` | 原来 3 处裸循环，其中一处在子进程 `exit` 回调里 = 未捕获异常 |
| C4 | 任务/事件表的**保留策略**（默认 500 条，随任务结束裁剪 + 启动时裁一次） | `jobs/store.mjs` `prune()` | 两张表原先只增不删（本机实测 241 任务 / 6836 事件 / 1.4MB）。`jobs.test.mjs` 新增 2 条（sqlite 与 json 各一），并钉住"事件必须跟着任务一起走" |
| C5 | 删死代码：`api.js` 的 `apiFetch/apiJson/apiPost`、`types.js` 的 `FALLBACK_COLOR`、`PagesView` 声明了却没人发的 `audit` 事件 | `console/src/` | 全仓库 grep 无调用方 |
| C6 | 修 `PagesView` 的 `defineEmits` **漏声明 `action`**（模板里在发、声明里没有，只在 dev 里 warn） | `console/src/PagesView.vue` | 与"漏一项就静默"同一类 |
| C7 | 左下角两个浮层**不再互相覆盖**：`.panel` 与 `.task-center` 收进同一个列容器 `.bottom-left` | `ui.css` + `Atlas.vue` | 实测：注入同形任务中心后 `overlap: false`，间距 10px；1440 与窄屏都不叠（原来任务中心更宽 + z-index 更高，盖住面板的「星图自转」勾选框） |
| C8 | `SiteBar` / `Sparkline` / `.trend-hint` 里 **两个在 v3 已经不存在的 token**（`--muted`、`--cyan-line`）换成真 token，裸 hex/rgba 一并清掉 | `SiteBar.vue`、`Sparkline.vue`、`ui.css` | undefined 的 `var()` 会整条声明失效 → 颜色退回**继承色**、边框退回 `currentColor`。实测改后标签色 = `--text-dim`、边框 = `--border`、底色 = `--surface-2`（浅色主题一并验过） |
| C9 | 星图**自转默认值跟随 `prefers-reduced-motion`**；切到别的视图时**不再空转渲染** | `Atlas.vue`、`Graph3D.vue`（新增 `active` prop） | Graph3D 用 `v-show` 挂载、`spin()` 是常驻 rAF 且每帧自己 `renderer.render()` —— 页面/任务/报告/设置四屏背后一直有个看不见的 WebGL 场景满帧重绘。实测 reduced-motion 下勾选框默认不勾 |
| C10 | 清掉两个从不 `clearInterval` 的常驻定时器 + `Graph3D` 两个 prop 的注释 | `Atlas.vue` `onBeforeUnmount` | 零成本 |
| C11 | `replace-regex` 的四份重复收成 `html.regexEscape`（与 `esc` 分开命名：一个 HTML 语义、一个正则语义） | `html.mjs`；`heal.mjs`、`replace-domain.mjs`、`dom-refs.mjs` | 原来两处**同名 `esc`** 做的是正则转义 |
| C12 | **JS 动效能在静态镜像里复刻**（这是本轮能力提升最大的一条，详见 `ROADMAP.md` §3）：新增 `crawler/motion-replay.mjs`；`motion.mjs` 的 `MOTION_INIT` 扩展成记录 `Element.animate()` 的**关键帧** | `motion-replay.mjs`（新）、`motion.mjs`、`pipeline.mjs`、`cli.mjs`、`deliver.mjs` | 浏览器实测：Framer 登场 72 个元素不透明度 0.00 → 0.735 → 0.972 → 1.000；linear.app/agents 的脚本入场动效 21 条动画在跑、标题 0.00 → 0.07 → 0.80 → 1.00。**分数不受影响**（同页注入前后 total/pixel/data 完全一致） |

**文档**：`ARCHITECTURE.md` §5 整段重写（上一版描述的 `core/` TypeScript、`core/adapters/*.ts`、
`console/src/views/*.vue`、`engine/SKILL.md`、顶层 `mcp/` **五个路径一个都不存在**），
§2 适配器、§8 的"3D 待决策 / MCP 后补"、端口表一并改正，并在文首标明本文偏历史、以 README 与 `docs/guide/` 为准；
README / `docs/guide/` 的模块数（91→99）、组件数（10→11）、测试条数（385→不写死，给命令）、
`pnpm lint` 的覆盖范围、USAGE 的 MCP 工具数（12→13，补 `heimdall_assets`）、
`docs/DELIVERY.md` 里那个**根本不存在的 `heimdall login` 命令**，全部改正。

---

## D. 我**故意没动**的（以及为什么）

- **不改评分公式本身**（A2 / B1）。它们会改变全语料的历史读数，必须和"重跑 290 页"绑定成一批做，
  而不是顺手改一行。本轮只把证据写清楚。
- **不拆 `engine-server.mjs` 的任务核心**（A5）。耦合是承重的，拆开重犯已修过的槽位记账 bug。
- **不整段抽 `ReportsView` / `SettingsView`**（A6）。35+ props 比留在原地糟，仓库自己已经论证过一次。
- **不删那三条死路由里的 `DELETE /api/session/:host`**（A7）。它是**能用但没接线**的能力，
  删掉是把"缺个按钮"变成"缺个功能"。
- **不去"解决"离线包的固有边界**（B7）。已诚实上报，收益在说明而不在实现。

---

## E. 怎么验证（改之前先跑一遍，留个基线）

```bash
pnpm -C core lint            # 语法，170 个文件
pnpm -C core test            # 全量单测 + 真浏览器 + 控制台 E2E（约 50s）
pnpm -C core smoke           # 离线 E2E：起真 fixture + 真引擎，跑完整流水线
pnpm -C console build
```

**只看一眼复刻效果**（不启动引擎）：

```bash
node core/src/cli.mjs forge https://example.com home
```

**要跑真实站点验证保真度**：

```bash
node core/src/cli.mjs queue <host> --max 20 --incremental
node core/src/cli.mjs verify <host> --all
```

**改动前请先做这件事**：把要改的那条判据写成一个**会失败的断言**。
这个仓库里最贵的 bug 全都长一个样子 —— **它不报错，只是给出一个看起来正常的错数字**。
