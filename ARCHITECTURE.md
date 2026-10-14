# ARCHITECTURE · 技术架构与里程碑

> **这份文件偏历史。** 它记的是 2026-09 立项时的设想，以及 W0–W6 的"设计与实现的偏差"。
> 想了解**现在**的架构，读 [README.md](README.md) 与 [docs/guide/01-architecture.md](docs/guide/01-architecture.md)
> —— 那两份是对着代码维护的，冲突时以它们为准。
> 下面 §2 与 §5 曾经整段描述不存在的文件（TypeScript 版 core、`core/adapters/*.ts`、
> `console/src/views/`、`engine/SKILL.md`），已按现状改正（2026-10-13）。

---

## 1. 三层架构

```
┌────────────────────────────────────────────────────────┐
│ Console 控制台                                          │
│   Vue 3 + Vite + 3d-force-graph(three) + SSE            │
│   星图 / 施工舱 / 还原度报告 / 剧场模式                    │  ← 同事看到的全部
├────────────────────────────────────────────────────────┤
│ Engine 引擎层                                           │
│   任务队列 · 事件总线 · SSE 推送 · 产物仓库管理            │
│   （原设想的 ZCode + SKILL.md 编排没有落地：             │
│     编排是确定性代码 pipeline.mjs，不需要 agent 循环）    │
├────────────────────────────────────────────────────────┤
│ Core 工具链（确定性代码，核心壁垒，无 LLM 依赖）             │
│   crawler  — sitemap+BFS 路由发现 / Playwright 渲染后     │
│              DOM+CSS chunk+资产+双截图 归档               │
│   builder  — DOM+CSS → 可跑镜像页（build_clone.mjs；没有 gen-page.mjs）
│              栈适配器：nextjs / vue-vite                  │
│   differ   — pixelmatch + DOM diff + 三维评分             │
│   harvest  — LLM 结构化抽取（定价/功能/文案 → Excel+JSON） │
└────────────────────────────────────────────────────────┘
```

**核心判断：壁垒在 Core，不在 Engine。** agent 编排是个 while 循环，谁做都行；
爬取/生成/打分这三件确定性工具才是别人没有的。Engine 比赛期用 ZCode+skill 起步（一天搭好），
赛后原样迁 DSH —— 编排层是可替换插件，产品永远不绑定单一 agent 运行时。

**LLM 只出现在三个点位**（其余全部确定性代码）：
1. 页面语义分类与组件 schema（星图打标 + builder 规格）
2. L3 动效重写（原站闭源 JS → 新代码）
3. diff 修复循环（differ 报差异 → LLM 改代码 → 重跑，≤3 轮）

---

## 2. 栈适配器设计（"apify 成功≠别的成功"的架构解法）

```
core/src/adapters/index.mjs   # 三个适配器放在同一个文件里（都只是字符串规则，不值得拆三个模块）
  nextjs     # apify 路线：_next/static/chunks 提取，Turbopack 命名兼容
  vueVite    # thordata 路线：data-v 作用域清理 + 按页 chunk 注入（suixiang-clone 原方法）
  generic    # 未知栈的降级：渲染后 DOM + 计算样式
```

- 侦察时探测框架签名（`__NEXT_DATA__` / `data-v-*` / `/src/*.js`）自动路由适配器
- 未知栈 → 尝试通用降级（渲染后 DOM + 计算样式内联），标记"低可信"
- **已实测**（2026-09-29）：apify.com / thordata.com / dataify.com 首页均 200 直爬、SSR 完整 HTML、无硬 WAF

---

## 3. 数据流与产物规范

```
URL ──▶ enqueue ──▶ recon(sitemap+BFS, 限深2/限速1req/s)
    ──▶ atlas.json {nodes:[{url,type,assets,score,thumb}], edges[]}
    ──▶ 用户选页 ──▶ forge per-page:
         capture → extract → build → diff(loop≤3) → 产物落盘
    ──▶ harvest(LLM 抽取) ──▶ intel.xlsx / intel.json / report.html
```

```
workspace/apify.com/
  atlas.json
  pages/home/
    dom.html  styles/  assets/
    shot-src.png  shot-clone.png  diff.png
    score.json        # {pixel:0.987, dom:0.97, data:0.99, total:98.5, grade:"A"}
    clone/            # 可独立打开的镜像页
  intel/pricing.{xlsx,json}
  report.html         # 离线总报告，双击即看
```

### 两种镜像：静态镜像 vs 交互镜像

单页还原产出**两种**形态，用途不同，别混用（旧称"死镜像 / 活镜像"，2026-10-11 起改用下表的正式名）：

| | **静态镜像**（Static Mirror） | **交互镜像**（Live Mirror） |
| --- | --- | --- |
| 是什么 | 渲染结果冻结成的静态文件 | 页面照常运行脚本，资源与请求实时回原站 |
| 脚本 | **全部剥离** | 保留（第三方挂件被 stub） |
| 资源 | 尽量本地化 CSS/图片/字体；实际缺口需核对 | 本地快照优先，缺失时通过镜像域或 `/lm/` 回源 |
| 样式来源 | **CSSOM 最终态**（含脚本注入的样式） | 原站自己的 CSS |
| 网络 | 页面文件本地可开；资源是否齐全要看缺口检查与断网验收 | 通常需要引擎在线和原站可达；独立包可对已收录资源做 HAR 回放 |
| 视觉 | 多视口比较并记录尺寸、覆盖率与差异 | 未校准，会随原站当前内容变化 |
| 交互 | 原站 JS 行为不保留；普通链接仍可导航 | 保留脚本，但表单/API/客户端路由须逐站验收 |
| 强项 | 为前端提供可核对的冻结视觉基线与改站素材 | 分析获授权站点的当前行为与真实数据 |
| 弱项 | 动态内容定格；资源缺口会影响离线结果 | 视觉随原站漂移，认证和离线能力有条件限制 |

**一句话记法**：静态镜像是可比较的冻结页面，交互镜像保留脚本并可回源。两者都要根据页面覆盖率、资源缺口和实际浏览结果验收。

**两种都只是单页产物，"交给同事"的是第三种东西**：`node src/live/export.mjs <host>`
产出的**交付包（Deliverable Bundle）** —— 自包含目录（零依赖 serve.mjs + 静态镜像页
+ 交互镜像页 + HAR 回放 + Dockerfile/compose + checksums），
`DATA_ROOT/deliverable/<host>-live-<date>/`。**再克隆几页后重新导出即可**，
包里就是全量；它不依赖本机引擎，也不需要 `*.localhost`。

**两个入口**：交互镜像可以用两种地址打开，服务的是同一份产物。

| 入口 | 形如 | 何时用 |
| --- | --- | --- |
| 独立域名 | `http://<host>.localhost:<port>/<path>` | **首选**。pathname 就是站点自己的路径，CSR 路由、cookie、localStorage 全按站点隔离 |
| 路径前缀 | `/lm/<host>/<path>` | 备用。不依赖 `*.localhost` 解析，但前缀会进 `location.pathname` |

**为什么要两个**：纯客户端渲染（SPA/CSR）站点的路由库读 `location.pathname` 决定渲染什么。
前缀入口下它看到 `/lm/vitest.dev/`，匹配不到路由，于是渲染**它自己的 404 页**（实测
vitest.dev / crawlee.dev / ant.design 均如此）。独立域名入口没有这个前缀，问题不存在。
它依赖 `*.localhost` 解析到本机 —— Chrome/Firefox 原生支持，但本机 DNS 被代理接管时
可能失败，那时用前缀入口。

设置 `HEIMDALL_TOKEN` 后，控制台先在引擎主机上申请短期、单次使用的票据，再进入独立镜像子域建立该子域的会话；控制台和 API 主机名不同时通过请求头领票。票据兑换后立即跳到不含票据的原站路径，避免 SPA 把 `/lm/` 当作路由。`/lm/` 仍是备用入口，不能据此承诺所有 SPA 正常运行。

**代理层的硬约束**：转发上游响应头必须落到**普通对象**再 `writeHead`
（`src/proxy-headers.mjs`）。Node 的 `writeHead` 收 WHATWG `Headers` 不报错、
状态码也对，但头会被**全部丢掉** —— 曾经因此让交互镜像的模块脚本以
`MIME type of ""` 被浏览器拒绝执行，也就是"交互镜像的 JS 从来没跑起来过"。
测试见 `test/proxy-headers.test.mjs`（含一条断言 Node 该行为的前提测试）。

---

## 4. 还原度公式实现

```
total = 0.5 × pixel  (pixelmatch, 1440×900, 同视口/同字体等待策略)
      + 0.3 × dom    (节点树匹配率 + 类名 Jaccard)
      + 0.2 × data   (LLM 抽取字段 ÷ 原页可抽取字段)
grade: A ≥95 / B ≥85 / C <85
```

- 双截图纪律：原站截图与克隆截图**同浏览器同视口同等待**，杜绝环境噪声
- diff 循环每轮产出 diff.png + 分数曲线，进报告也进施工舱动画

---

### 诊断脚本（`core/scripts/`）

排查"克隆结果不对"时用的工具。都不是主流程的一部分，但每次排查都要用：

| 命令 | 回答什么问题 |
| --- | --- |
| `pnpm -C core probe:render <url...>` | 这个站的内容依赖 JS 吗？（服务端 HTML vs 渲染后的词数/资源对比） |
| `pnpm -C core probe:fingerprint <url...>` | 这个站能不能用增量重克隆？（服务端 HTML 是空壳还是有正文） |
| `pnpm -C core probe:regions <原站图> <镜像图>` | 差异落在页面的哪些纵向带？（上/中/下哪一段） |
| `pnpm -C core probe:shift <原站图> <镜像图>` | 差异是不是整体位移造成的？（平移后差异是否显著下降） |

> 「差异是集中的一块（内容缺失）还是碎成几千点（渲染差异）」不再需要手动跑脚本 ——
> 这条判据已经在流水线里自动计算并显示在报告的「差异形态」里（见 `differ/shape.mjs`）。

**排查顺序建议**：先看报告里的差异形态 → 集中就用 `probe:regions` 定位是哪一段；
弥散就 `probe:shift` 排除位移、再查字体与渲染环境。

## 5. 仓库结构

> 2026-10-13 按现状重写。上一版描述的 `core/`（TypeScript）、`core/adapters/*.ts`、
> `console/src/views/*.vue`、`engine/SKILL.md`、顶层 `mcp/` **都不存在** —— 那五个路径
> 是立项时的设想，后来一条都没落地。README 里那份是对的，这里原本不是。

```
heimdall/
  core/                     # 纯 ESM（.mjs），无 TypeScript；pnpm + Playwright
    src/
      crawler/              # capture / build_clone / linker / recon / multi-snapshot / repair-*
      seo/                  # 66 条规则、采集、报告、回归基线、分页、结构化数据
      live/                 # 交互镜像：export / heal / health / serve / har
      differ/               # 像素与 DOM 差异、差异形态判定、AI 校准循环
      verify/               # 多视口验证、交互回放
      audit/                # 资产、存储、交付包治理、孤儿回收
      deliver/              # 改站起点清单、域名替换
      extract/  store/  watch/  sandbox/  mcp/  browser/  session/  jobs/
      engine-server.mjs     # 唯一的常驻进程（HTTP + SSE + 队列 + 槽位）
      cli.mjs               # 统一命令入口（`pnpm -C core cli`）
    sites/                  # 人工整理的站点配方（进 git）
    workspace/              # 产物仓库（gitignore）
    test/                   # node --test；含真浏览器与控制台 E2E
  console/                  # Vue 3 + Vite（不是 Tailwind）；组件平铺在 src/，没有 views/
    src/{Atlas,DetailDock,PagesView,JobsView,AssetTable,SiteBar,Graph3D,
         ActivityRail,Sparkline,StorageCard,Icon}.vue
    src/{api,format,tasks,pages,types,main}.js · ui.css · style.css
  config/                   # SEO 门禁的目标站点与基线（进 git）
  docs/                     # ROADMAP / DELIVERY / guide（上手导览）
  .github/workflows/        # ci.yml（确定性）· seo-gate.yml（联网，手动触发；授权目标就绪后再启用定时）
```

数据目录：`core/workspace/`（逐页产物）与 `core/deliverable/`（可部署包），
`HEIMDALL_DATA_DIR` 可整体移出仓库；两者都不进 git。

---

## 6. 里程碑（2026-09-29 起算）

| 周 | 日期 | 交付 | 验收 |
|---|---|---|---|
| W0 POC | 9.29-10.05 | **地基假设验证**：apify 首页 DOM+CSS 脱离原站渲染出原样；`build_clone` 最小闭环 | 一张能打开的克隆页 + 第一张 diff 图 |
| — | **10.09 前** | **完成比赛报名**（1-5 人队） | 报名回执 |
| W1 | 10.06-10.12 | 三代表页（首页/pricing/actor 列表）+ differ 评分 + atlas.json | 还原度报告 v1 |
| W2 | 10.13-10.19 | 控制台骨架 + 2D 星图 + 任务队列 + WebSocket | 内网贴 URL 可跑通 |
| W3 | 10.20-10.26 | 3D 星图 + 施工舱四层动画（**中期评审对齐 10-20**） | 剧场模式 L0-L2 可演 |
| W4 | 10.27-11.02 | harvest 情报包 + report.html + 全站侦察 + 90s 剧本联排 | 三件套完整 |
| W5 | 11.03-终审 | 打磨 + 彩排 ≥3 次 + 录屏备份 + thordata 第二适配器 | 演示日 checklist 全绿 |

关键路径：**W0 的地基假设**。它不成，一切白搭 —— 所以它是周末第一件事。
加塞原则：期间任何与 W0/W1 冲突的事（包括给文档再涂脂抹粉）一律让路。

---

## 7. 环境

Windows 11 · Node 22+ · pnpm · Playwright chromium · Python 3（仅数据后处理可选）·
LLM：比赛期用现有 ZCode 额度；console 全部产物本地缓存，断网可演。


---

## 8. 实现状态标注（2026-09-30，W0-W6 完成）

v1 设计→实现的差异（以上文为准，本节为勘误表）：

| v1 设计 | 实现 | 说明 |
|---|---|---|
| Three.js 3D 星图 | **已经做了**，`console/src/Graph3D.vue`（3d-force-graph） | 上一版这里写"Canvas 2D，3D 待决策"——已过时。自转由我们自己的 rAF 循环供帧（库冷却后不重绘，见 [历史 HANDOFF](docs/archive/HANDOFF-through-2026-10-13.md) §4b） |
| MCP 工具层 | **已经做了**，`core/src/mcp/server.mjs`（13 个工具，stdio） | 上一版写"MCP 封装后补不阻塞"——已补上。另有 CLI 与浏览器书签两个并列入口 |
| ZCode skill 编排 | pipeline.mjs 固化编排 | 流水线是确定性代码，无需 agent 循环 |
| serve.mjs 临时服务 | engine 常驻 /static/* | 端口冲突根除 |
| 评分单帧 | 多帧最优匹配 + breakdown | W5 正名，动画噪声可测量 |

**最终组件清单（全部已实现）：**
```
core/src/
  crawler/  capture(多帧+CSSOM+画布光栅化) build_clone(CSSOM重写) linker(接线+HAR)
            recon(BFS+sitemap) shot_clone index_page multi-snapshot(多视口)
            repair-css-refs repair-empty-assets responsive-upgrade motion(-css)
  differ/   diff(多帧+三维+差异形态) domdiff(parse5) shape(连通块形态判定)
            fixup(AI校准循环) style-probe(computed差异)
  harvest/  harvest(规则+LLM语义) xlsx(跨页汇总)
  seo/      rules(66 条) collect audit pagination structured baseline matrix raw-html
  live/     export(交付包) heal(离线本地化) health serve har live-html
  verify/   verify(多视口) interactions(交互回放) compare
  audit/    assets assets-report storage deliver-prune cas-gc orphans reclaim-orphans
  deliver/  edit-manifest(改站起点) replace-domain
  store/    cas(内容寻址去重)   session/   watch/   sandbox/   mcp/   browser/   jobs/
  adapters/ index.mjs —— generic / nextjs / vueVite 三个适配器同文件（探测自动路由）
  pipeline.mjs（六阶段编排） engine-server.mjs（HTTP+SSE+队列+槽位） cli.mjs llm.mjs env.mjs
console/    Atlas.vue（壳）+ DetailDock / PagesView / JobsView / Graph3D…（11 个组件）
```

**关键端口/路径**：engine :8900（/api/* /static/* /lm/* /px/*，见 engine-server.mjs 顶部）·
vite :5173（proxy `/api/` **与 `/static/`**）· 产物 workspace/<host>/
