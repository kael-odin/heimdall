# HANDOFF · 项目交接文档

> 交给下一个建设者（人或 AI）。本文档假设你零上下文接手；读完即可继续开发。
> 配套阅读：PRD.md（产品定义）→ ARCHITECTURE.md（架构）→ docs/W0-W16-REPORT.md（全部踩坑实录）→ USAGE.md（用户手册）。

---

## 1. 一句话

**Heimdall = 站点复刻引擎**：输入一个 URL，输出三件套——全站星图（结构）、死/活双形态镜像（表现）、情报包（数据）。竞品分析从"开 DevTools 抄一周"变成"贴个网址等十分钟"。

## 2. 当前能力快照（2026-10-08，全部有实证）

| 能力 | 状态 | 实证 |
|---|---|---|
| 全站侦察 → 3D 星图 | ✅ | apify 61 节点/1498 边、thordata 32 节点，sitemap+双队列 BFS，每节点 SEO 轻量画像 |
| 死镜像（视觉/结构 100% 级） | ✅ | apify 60 页均 96.8%（55A/4B/1C）、thordata 31 页 96.1%（22A/9B/0C） |
| 活镜像（交互/数据回原站） | ✅ | /lm/ 融合路由，两站 pricing pageerror=0/4xx=0，hydration 交互实测 |
| 情报包 | ✅ | 规则抽取+LLM 语义（定价/套餐/价值主张）→ xlsx；跨页 fidelity.csv |
| 全站批量锻造 | ✅ | queue.mjs 持久化队列，断点续跑，thordata 31/31、apify 60/60 |
| 同步滚动对比 | ✅ | compare.html（1440px 统一视口，根除响应式变形） |
| 控制台 | ✅ v2 | 工作台 IA：底部导航 星图/页面/任务/报告/设置；页面表格（搜索/筛选/批量克隆/逐页视觉分）；任务中心；报告中心；引擎地址与 Token 可配 |
| 任务持久化 | ✅ | node:sqlite（JSON 降级）存 jobs/events；重启恢复 + interrupted 标记；`GET /api/jobs.history`；控制台任务页历史 |
| 资产缺口扫描 | ✅ | CLI + 控制台一键（引擎 assets 任务）；apify/thordata 视觉缺口均 0（thordata 修复前 673）；页面清单新增 资产/缺口/交互/更新 列与排序，详情面板含克隆/活镜像/对比快捷入口 |
| 逐页质检 / 跨站对标 | ✅ | 详情「质检」tab（多视口+交互+缺口+校准曲线）；报告页一键矩阵（引擎 matrix 任务，实测报告 200） |
| 统一 CLI | ✅ | `node src/cli.mjs <command>` 覆盖 recon/forge/queue/audit/watch/verify/tokens/live/dedupe/deliver/serve |
| 沙盒改造台 | ✅ v1 | `node src/sandbox/serve.mjs <host> <page>`：HTML/CSS 在线编辑 + 实时预览 + 与原版全页 pixelmatch（实测 24.7% → 100%） |
| 报告中心 / 资产清单 | ✅ | 控制台报告页动态报告索引（/api/reports）＋ Top 资产表（/api/assets） |
| MCP / 浏览器入口 | ✅ v1 | `src/mcp/server.mjs`（stdio MCP，12 工具，测试覆盖 initialize/tools/list/call）；`src/browser/bookmarklet.mjs` 生成书签安装页（no-cors 简单请求，token 走 query） |
| SEO 对标矩阵 | ✅ v1 | `node src/seo/matrix.mjs <本站> <竞品...>` → 站点分/覆盖率/LCP/页面类型/高频问题对比（HTML+CSV+JSON） |
| 组件抽取 | ✅ v1 | `node src/extract/extract-components.mjs <host>` → header/hero/pricing/faq/footer/cta 独立预览 + components.json/html 画廊 |
| 设计 Token | ✅ v1 | `node src/extract/extract-tokens.mjs <host>` → tokens.json/css/html（色板/字阶/间距/圆角/阴影/断点/变量 + 频次） |
| 部署 | ✅ v2 | Dockerfile + docker-compose（引擎+控制台+Playwright 单端口 8900，数据卷 /data）；本机单端口用 HEIMDALL_CONSOLE_DIR |
| 变更监控 | ✅ v1 | `node src/watch/watch.mjs <host>`；两次采样排除动态噪声；字段级变化报告 + `--fail-on-change` 门控 + 历史快照 |
| 活镜像 L3 | ✅ v1 | `node src/live/export.mjs <host>` → 自包含部署包：零依赖 serve.mjs + HAR 回放 + Dockerfile/compose + checksums；离线模式可断原站运行（smoke 覆盖导出/离线启动/本地页面/CSS/404） |
| 多视口 + 交互回放 | ✅ v1 | 视觉 375/768/1440 全页 diff + 功能交互回放（状态签名 & 视口像素，`--no-interactions` 可关）；实测 apify pricing 视觉 96.0% A、交互 3/3 | `node src/verify/verify.mjs <host> <page>`；375/768/1440 全页 diff（apify storage 实测 91.0% B：桌面 98.2 / 平板 89.4 / 移动 78.4） |
| SEO 审计 | ✅ v1 | `node src/seo/audit.mjs <host> --max 20` → seo.html/csv/json，40+ 规则、六分类评分 |
| 质量门 | ✅ | `pnpm lint` / `pnpm test`（12 单测）/ `pnpm smoke`（fixture 离线 E2E，含 SEO 审计）+ GitHub Actions |
| 安全默认值 | ✅ | 绑定 127.0.0.1、代理 host 白名单、路径越界防护、可选 token、CORS 限定来源 |

## 3. 配置速查（v2）

| 变量 | 作用 | 备注 |
|---|---|---|
| `HEIMDALL_TOKEN` | 引擎 API 口令（/api、/px） | 与模型 Key 无关；默认不启用 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_MODEL_FAST` | 模型服务三要素 | Key 只进 core/.env（gitignore） |
| `LLM_PROTOCOL` | `chat`（默认）/ `responses` / `anthropic` | 请求构造与响应解析已适配 |
| `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` | 超时/网络重试 | 默认 180s / 3 |
| `HEIMDALL_DATA_DIR` | 产物目录 | 默认 core/，可迁仓库外 |
| `HEIMDALL_CONSOLE_DIR` | 单端口部署的控制台 dist | Docker/本机单端口用 |

当前中转实测：支持 `/chat/completions` 与 `response_format`；可用模型 `deepseek-flash / deepseek-v4-flash / deepseek-v4-pro`；无视觉模型（fixup 自动走文本模式）。

## 3. 架构三层（谁依赖谁）

```
Console（console/，Vue3+Vite+:5173）      ← 用户唯一入口，零命令行
    │ fetch/SSE（API=127.0.0.1:8900 直连，vite proxy 会缓冲 SSE 勿走代理）
Engine（core/src/engine-server.mjs :8900） ← 全部业务：任务/事件/静态/lm/px/sites
    │ spawn 子进程
Core（core/src/）                           ← 确定性工具链
    crawler/ recon(crawl) capture(CSSOM) build_clone build_live linker fullshot index_page
    differ/  diff(多帧+三维) domdiff fixup(AI校准) style-probe
    harvest/ harvest(规则+语义) xlsx
    adapters/ nextjs vue-vite generic
    pipeline.mjs（六阶段编排） queue.mjs（全站队列） deliver.mjs（交付包）
    llm.mjs（.env: LLM_BASE_URL/KEY/MODEL，key 不入库）
```

**外部依赖**：Playwright chromium（核心）、LLM 中转 xc.lifesecretary.com:8000/v1（glm-5.3-flash 主 / deepseek-flash fast，fixup 用 fast；key 在 core/.env 已 gitignore）。

## 4. 运行手册

```cmd
:: 一键启动（引擎+控制台+浏览器）
clone-heimdall.cmd

:: 全站批量锻造（断点续跑：有产物的页自动跳过）
cd core && node src\queue.mjs <host> --max 60

:: 单页锻造 / 侦察 / 交付包 / 全页快照补拍
node src\pipeline.mjs <url> <name>
node src\crawler\recon.mjs <url> [maxPages] [maxDepth]
node src\deliver.mjs <host>
node src\crawler\fullshot.mjs <host>
```

**重启恢复 SOP**（已实测）：起 engine → 起 vite → `node src\queue.mjs <host>`（resume 自动对账）→ 失败页单页重试。

## 5. 精华坑清单（血泪，勿重蹈）

1. **CSSOM 最终态**才是样式的真身（styled-components/Vue scoped 运行时注入，HTML link 只是冰山）——capture 的核心决策
2. **/lm/ 融合路由预检勿走自身**（会命中旧 live 文件永远 200）——死活判断走 /px/ 纯反代
3. **剥挂件必须在 bootstrap 注入之前**（剥除正则会把含关键词的 bootstrap 自己删掉）
4. **async handler 里 readFileSync 目录 = EISDIR = 连接挂死**（不是 502）——文件候选只放文件
5. vite proxy key 带**尾斜杠**（'/api/'）——否则前缀劫持 /apify.com/* 静态路径
6. vite proxy 会**缓冲实时 SSE**——SSE 直连引擎端口，勿走代理
7. **正则字面量在 python heredoc 三层转义下必烂**（\b 变退格、\s 变字面）——复杂匹配用字符串 split，或 Write 工具直写
8. 多帧评分（3 帧取最优）+ breakdown（dynamicShare/refinable）是**动画噪声**的量化解
9. 分 host stub 策略：thordata=MAGIC 递归 / apify=CONSERVATIVE（magic 在 apify chunk 下挂死）
10. LLM 中转偶发半死连接——llm.mjs 已带 retry×3 + AbortSignal 超时；max_tokens 16384（reasoning 吃 token）
11. apify sitemap 20 万 URL——sitemap fetch 已加 15s 超时 + sitemapSame 上限 500

## 6. 待办路线（按优先级）

1. **活镜像 v2 增量**：Edge Worker 导出、SW 客户端拦截（可选）、API 回放策略细分（当前 L3 已具备 Docker/Node 部署 + HAR 回放）
2. ~~资产 CAS 去重~~ ✅（2026-10-08：apify 节省 241MB / 48%，thordata 同步处理，队列自动执行）
3. **多视口验证**：375/768/1440 全页 diff + 交互回放，替代单帧自评
4. **活镜像深层交互**：apify store/use-cases 点击触发的被剥脚本下游引用（5-6 errs/页）——逐站第三方依赖白名单
2. **chunk 快照时效**：原站重部署后旧哈希 chunk 失效——已可定期重锻刷新；可升级为增量 chunk 补抓
3. **素材映射层（L4）**：harvest 数据 → 素材映射表（logo/主色/文案→文件路径/DOM 位置），前端"查表换牌"
4. **组件抽取**：高频组件（定价卡/导航/FAQ）独立 HTML+CSS 片段导出
5. **演示彩排**：DEMO-SCRIPT.md 3 分钟流 ×3 计时 + 录屏
6. 浅色主题下 3D 节点配色微调、站点按钮硬编码深色底适配

## 7. 红线（不可越）

- 登录后区域禁区；产物不公开部署；竞品资产不商用；严格反爬站白名单拒收并明说
- 分数口径诚实：不吹 100%，动效缺失用 dynamicShare 量化展示

## 8. 2026-10-09 续：新一轮彻查与修复（均有实测）

### 8.1 关键缺陷：clone 字体路径全站 404（已修复）
- 现象：`clone/styles/cssom.css` 里字体写成 `url("styles/refNNN.woff2")`，从 cssom.css 自身目录解析 = `styles/styles/refNNN.woff2` → 404，全站回退系统字体（肉眼难察觉的保真损失）。
- 根因：`build_clone.mjs` 字体相对路径多了一层 `styles/`。
- 修复：`build_clone.mjs` 改为同目录文件名；新增 `core/src/crawler/repair-css-refs.mjs`（幂等）修复历史产物，CLI 命令 `repair <host>`。
- 实测：apify 61 页/454 处、thordata 31 页/1040 处修复；Playwright 复检 `font failed requests: 0`、`document.fonts.check('16px Inter') === true`；apify pricing 多视口 verify 由 96.0% 升至 **99.85/99.93/99.96%**。
- 扫描器同步加固：`audit/assets.mjs` 新增“clone 内相对引用必须按文件自身目录可解析”的检查（此前同名兜底会掩盖坏链）；新增单测 `core/test/assets.test.mjs`。

### 8.2 活镜像体检 + 自愈（新）
- `core/src/live/health.mjs`：静态体检（无浏览器/无网络）→ bundle `health.json`：assets(local/har/unresolved/dynamic/external) + links(missing) + externalAssetsTop。
- `core/src/live/heal.mjs`：`--heal` 导出期从原站补抓离线缺失资源（按路径去重、多 `?dpl=` 变体重试、动态端点跳过、MIME/体积校验）。
- `export.mjs` 接线：默认写 health.json；`--strict` 有缺口非零退出（CI 用）；landing/README 显示离线资源覆盖；smoke 对 fixture 断言 `unresolved === 0`。
- 实测 apify：heal 补 154 文件/5.8MB → local 5124 / har 773 / unresolved 590 refs（唯一 489，主要是旧部署 404 的 `_next/static/chunks/*` 与 `_next/image` 动态端点）。
- 结论：**要 100% 离线自包含，必须每页都留下 network.har** —— 老页面需 `queue --force` 重锻补录（下一步）。

### 8.3 还原度口径 v2（minViewport）
- `verify/compare.mjs#worstViewport`；verify.json / verify-summary.json 输出 minViewport 与站级 worst。
- 控制台：页面表“视觉”列显示最差视口（<0.95 出现 ↓NN，琥珀/红）；表头“最差视口均值”；质检 tab 新增“最差视口”行。
- 实测：storage 页面 1440x900 96.0%（综合 97.8%）正常展示，截图见会话记录。

### 8.4 本轮质量门
lint 75 文件 · 单测 61/61 · smoke 全绿（含 live health unresolved=0）· CI 绿（244cead / eb06876）。


## 9. 2026-10-09 续二：活镜像离线自包含达成（apify + thordata 双站 unresolved=0）

### 9.1 HAR 补录（每页 network.har）
- `queue <host> --missing-har`（新增，只重锻缺 HAR 的页，不重做已完成页）。
- apify：60/60 页补齐（原始 HAR 共 1.17GB）；thordata 原有 31/31 已带 HAR。
- queue 健壮性：引擎重启/不可达不再崩溃（退避重试）；SSE 断开回退轮询持久化任务；失败页可重试（attempts<2）。

### 9.2 导出管线升级（export.mjs + heal.mjs + serve.mjs）
- **流式 HAR 合并**：逐页 sanitize → 同源过滤 → URL 去重；apify 合并后 3,019 条/70.7MB（含站外图片条目共 4,508 条/104MB）。
- `--materialize-har`：无查询同源响应落盘为实体文件；带查询响应保留回放体（覆盖 JS 动态请求）。
- **动态图片本地化**：`/_next/image?url=…` 与站外 CDN 图片（image/*）落盘 `_ext/<sha1>.<ext>`，HTML 引用改写为 `/lm/<host>/_ext/…`；边界感知替换（避免命中更长 URL 子串）；写时复制（避免硬链接连带改坏 workspace 源文件）。
- **serve.mjs 回退**：精确变体未录到 → 同源图任意已捕获尺寸回放。

### 9.3 双站最终体检（离线 + strict 通过）
| 站点 | 页面 | 资源引用 | 本地可用 | 未覆盖 | 站外资产 | 包体积 |
|---|---|---|---|---|---|---|
| apify.com | 61 | 22,649 | 13,248 | **0** | 1,419（追踪类） | 383MB |
| thordata.com | 31 | 4,265 | 4,264 | **0** | 252 | 156MB |

浏览器离线实测（apify 6 页：/、/pricing、/about、/use-cases/market-research、/store、/integrations）：**0 个镜像请求失败、0 pageerror**；仅第三方追踪像素（bat.bing/doubleclick）失败，属预期。字体与动态图片全部本地化。

### 9.4 复现命令
```cmd
node core\src\queue.mjs <host> --missing-har
node core\src\crawler\build_live.mjs <host>
node --max-old-space-size=4096 core\src\live\export.mjs <host> --offline --root mirror --heal --materialize-har --strict
```

## 10. 2026-10-09 续三：控制台一键闭环（体检 + 活镜像导出）

- 引擎新增任务：`POST /api/verify {host,page?,maxPages?}`（多视口体检，全站/单页）与 `POST /api/live-export {host,root?,rebuild?}`（离线完整包：--offline --root mirror --heal --materialize-har，node 4GB 堆）。
- 控制台「报告」页新增 **全站体检** 卡（运行/重跑 + verify-summary.json 入口）与 **活镜像导出** 卡（可选"先重建 live 页面"，完成后自动刷新体检卡）。
- 详情「质检」tab 新增 **运行本页体检** 按钮（未跑过多视口时显示）。
- 任务中心统一展示这两类任务（verify=v 前缀 / live=l 前缀），状态持久化。
- 实测：单页体检 v001 done、活镜像导出 l002 done（thordata 缺口 0）、UI 两个按钮全链路通过。

## 11. 2026-10-09 续四：全站多视口体检结果（apify 61 页）

- 结论：**平均 99.0%，59A / 2B**（verify-summary.json；375/768/1440 三视口）。
- 最差页面（minViewport 口径）：
  | 页面 | overall | 最差视口 | 得分 |
  |---|---|---|---|
  | store | 95.3% | 768 | **81.9%** |
  | api | 96.3% | 768 | 87.8% |
  | doing-good | 94.4% | 768 | 88.4% |
  | resources-startups | 95.9% | 375 | 90.2% |
  | agents.md | 93.9% | 375 | 91.1% |
  | storage | 96.1% | 768 | 91.5% |
- 根因（store 实测）：LogoWrapper 的 .desktop 变体带桌面内联尺寸（--unicorn-width:420px），.mobile 变体是客户端渲染、静态 DOM 里不存在 → 后半页均一 +128px 偏移。属"死镜像（L1 静态移植）无法覆盖客户端响应式变体"这一类问题；**活镜像（脚本完整）不受影响**。
- 后续升级方向：响应式采集（多视口 DOM 合并 / 保留变体节点 + 媒体规则），或对 minViewport<0.9 的页默认引导使用活镜像（控制台质检 tab 已加提示）。

## 12. 2026-10-09 续五：0 字节资产修复（追踪信标）

- 发现：每页 1-2 张"裂图"实为 bat.bing 追踪信标（以 img 形式请求，抓取阶段被落盘成 0 字节 .bin）。
- 新增 `repair-empty`（CLI）：追踪域名 → 1×1 透明 GIF data URI；其它 0 字节 → 回退原始 URL；删除空文件、同步改写 HTML/CSS 引用；幂等。
- 实测：apify 61 页 / 306 个空文件 / 122 处引用改写；thordata 20 页 / 20 个空文件；修复后 doing-good 与 store 的裂图 2 → 0，资产扫描仍 0 视觉缺口。
- 结论：剩余最差页（store 81.9% 等）的根因是客户端响应式变体（见第 11 节），与资产缺失无关。

## 13. 2026-10-09 续六：抓取防复发 + 资产浏览器

### 13.1 抓取阶段不再产生 0 字节资产（防复发）
- `capture.mjs`：资源下载后空体直接判失败（进 gaps.json），不落盘。
- `build_clone.mjs`：fetchBin 空体抛错；cssom ref 与捕获资产复制均跳过空文件。
- `queue.mjs` host-post 自动追加 `repair-empty-assets`（批量重锻后自动清历史空文件）。

### 13.2 控制台资产浏览器（报告页）
- 引擎 /api/assets/:host 支持 `q / ext / page / minSize / sort / limit / offset`，返回 byExt/byPage 分面 + **原始 URL（src，来自 asset-map 反查）**。
- 控制台：搜索（同时匹配本地路径与原始 URL）、类型/页面筛选、排序、≥100KB、**图片缩略图预览**、原站链接；服务端过滤（防抖 250ms），暗色下拉已按 color-scheme 修正。
- 实测：apify 5,150 个资产 / 76.2MB；搜 "logo" → 26 条（全部带缩略图与原站链接）。


## 14. 2026-10-09 续七：孤儿资产扫描 + 去重账本可视化

- 新增 `orphans <host>`（CLI，队列 host-post 自动执行）：扫描 clone 内无任何引用的资产，产出 `audit/orphans.json`（全量 orphanPaths + 逐页 Top60 明细）。
  - 判定：全站引用 token 精确匹配相对路径，或同页 token 包含 basename；线性复杂度（apify 2.8s）。
  - 实测：apify 25,555 资产 → 12,229 孤儿 / 189.9MB；thordata 3,062 → 1,520 / 20.0MB。
- 引擎 /api/assets 支持 `orphan=1`，返回 orphan 标记与汇总；收集上限从 5,000 提升到 200,000（此前 5,150 的“总数”其实是截断）。
- 控制台资产浏览器：新增「仅孤儿」筛选；标题显示 孤儿 N（X MB） 与 去重节省 X MB（重复 N）（读取 asset-ledger.json）。

## 15. 2026-10-09 续八：单模型 LLM 配置 + 孤儿回收安全化（含一次事故与回滚）

### 15.1 LLM 配置（本地 core/.env，gitignored）
- 仅用 deepseek-flash（带视觉）：LLM_MODEL=deepseek-flash、LLM_MODEL_FAST=deepseek-flash、LLM_PROTOCOL=chat、base=https://xc.lifesecretary.com:8000/v1。
- 实测：/api/llm/test → ok 2012ms「连接正常」；llmChat 文本/JSON、llmVision（截图→About Apify）全部通过。

### 15.2 孤儿回收安全化（一次事故 + 三道防线）
- 事故：首版回收直接删除 1,520 个 thordata “孤儿”，资产扫描随即报 310 处坏链（启发式漏掉转义引用形式）。已通过 queue --force 全量重锻恢复（visualGaps 回到 0）。
- 三道防线（已实测）：
  1. 保守判定：候选 basename 必须不出现在全站任何文本（含转义 assets\/imgNNN 形式）；
  2. 隔离而非删除：移动到 audit/quarantine/<ts>/；
  3. 自校验回滚：回收前后各跑一次资产缺口扫描，若 visualGaps 上升则自动全部回滚。
- 实测：thordata 86 孤儿 → 保守候选 24 个 → 隔离 24（1.9MB）→ gaps 0→0，无回滚；剩余孤儿 62。
- apify 保守候选 10,781 个 / 125.5MB（待确认后可在控制台执行）。

### 15.3 apify 孤儿回收执行结果
- 保守候选 10,781 个 / 125.5MB → 全部隔离（gaps 0→0，无回滚），剩余孤儿 904 / 42.4MB。
- 交付包重导出：**26,292 文件 / 383.0MB → 15,206 文件 / 257.5MB（−125.5MB）**，unresolved 仍为 0；离线实测 /、/pricing、/store 均 0 镜像失败。
- 新增 `reclaim-orphans <host> --purge`：确认无副作用后可回收隔离区磁盘（默认保留隔离区作安全网）。

## 16. 2026-10-09 续九：死镜像响应式升级（多视口快照）

- 新增 `multi-snapshot <host> <page> | <host> --all [--max N] [--pages a,b]`：按 375/768 重新渲染，保存 dom/cssom-<w>；build_clone 自动生成 index-375/768/1440 + index.html 视口选择器（≤600→375，≤1100→768，否则 1440）。
- 实测（apify，veriify 三视口 overall/最差视口）：
  | 页面 | 升级前 | 升级后 |
  |---|---|---|
  | store | 95.3% / 81.9% | **99.7% / 99.95%** |
  | doing-good | 94.4% / 88.4% | **99.8% / 99.7%** |
  | resources-startups | 95.9% / 90.2% | **99.9% / 99.8%** |
  | storage | 96.1% / 91.5% | **99.7% / 99.0%** |
  | agents.md | 93.9% / 91.1% | **97.8% / 95.6%** |
  | api（反例） | 96.3% / 87.8% | 94.5% / 87.9% → 已回退 |
- 结论：多快照解决“客户端响应式变体”类漂移（4/5 页显著提升）；代码块等非响应式差异不受益。
- 工作流：`multi-snapshot` → `build_clone` → `verify`；**只有分数提升才保留**，否则删除 dom/cssom-<w> 并重建（api 即按此回退，变体备份在 pages/api/_variants-backup）。

## 17. 2026-10-09 续十：响应式升级自动化（低分页批量，verify 门槛）

- 新增 `responsive-upgrade <host> [--threshold 0.97] [--max N]`：读取 verify-summary → 对 minViewport < 阈值且未升级的页执行 multi-snapshot → build_clone → verify；**最差视口提升 >0.5% 且综合分不降 >0.5% 才保留**，否则自动回退变体并重建。
- apify 实测：candidates=6 → **KEEP 4 / REVERT 2 / FAIL 0**：
  | 页面 | 升级前 | 升级后 | 处置 |
  |---|---|---|---|
  | api | 96.3/87.8 | **99.4/97.7** | 保留 |
  | integrations-zapier | 98.0/92.6 | **99.8/99.5** | 保留 |
  | scrapers | 96.9/93.4 | **99.9/99.9** | 保留 |
  | home | 95.4/94.0 | **99.3/99.1** | 保留 |
  | templates | 97.0/96.9 | 97.1/96.9 | 回退 |
  | jobs | 98.4/97.0 | 97.6/96.5 | 回退 |
- 累计（含此前手工 5 页）：apify 共 9 页完成多快照升级；原最差 6 页全部 ≥95.6%（store 81.9→99.95、api 87.8→97.7、doing-good 88.4→99.7、resources-startups 90.2→99.8、agents.md 91.1→95.6、storage 91.5→99.0）。
- 产物：audit/responsive-upgrade.json（逐页 before/after/保留或回退）。

### 17.2 最终全站体检（consent 修复 + 响应式升级后）
- **平均 99.6%，61/61 全 A**（此前 99.0%、59A/2B）。
- 最差页：storage 98.3/93.3(375)、agents.md 97.8/95.6、about 98.6/96.0、jobs 98.5/97.0、templates 97.2/97.0。
- 说明：storage 的 375 视口仍有 93.3%（疑似交互态抖动）；其余页面均 ≥95.6%。

### 17.3 一键响应式升级（引擎任务 + 控制台按钮）
- 引擎 `POST /api/responsive-upgrade {host,threshold,max,force}`（kind=upgrade，SSE 事件 upgrade-page）；控制台「全站体检」卡新增「响应式升级」按钮。
- 实测：任务 u001 正常创建/完成；UI 按钮显示正常。
- 第二批 --force（threshold 0.98）结果：KEEP storage(93.3→96.6)/jobs(97.0→**100.0**)/contact(97.1→99.7)/use-cases-lead-generation(97.3→99.9)/ideas(97.3→99.1)；REVERT agents.md/about/templates（无提升）。

### 17.4 整页截图前的懒加载滚动（消除第二类抖动）
- 现象：storage 复测 92.4%(768)、change-log 90.0%(375) 波动大——整页截图期间下方懒加载内容才加载，两侧时序不一致。
- 修复：verify.mjs 在截图前先滚全页触发懒加载 → 回顶部 → networkidle → 再等待。
- 复测：storage **100.0%/100.0%**（原 92.4）；change-log 97.1%（原 96.3）；agents.md 93.9/91.1 不变（其差异非懒加载）。
