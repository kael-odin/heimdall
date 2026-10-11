# ARCHITECTURE · 技术架构与里程碑

---

## 1. 三层架构

```
┌────────────────────────────────────────────────────────┐
│ Console 控制台                                          │
│   Vue 3 + Vite + Tailwind + Three.js + WebSocket        │
│   星图 / 施工舱 / 还原度报告 / 剧场模式                    │  ← 同事看到的全部
├────────────────────────────────────────────────────────┤
│ Engine 引擎层                                           │
│   任务队列 · 事件总线 · WebSocket 推送 · 产物仓库管理       │
│   比赛期编排：ZCode + SKILL.md（薄，随时可替换）            │
│   赛后演进：迁 DSH Control Center 桌面 agent              │
├────────────────────────────────────────────────────────┤
│ Core 工具链（确定性代码，核心壁垒，无 LLM 依赖）             │
│   crawler  — sitemap+BFS 路由发现 / Playwright 渲染后     │
│              DOM+CSS chunk+资产+双截图 归档               │
│   builder  — DOM+CSS → 可跑镜像页（gen-page.mjs 泛化）    │
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
core/adapters/
  nextjs.ts     # apify 路线：_next/static/chunks 提取，Turbopack 命名兼容
  vue-vite.ts   # thordata 路线：data-v 作用域清理 + 按页 chunk 注入（suixiang-clone 原方法）
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
| 资源 | 全部本地化（CSS/图片/字体在本地） | 实时回源，走引擎 `/lm/` 代理 |
| 样式来源 | **CSSOM 最终态**（含脚本注入的样式） | 原站自己的 CSS |
| 网络 | **完全离线可开** | 需要引擎在线 + 原站可达 |
| 视觉 | 校准到像素级（差异形态可查） | 未校准，等于原站当前的样子 |
| 交互 | 无（链接可点，但没有 JS 行为） | 有（标签页/搜索/下拉都能用） |
| 强项 | 给前端做**视觉还原的唯一可信基线**；出交付包 | 给产品/运营看"这个站怎么用"；看真实数据 |
| 弱项 | 页面是"照片"，动效与交互都没有 | 视觉随原站漂移；原站改了它就变 |

**一句话记法**：静态镜像是**照片**（冻结、离线、像素准），交互镜像是**直播**（在跑、联网、会变）。

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

```
heimdall/
  core/                 # TypeScript, pnpm, Playwright
    src/crawler/ builder/ differ/ harvest/ adapters/
    workspace/          # 产物仓库（gitignore）
  console/              # Vue3+Vite+Three.js
    src/views/{Atlas,Forge,Report,Theater}.vue
  engine/
    SKILL.md            # ZCode 编排（比赛期）
  mcp/                  # core 薄封装（可选：给 ZCode/DSH 当工具）
  docs/                 # 本 PRD 套件
```

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
| Three.js 3D 星图 | Canvas 2D 星系盘面 | 2D 达标线已达标（缩略图行星/核球光/银河带/入场运镜），3D 待决策 |
| MCP 工具层 | engine-server HTTP API（:8900） | SSE 事件流直连 Web 控制台；MCP 封装后补不阻塞 |
| ZCode skill 编排 | pipeline.mjs 固化编排 | 流水线是确定性代码，无需 agent 循环 |
| serve.mjs 临时服务 | engine 常驻 /static/* | 端口冲突根除 |
| 评分单帧 | 多帧最优匹配 + breakdown | W5 正名，动画噪声可测量 |

**最终组件清单（全部已实现）：**
```
core/src/
  crawler/  capture(多帧+CSSOM) build_clone(CSSOM重写) recon(BFS+sitemap) shot_clone index_page
  differ/   diff(多帧+三维+差异形态) domdiff(parse5) shape(连通块形态判定)
            fixup(AI校准循环) style-probe(computed差异)
  harvest/  harvest(规则+LLM语义) xlsx(跨页汇总)
  adapters/ nextjs/vue-vite/generic（探测自动路由）
  pipeline.mjs（六阶段编排） engine-server.mjs（API+SSE+静态+并发槽） llm.mjs env.mjs
console/    Atlas.vue（星图+施工舱 HUD v2/v3）
```

**关键端口/路径**：engine :8900（/api/recon /api/forge /api/events /static/*）· vite :5173（proxy /api/）· 产物 workspace/<host>/
