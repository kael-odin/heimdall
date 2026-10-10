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
| `HEIMDALL_ENV_FILE` | 配置文件路径 | 默认 `core/.env`；容器挂载 / 单测隔离用 |

> `LLM_*` 这些键现在**可直接在控制台「设置 → 模型服务」改**，保存即生效（无需重启）。
> 手动编辑 `core/.env` 同样有效。被 shell 环境变量遮蔽的键会在控制台里明确提示。

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

## 18. 2026-10-09/10 续十一：批次 0「通用克隆」止血（全部有实测）

方向已定：**先做"任何人在任何机器上一条命令跑通"**，再重设计控制台。详见 [docs/PLAN-2026-10-09.md](docs/PLAN-2026-10-09.md)。

### 18.1 无引擎也能 `forge`（P0-1）
`pipeline.mjs` 在 shot 阶段先探测 `<引擎>/api/status`：可达走 `/static/`，否则回退
`file://<pageDir>/clone/index.html`（克隆页资产本就全部本地化，实测 0 失败请求）。
新增事件 `forge-note` 告知来源；`shot_clone.mjs` 的写死默认 URL 一并移除。

### 18.2 不再"猜默认站点"（P0-3）
新增 `core/src/args.mjs`（`requireArg` / `parseTarget`）。**12 个 core 脚本**的
`process.argv[n] ?? 'apify.com'` 全部改为缺参数即报用法退出；控制台 host 默认值同步移除。
新增单测 `test/args.test.mjs`：逐个脚本跑空参必须非 0 退出，并扫描源码禁止"写死默认站点"复发。

### 18.3 CSS `url()` 解析（P1-1 + 本轮最大发现）
新增 `core/src/css-refs.mjs`（`scanCssRefs` / `collectCssRefs` / `rewriteCssRefs`）：

1. **基准修正**：`url()` 必须按**样式表自身 URL** 解析（CSS 规范），不是页面 origin。
   实测 tailwindcss.com：`…/media/InterVariable-*.woff2` → **404**；`…/_next/static/media/…` → **200**。
   今天能跑通靠的是 nextjs 适配器的特例重写 + DOM preload 的 basename 兜底（两层运气）。
   `cssom-refs.json` 现在记录 `refMap`（每个引用的基准解析候选）。
2. **data URI 内嵌 `url()` 被误判**（新发现，最严重）：
   `url("data:image/svg+xml,…<g mask='url(%23f)'/>…")` 里的 `%23f` 被当成外部引用 →
   抓 `https://host/%23f`（SPA 兜底 200 HTML）→ 落盘 `refNNN.html` → **再把内嵌 mask 引用改写掉**，
   静默破坏内联 SVG 图标。**vitest.dev 实测 34 处中招**；修好后 refs 53→26，假资产 27→0。
   扫描器改为逐字符识别：遇到 `url(` 后若紧跟引号就整段跳到配对引号之后，内嵌内容不再被二次扫描。
3. **失败可见**：本地化缺口写入 `clone-gaps.json`（不再只打日志）。

### 18.4 资产类型与软 404（P1-2 + 新增）
新增 `core/src/asset-ext.mjs`：扩展名判定 **magic bytes > Content-Type > URL 后缀 > bin**。
- 旧实现只靠 URL 后缀猜 → 带查询串的 CDN 图（`?w=1000&q=80`）一律落成 `.bin`；
  实测 `ref003.bin` 前 4 字节 `ffd8ffe0` = JPEG。**诚实说明**：Chrome 下用两个探针实测
  （`<img>` 与 CSS `background-image` 绘制路径截图像素）**都能嗅探正常渲染**，不是保真事故；
  但跨浏览器未验证、导出包里语义脏，故按真实类型落盘。
- 新增 `isSoftHtml()`：请求图片却返回 `text/html`（SPA 兜底 / 软 404）→ 判为失败并记入缺口，
  不再落盘成"看着有、其实全错"的假资产。`linker.mjs` 同样接入（此前产生 27 个 HTML `.bin`）。

### 18.5 `ref-index.json`：幂等重建不再串资产
`refNNN` 编号来自引用在 CSS 中的出现顺序；扫描口径一变编号就整体位移，按"序号"复用旧产物会**把 A 图接到 B 的位置**。
`clone/ref-index.json` 改为按**引用原文**建索引（`{ cssFile: { rawRef: { rel, candidates } } }`）。
无索引的老产物用「已构建 CSS 的 token 顺序 ↔ 源 CSS token 顺序」一一对应反推迁移。
实测：apify/about 重建后 `clone/styles/cssom.css` **字节级一致**；`linker.mjs` 改用 ref-index 反查原站 URL。

### 18.6 其他
- `engine-server.mjs`：MIME 表 15 → 40+ 项；4 处 `readFileSync` 改为 `sendFile()`
  （流式 + `Content-Length` + **Range**，几百 MB 的包不再顶爆堆，视频可拖动）。
- 控制台/CLI 无破坏性变更；`clone-gaps.json` 暂未接到 UI（批次 2 接入质检 tab）。

### 18.7 本轮质量门与真实站点验收
lint 87 文件 · 单测 **80/80**（63 → 80）· smoke 全绿。**全部无引擎、全新站点、一条命令**：

| 站点 | 自动识别的栈 | 首屏保真 | CSS 缺口 | 未本地化资产引用 |
|---|---|---|---|---|
| vitest.dev | `vue-vite` | **99.96%** | 0 | 0 |
| astro.build | `generic`（未知栈） | **100.00%** | 0 | 0 |
| tailwindcss.com | `nextjs` | **99.92%** | 0（9 处为原站真 404） | 0 |

复现：
```cmd
node core\src\cli.mjs forge https://<任意站>/ home
node core\src\cli.mjs queue <host> --max 20
```

### 18.8 下一批（批次 1，未开工）
控制台配置第三方大模型（引擎 `GET/PUT /api/settings/llm` + 热重载 + 草稿测试）·
站点配方 `core/sites/<host>.json`（把 `adapters` 特例与 `build_live.mjs:81` 的 apify 分支迁进数据）·
robots.txt 遵守 + crawl-delay · 分类规则补中文 + DOM 特征推断。

## 19. 2026-10-10 续十二：批次 1「通用克隆能力」（全部有实测）

### 19.1 控制台配置第三方大模型（P0-2）
**改完即生效，无需重启引擎** —— `env.mjs` 不再缓存、`llm.mjs` 每次调用重读配置。

- `core/src/settings.mjs`：直接读写 `core/.env`（单一真相源，已 gitignore）。
  **原位改值**：注释/空行/未知键逐字节保留；新键追加末尾。Key 永不回显（只给 `hasKey` + 末 4 位）。
  白名单只允许写 8 个 `LLM_*` / `HEIMDALL_LLM` 键，其余一律拒绝。
- 引擎：`GET /api/settings/llm`、`PUT /api/settings/llm`、`POST /api/llm/test`（**支持草稿**：传
  `baseUrl/apiKey/model/protocol` 按草稿测，不落盘 —— 先测通再保存）。
  安全：未设 `HEIMDALL_TOKEN` 时只允许**本机回环**改写（否则引擎绑 0.0.0.0 后任何内网同事都能换你的模型端点）。
  省略 `apiKey` = 保持不变（控制台不回显 Key，不能让空值把它覆盖掉）。
  被 shell 环境变量遮蔽的键会列进 `shadowed`，控制台明确指出"改了为什么不生效"。
- 控制台「设置 → 模型服务」：启用/协议/Base URL/Key/主模型/快速模型/超时/重试 + 6 个预设
  （OpenAI / Anthropic / DeepSeek / OpenRouter / 本地 Ollama / 自建中转）+ 「测试连接（不保存）」+「保存并生效」。
- 实测：保存改模型 → `.env` 仅目标行变化（8 行 → 8 行，diff 仅 1 行）；Key 保留；
  草稿测试用**真实 Anthropic 端点**打回 `401 invalid x-api-key`（证明 anthropic 协议路径与
  `x-api-key` 头正确）；坏协议/坏 URL/空模型/越界超时/未知字段全部给出可读错误。
- 错误信息人性化：`无法连接模型服务 <url>（ENOTFOUND）…`、`模型服务返回 404（端点不存在——Base URL 是否漏了 /v1？）`。

### 19.2 站点配方（P0-4）—— 把站点特化从代码挤进数据
```
core/sites/_default.json     内置默认（代码里的 DEFAULTS）
core/sites/<host>.json       人工整理（随仓库提交，优先级最高）
workspace/<host>/site.json   运行时学到的事实（产物，gitignore）
```
合并顺序：DEFAULTS → workspace → **core/sites（人工压过自动）**。职责边界：
**框架知识留在 `adapters/`**（由指纹推导），**站点知识放配方**。

- `build_live.mjs` 里那行 `var CONSERVATIVE = H.indexOf('/lm/apify') === 0;` 已删除 →
  现在是 `profile.live.stubStrategy`（apify.com.json 里写 `conservative`，默认 `magic` 与 thordata 行为一致）。
  挂件脚本黑名单同样改为配方驱动。
- `adapters/index.mjs` 重写为**数据形态**（`cssRefRewrites` / `removeSelectors` 取代函数），
  并支持 `profile.adapter` 强制指定跳过探测。
- `queue.mjs` 的排除项、`capture.mjs` 的等待策略/静置时间/弹窗选择器全部来自配方。
- 运行时学习：`capture` 写 `profile-observed.json`，`linker`（每次批量末尾）汇总进
  `workspace/<host>/site.json`。**只记观察事实，不写策略** —— 自动写策略会让一次跑歪盖掉人工修正。
- 新命令：`node src/cli.mjs profile <host>` 查看生效配方与来源；`profile --list` 列已有站点。
  配方说明见 `core/sites/README.md`。
- 实测：apify 活镜像重建后 `var CONSERVATIVE = true`（此前来自 host 字符串判断）；
  用配方重建的 HTML 与旧版仅差注释文案。

### 19.3 页面分类补中文 + DOM 特征兜底（P1-5）
抽成 `core/src/crawler/classify.mjs`（纯函数、可单测 —— recon.mjs 是顶层 await 脚本，导不出东西）。
- 12 条规则全部补上中/日常见词：`/价格 /定价 /套餐 /关于我们 /帮助中心 /隐私政策 /招聘 /登录 …`
- 路径判不出时用 **DOM 特征**兜底（密码框→auth、代码块→doc、FAQ→help、价格+表格→pricing…），
  只在路径给出 generic/marketing 且**非首页**时介入。
- 站点可用 `classify.extraRules` 追加路径约定。
- 实测 aliyun.com（中文站）14 页：`{marketing:2, generic:8, blog:1, doc:1, product:2}`，无异常。

### 19.4 robots.txt：**不内置限制**（决策）
按 2026-10-10 的决定（个人研究用途），**不实现 robots 解析与 crawl-delay 强制**。
并发/节流保持现状，作为可配参数存在，默认不引入新限制。后续不要把这条限制加回来。

### 19.5 本轮质量门
lint 93 文件 · 单测 **106/106**（80 → 106）· smoke 全绿（含活镜像导出与离线体检）。
新增测试：`settings`（8）· `site-profile`（9）· `classify`（7）。

### 19.6 下一批（批次 2，未开工）
控制台组件化（1819 行 `Atlas.vue` → ≤8 组件 + Router/Pinia/TS）· 视觉按路线 A 降噪提对比 ·
CAS 引用计数回收（删站真释放磁盘）· 站点 `site.json` 磁盘看板 · `clone-gaps.json` 接进质检 tab。

## 20. 2026-10-10 续十三：批次 2「存储治理 + 控制台 WCAG AA」（全部有实测）

### 20.1 CAS 孤儿回收（P1-6）—— 删站终于能真的释放磁盘
判据建立在一个既有事实上：`dedupeTree` 去重后，**CAS 与 workspace 副本共用同一个 inode**
（`linkOver` 把原文件 rename 走、再 link CAS 过去），所以

- `nlink > 1` → 至少还有一个站点副本在用 → **保留**
- `nlink === 1` → 只剩 CAS 这一个链接 → **孤儿，可回收**

CAS 从不被直接读取（纯去重源，全仓库只有 `store/dedupe.mjs` 写它），因此删除孤儿不会破坏任何产物；
真需要时下一次 `dedupe` 会重新登记。

- `store/cas.mjs` 新增 `scanCas()` / `gcCas()`。删除前**再看一次 nlink**（扫描与删除之间可能有并发去重刚链上）；
  顺带清理 `aa/bb` 空目录。
- CLI：`node src/cli.mjs cas-gc [--apply] [--json]`（默认只预览）。
- 引擎：`GET /api/storage`（30s 缓存）· `POST /api/storage/scan` · `POST /api/storage/gc`。
  **真回收要 `confirm=HEIMDALL_CAS_GC`**，且未设 `HEIMDALL_TOKEN` 时只允许本机回环——防止内网共享后一键删资产。
- **删除站点/页面后自动回收**：`DELETE /api/sites/:host` 与 `.../pages/:name` 在删完产物后自动跑一次 `gcCas(apply)`，
  响应里带 `casGc: { freed, orphanFiles, failed, skipped }`。
- 实测：CAS 6,206 文件 / 2.78GB 逻辑；其中 **1,271 个孤儿 / 697.0MB** 可回收。API 全链路验证：
  GET 首次 11.8s（冷盘遍历）、缓存 3ms、dry-run 与未确认 apply 被正确拒绝（400）。

### 20.2 存储治理看板（新）
`src/audit/storage.mjs`：`computeStorage()` 用**同一个 `(dev, ino)` 去重表跨目录一起遍历**
（workspace ∪ CAS ∪ deliverable），因此 "实际占用" 与 "逻辑体积" 不会互相污染：

| 指标 | 值（实测） |
|---|---|
| 逻辑体积 | 7554.3MB |
| 实际占用 | 3912.3MB |
| 可回收 CAS | 697.0MB / 1271 个 |
| 站点 | apify 2211.8MB（48,888 文件）· thordata 627.3MB（4,797 文件） |

控制台「报告」页新增**存储治理**卡：4 个 KPI + 站点占用条 + CAS 回收区（预览 / 二次确认 / 执行 / 结果）。
首次盘点约 10 秒（桌面遍历 5.4 万文件），30 秒内走缓存——加载文案已如实说明耗时。

### 20.3 控制台结构性缺陷修复（这轮最重要的发现）
截图评审暴露了两处**真实缺陷**，不是观感问题：

1. **星图浮层压在工作视图上**：`.hud`（品牌 + 61/1544/apify.com 统计）与 `.sites`（站点切换条）是 fixed 浮层，
   z-index 低于工作面板但**面板底色是 92% 不透明**，于是高亮 HUD 文字整片透出来压住卡片；报告页的表头还和它们叠在一起。
   → 浮层改为 `v-if="view === 'atlas'"`，工作视图 `top` 改为让开搜索栏。
2. **窄屏下控件不可达**：390px 下 `.sites` 一行放不下，「页面清单」被裁掉、点不到（WCAG 层面是硬伤）。
   → 新增 `SitePicker.vue`，把站点切换 + SEO 审计放进**每个工作视图自己的表头**，自然换行、不会溢出。
   实测 390px 与 1440px 下 `document.scrollWidth === innerWidth`（无横向溢出）。

顺带把 `.reports-grid`（浮层）改成真正的 `work-view` + `.reports-scroll` 网格，报告页与其他工作台视图结构一致。

### 20.4 WCAG AA 基线（本轮验收项）
用「真实背景混合」的方式在浏览器里逐个文本节点量对比度（不是拍脑袋估色），发现并修复：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 深色 `--text-faint` | 4.13:1 | **4.8:1** |
| 浅色 `--text-faint` | 2.4:1 | **5.2–5.8:1** |
| 浅色 `--cyan` | 3.68:1 | **5.4:1** |
| 浅色 `--green` | 3.6:1 | **5.6:1** |
| 浅色 `--red`（淡红底上） | 4.47:1 | **6.6:1** |
| **页面类型标签（浅色）** | **1.81:1**（基本不可读） | **4.5–7.6:1** |
| 星图操作提示（浅色） | **1.45:1** | 通过 |

- **类型标签是重灾区**：`types.js` 的颜色是给深色画布调的霓虹色，浅色主题下直接印在白底上（1.81:1）。
  现在每个类型带 `color`（深色画布）+ `light`（白底按 AA 校过），`typeColor(type, theme)` 按主题取值。
- 星图浮层（`.keys`/`.panel-open`/`.status`/`.seek`/`.task-center`）底色写死深色，浅色主题下深字压深底 —— 补了浅色覆盖。
- 新增 `:focus-visible` 焦点环、`prefers-reduced-motion` 降级、`.sr-only`。

**验收方式（可复跑）**：4 组合（深/浅 × 1440/390）× 5 视图，逐文本节点量对比度 + 检查每个可交互控件的可访问名，
结果全部通过。同时修掉 71 个无可访问名的资产缩略图链接、页面表格全选/行选复选框、以及设置表单里
`label` 与控件未关联（改 `for`/`id`）的问题。

### 20.5 图标改自绘 SVG（不再用 Unicode 字符当图标）
新增 `Icon.vue`：24 网格 / 1.6 描边 / 圆头圆角，`currentColor` + `1em`。
替换 `☰`（仪表面板）、`☾/☀`（主题）、`✕`（关详情、删站点），并给每个图标按钮补 `aria-label`；
底部导航的装饰字形加 `aria-hidden`，让读屏只念可见文字标签。

### 20.6 检测器与质量门
`impeccable detect` **空结果**（此前报 1 条 `layout-transition`：`.refine-bar` 动画 `width` → 改 `transform: scaleX()`）。
lint 98 文件 · 单测 **116/116**（106 → 116：cas-gc 5 条 + storage 5 条）· smoke 全绿。

### 20.7 自引入缺陷与修复：盘点冻结事件循环（务必记住这条）
第一版把 `computeStorage()` 直接放在请求处理里同步跑。实测：

| | 盘点耗时 | 盘点期间 `/api/status` |
|---|---|---|
| 修复前 | 12036ms | **采样 0 次** —— 连 500ms 的 `setInterval` 都一次不触发 |
| 修复后 | ~11s（子进程） | **1–2ms**（22 次采样全部有响应） |

即同步遍历 5.4 万文件会把 Node 事件循环整个冻住，期间所有 API / SSE / 活镜像代理全部排队。
**修法回到引擎既有的模式：重活一律 spawn 子进程。**
- `startStorageScan()` 起 `storage` 任务（不占锻造槽；已在跑则复用）
- `GET /api/storage` 只读 `DATA_ROOT/storage.json`，过期/缺失时后台补一次并立刻返回已有结果（无结果返回 `{pending:true}`）
- `POST /api/storage/scan` → 202 + taskId；前端轮询到结果出现（40s 超时）
- `POST /api/storage/gc` 只跑轻量 CAS 回收（6k 文件 ~0.5s），随后触发后台重扫
- 删站/删页同理

**教训**：这个引擎里任何"遍历几万个文件"或"跑几十秒"的事，都必须走 `spawnTask`；
放进请求处理 = 整个引擎停摆。`/api/storage` 是唯一一处曾违反此规则的地方，现已修正。

### 20.8 仍未做（批次 2 剩余 / 批次 3）
- 控制台仍是单体 `Atlas.vue`（已抽出 `SitePicker.vue` / `Icon.vue` 两个组件，拆分为 ≤8 组件的目标未完成，
  也没有引入 Router/Pinia/TS —— 按 FORM 决策"先不引入无必要的状态库迁移风险"）。
- `clone-gaps.json` 还没接进质检 tab（批次 0 产出的缺口报告目前只能直接开文件看）。
- 3D 星图仍是首屏一次性加载（bundle 1.54MB / gzip 423KB）。
- 首启向导、i18n、内置 demo 站点（批次 3）。




---

## 21. 2026-10-10/11 续十四：SEO 回归门禁 + v3 视觉系统 + 结构整治（全部有实测）

### 21.1 SEO 回归基线门禁（补齐「测试」那半边）

此前 SEO 只有**审查**（audit 每次全量重述），没有**测试**。现在 `audit` 可与基线比对，
出现阻断级回归时 `exit 1`，配套 `.github/workflows/seo-gate.yml`（手动 + 每日定时，不阻塞 PR）。

判定口径（阻断当且仅当）：
- 上次能访问的页面这次消失（404/不可达/不再被发现）
- 已有页面上新出现 `critical`/`high` 问题
- 新出现 `critical`/`high` 的站点级问题
- 仅当 `--tolerance N > 0` 时，总分跌幅超过 N

三个必须处理的实际问题（不处理的话门禁会在几天内被 `continue-on-error` 关掉）：
1. **波动规则**：LCP/CLS/FCP 每次跑都在抖。引入**稳定分**（剔除波动规则后重算），
   波动规则的变动只作「观测」上报。实测：原始分 100→75 的 LCP 抖动，稳定分 delta = 0。
2. **页面集合会变**：新页面是中性；上次能访问、这次 404 的页面才是回归，必须单列且 critical。
3. **计数会漂移**：基线键是 `(page, ruleId)` 对，不是规则计数。

**刻意不做的事**：不把「分数下降」记成回归条目 —— 分数是问题列表的**派生**量，
记两条会让 `blocking` 计数虚高、同一条问题报两遍。分数只作顶栏数字展示。

`--fail-on-regression` 要求基线必须存在：基线丢了当成首次运行直接绿灯，
是门禁最隐蔽的失效方式（它看起来和正常通过一模一样）。
前置条件检查放在抓取之前 —— 路径写错 0.4s 失败，而不是白抓一遍全站。

三条路径都在 example.com 上实测：页面消失 exit 1、新增 high 问题 exit 1、基线缺失 exit 1。

### 21.2 交付包保留策略（deliverable/ 此前只增不减，已积到 1.9GB）

`heimdall deliver-prune [--keep N] [--apply]`。三个设计判断：
1. 分组按 `(站点, 类型)`，不是全局按时间 —— 否则导出一个新站点会挤掉另一个站点仅有的包。
2. **认不出命名规则的一律不动**（`apify-live-healed` 这类可能是手工产物），只列进「无法归类」。
3. 报告**实际释放**而非目录大小：交付包文件与 workspace 克隆共享 inode，
   按 `nlink` 算。实测 keep=1 时「可回收 2 个包」但「实际可释放 111.6MB」—— 按目录大小报会虚高 3 倍。

排序主键是**名字里的日期**，不是目录 mtime（mtime 会因内部文件增删而变化）。
这个问题是写测试时才发现的：几个测试目录创建在同一毫秒，mtime 排序不稳定，
才意识到判据本身不对。

### 21.3 v3 视觉系统：改为 Anthropic / Claude Code 语言

| | v2（已废弃） | v3 |
| --- | --- | --- |
| 底色 | `#0B0B10` 冷蓝黑 | `#1F1E1D` 暖炭 / `#FAF9F5` 象牙 |
| 强调 | `#22D3EE` 霓虹青 | `#CC785C` 黏土橙 / 浅色 `#B05730` |
| 装饰 | 四角刻度 + 内嵌渐变 + 辉光 | 实底 + 1px 描边 + 柔和投影 |
| 圆角 | 4px | 10px |
| 字体 | Google Fonts Orbitron + Share Tech Mono | 系统栈（去掉一次阻塞渲染的外网请求） |

令牌改成语义名（`--cyan`→`--accent`、`--abyss`→`--bg`、`--amber`→`--warn`、
`.hud-panel`→`.surface`）；语义色半透明层全部改 `color-mix()`（62 处），
两套主题自动跟随，并删掉了一整批 `[data-theme="light"]` 补丁
（那些补丁的存在只是因为底色写死）。

**实测缺陷**：
- **星图拖拽窗口撑出横向滚动条**：`Graph3D` 无 resize 处理，视口 1280→1024 后
  canvas 停在 1280 宽，`scrollWidth` 1280，多出 256px 滚动条并裁掉画布右侧。
  改 `ResizeObserver` + rAF 合并。
- **浅色主题下星图节点基本不可见**：节点色烤死在节点对象里、用深色色板，
  而画布底色就是 `--bg`。实测 15 色有 12 个低于 3:1，最差 `#FBBF24` 仅 **1.54:1**。
  改为按主题算 `graphPalette` 传进去；切主题重喂数据但**不重新取景**（否则重置用户视角）。
- 底部操作提示与导航 dock 水平重叠 328px、垂直完全重叠，被压掉大半；
  详情面板在 <1128px 时盖住最后一屏内容；「克隆档案」链接被详情面板整块覆盖（154×32）。

术语统一：锻造→克隆、深空观测站→站点克隆工作台、死镜像→静态镜像。
保留「星球」（3D 力导向图里这个比喻仍然准确）。

### 21.4 结构整治

**`Atlas.vue` 2196 → 1217 行**（-45%），9 个组件：
`DetailDock` / `PagesView` / `StorageCard` / `AssetTable` / `JobsView` / `Graph3D` / `SitePicker` / `Icon`，
外加 `format.js` / `pages.js` / `api.js` / `ui.css`。

拆分中必须处理的真问题：**`<style scoped>` 只作用于本组件模板内的元素**。
抽出去的子组件内部元素拿不到 `.wv-*` 这类类名，样式会**静默失效**
（照常渲染、控制台不报错，只是变丑）。所以先把整个 style 块提成全局 `ui.css`，
再用脚本逐条量计算样式确认没丢。

**首屏 JS 1553KB → 160KB（gzip 422KB → 55KB，-87%）**：`3d-force-graph` + `three`
（1363KB）拆成按需 chunk。实测 DOMContentLoaded 45ms、首次绘制 72ms。
两个收益，第二个对本项目更实际：外壳先可用；**改控制台代码重建时不必重下那 1.4MB**。

**页面清单 N+1 消除**：此前逐页发 `score.json` + `verify.json`（80 页 = 160 请求），
而分数本就包含在 `/api/pages` 的响应里。引擎补返回 `minViewport`（同一个文件，零额外 IO），
控制台删掉整条逐页路径。实测整次加载 + 打开页面视图共 **18 个请求**，逐页产物请求 **0**。

交付包清理同样走子进程（上万个文件）：实测盘点期间 `/api/status` 延迟 1–2ms（20/20 采样）。

### 21.5 仍未做

- **规模**：默认并发 2、`--max` 上限 200，无法处理 >1000 页的站点。
  要「克隆任何网站」到实用规模，需要并发可配 + 增量重克隆 + 单页超时熔断。
- **首启向导 / i18n / 内置 demo 站点**（批次 3）。
- 设置页仍在 `Atlas.vue` 内（约 107 行模板 + 若干表单状态）。抽出的 prop 面约 25 个、
  emit 约 11 个，比留在原地更糟 —— 除非先把 LLM 表单状态也做成 composable。
- L4 可维护镜像（站点改版后的增量更新）。
