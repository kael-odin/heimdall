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
| 静态镜像（视觉/结构 100% 级） | ✅ | apify 60 页均 96.8%（55A/4B/1C）、thordata 31 页 96.1%（22A/9B/0C） |
| 交互镜像（交互/数据回原站） | ✅ | /lm/ 融合路由，两站 pricing pageerror=0/4xx=0，hydration 交互实测 |
| 情报包 | ✅ | 规则抽取+LLM 语义（定价/套餐/价值主张）→ xlsx；跨页 fidelity.csv |
| 全站批量锻造 | ✅ | queue.mjs 持久化队列：断点续跑 + **增量重跑**（按源站 HTML 指纹）+ **单页熔断**（硬超时 & 无进展）；并发按配方；thordata 31/31、apify 60/60 |
| 同步滚动对比 | ✅ | compare.html（1440px 统一视口，根除响应式变形） |
| 控制台 | ✅ v2 | 工作台 IA：底部导航 星图/页面/任务/报告/设置；页面表格（搜索/筛选/批量克隆/逐页视觉分）；任务中心；报告中心；引擎地址与 Token 可配 |
| 任务持久化 | ✅ | node:sqlite（JSON 降级）存 jobs/events；重启恢复 + interrupted 标记；`GET /api/jobs.history`；控制台任务页历史 |
| 资产缺口扫描 | ✅ | CLI + 控制台一键（引擎 assets 任务）；apify/thordata 视觉缺口均 0（thordata 修复前 673）；页面清单新增 资产/缺口/交互/更新 列与排序，详情面板含克隆/交互镜像/对比快捷入口 |
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
| 交互镜像 L3 | ✅ v1 | `node src/live/export.mjs <host>` → 自包含部署包：零依赖 serve.mjs + HAR 回放 + Dockerfile/compose + checksums；离线模式可断原站运行（smoke 覆盖导出/离线启动/本地页面/CSS/404） |
| 多视口 + 交互回放 | ✅ v1 | 视觉 375/768/1440 全页 diff + 功能交互回放（状态签名 & 视口像素，`--no-interactions` 可关）；实测 apify pricing 视觉 96.0% A、交互 3/3 | `node src/verify/verify.mjs <host> <page>`；375/768/1440 全页 diff（apify storage 实测 91.0% B：桌面 98.2 / 平板 89.4 / 移动 78.4） |
| SEO 审计 | ✅ v1 | `node src/seo/audit.mjs <host> --max 20` → seo.html/csv/json，**66 条规则**、六分类评分（规则数由 `core/test/seo-rule-count.test.mjs` 钉住） |
| 质量门 | ✅ | `pnpm lint` / `pnpm test`（**240 单测**）/ `pnpm smoke`（fixture 离线 E2E，含 SEO 审计）+ GitHub Actions |
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

1. **交互镜像 v2 增量**：Edge Worker 导出、SW 客户端拦截（可选）、API 回放策略细分（当前 L3 已具备 Docker/Node 部署 + HAR 回放）
2. ~~资产 CAS 去重~~ ✅（2026-10-08：apify 节省 241MB / 48%，thordata 同步处理，队列自动执行）
3. **多视口验证**：375/768/1440 全页 diff + 交互回放，替代单帧自评
4. **交互镜像深层交互**：apify store/use-cases 点击触发的被剥脚本下游引用（5-6 errs/页）——逐站第三方依赖白名单
2. **chunk 快照时效**：原站重部署后旧哈希 chunk 失效——已可定期重锻刷新；可升级为增量 chunk 补抓
3. **素材映射层（L4）**：harvest 数据 → 素材映射表（logo/主色/文案→文件路径/DOM 位置），前端"查表换牌"
4. **组件抽取**：高频组件（定价卡/导航/FAQ）独立 HTML+CSS 片段导出
5. **演示彩排**：DEMO-SCRIPT.md 3 分钟流 ×3 计时 + 录屏
6. 浅色主题下 3D 节点配色微调、站点按钮硬编码深色底适配

## 7. 红线（不可越）

- 登录后区域禁区；产物不公开部署；竞品资产不商用；抓取并发/节流按需可配，但**不内置 robots / crawl-delay 限制**（见 §19.4）
- 分数口径诚实：不吹 100%，动效缺失用 dynamicShare 量化展示

## 8. 2026-10-09 续：新一轮彻查与修复（均有实测）

### 8.1 关键缺陷：clone 字体路径全站 404（已修复）
- 现象：`clone/styles/cssom.css` 里字体写成 `url("styles/refNNN.woff2")`，从 cssom.css 自身目录解析 = `styles/styles/refNNN.woff2` → 404，全站回退系统字体（肉眼难察觉的保真损失）。
- 根因：`build_clone.mjs` 字体相对路径多了一层 `styles/`。
- 修复：`build_clone.mjs` 改为同目录文件名；新增 `core/src/crawler/repair-css-refs.mjs`（幂等）修复历史产物，CLI 命令 `repair <host>`。
- 实测：apify 61 页/454 处、thordata 31 页/1040 处修复；Playwright 复检 `font failed requests: 0`、`document.fonts.check('16px Inter') === true`；apify pricing 多视口 verify 由 96.0% 升至 **99.85/99.93/99.96%**。
- 扫描器同步加固：`audit/assets.mjs` 新增“clone 内相对引用必须按文件自身目录可解析”的检查（此前同名兜底会掩盖坏链）；新增单测 `core/test/assets.test.mjs`。

### 8.2 交互镜像体检 + 自愈（新）
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


## 9. 2026-10-09 续二：交互镜像离线自包含达成（apify + thordata 双站 unresolved=0）

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

## 10. 2026-10-09 续三：控制台一键闭环（体检 + 交互镜像导出）

- 引擎新增任务：`POST /api/verify {host,page?,maxPages?}`（多视口体检，全站/单页）与 `POST /api/live-export {host,root?,rebuild?}`（离线完整包：--offline --root mirror --heal --materialize-har，node 4GB 堆）。
- 控制台「报告」页新增 **全站体检** 卡（运行/重跑 + verify-summary.json 入口）与 **交互镜像导出** 卡（可选"先重建 live 页面"，完成后自动刷新体检卡）。
- 详情「质检」tab 新增 **运行本页体检** 按钮（未跑过多视口时显示）。
- 任务中心统一展示这两类任务（verify=v 前缀 / live=l 前缀），状态持久化。
- 实测：单页体检 v001 done、交互镜像导出 l002 done（thordata 缺口 0）、UI 两个按钮全链路通过。

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
- 根因（store 实测）：LogoWrapper 的 .desktop 变体带桌面内联尺寸（--unicorn-width:420px），.mobile 变体是客户端渲染、静态 DOM 里不存在 → 后半页均一 +128px 偏移。属"静态镜像（L1 静态移植）无法覆盖客户端响应式变体"这一类问题；**交互镜像（脚本完整）不受影响**。
- 后续升级方向：响应式采集（多视口 DOM 合并 / 保留变体节点 + 媒体规则），或对 minViewport<0.9 的页默认引导使用交互镜像（控制台质检 tab 已加提示）。

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

## 16. 2026-10-09 续九：静态镜像响应式升级（多视口快照）

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

方向已定：**先做"任何人在任何机器上一条命令跑通"**，再重设计控制台。详见 [docs/archive/PLAN-2026-10-09.md](docs/archive/PLAN-2026-10-09.md)（历史记录）；当前待办见 [docs/ROADMAP.md](docs/ROADMAP.md)。

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
分类规则补中文 + DOM 特征推断。（原列的 "robots.txt 遵守 + crawl-delay" 已按 §19.4 的决定取消。）

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
- 实测：apify 交互镜像重建后 `var CONSERVATIVE = true`（此前来自 host 字符串判断）；
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
lint 93 文件 · 单测 **106/106**（80 → 106）· smoke 全绿（含交互镜像导出与离线体检）。
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

即同步遍历 5.4 万文件会把 Node 事件循环整个冻住，期间所有 API / SSE / 交互镜像代理全部排队。
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

术语统一：锻造→克隆、深空观测站→站点克隆工作台、静态镜像→静态镜像。
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

---

## 22. 2026-10-11 续十五：审计补强 + 交付文档 + 仓库整治 + 差异形态

### 22.1 SEO：47 → 54 条规则（补两个从未被检查的维度）

**hreflang（4 条）**：采集层一直在收 `link[rel=alternate][hreflang]`，
但**没有任何规则用它** —— 数据躺在那里没人看。补上多语言站最常见的四类错误：
缺自指条目（会导致整组被忽略）、href 用相对地址、语言码不合法
（`zh_CN` 下划线是典型笔误；也接受 `sr-Latn`/`zh-Hant-HK`/`es-419`）、
有多条却没有 `x-default`。

**JS 渲染依赖（3 条）**：新增采集 —— 用页内 `fetch` 取**同一 URL 的服务端原始 HTML**
（走浏览器网络栈带 cookie，但不执行脚本），用 parse5 解析出与渲染侧同名的信号，两者并排比较。

这回答的是一个此前没被问过的问题：**浏览器看到的页面很完整，但爬虫第一遍看到的是什么。**
渲染后审计对 SPA 一律给满分 —— 因为它量的就是浏览器里的样子。

实测 14 个不同技术栈的真实站点：vitest.dev / svelte.dev / tailwindcss.com / vuejs.org /
crawlee.dev / thordata.com / framer.com / webflow.com / figma.com / linear.app / vercel.com /
codesandbox.io 全部服务端直出，**0 误报**；excalidraw.com（4%）与 hoppscotch.io（9%）
被正确识别为 JS 依赖。现代营销站几乎全部 SSR/SSG 了 —— 这条规则很少响，
但响的时候一定是对的。

诊断工具：`pnpm -C core probe:render <url...>`。

### 22.2 交付包 README 按"前端可接手"重写

原文案是**目录说明书** —— 把文件列了一遍，但没回答"手上的活怎么干"。
重写后按"你想拿它做什么"组织，三种用法分开写（抄视觉 / 抄结构 / 读竞品），
新增「推荐流程：从这份包到你能上线的代码」五步，
以及自动生成的「需要优先手工确认的页面」表（列出还原度 <95 的页与各自的动效占比）。

关键提示补上了：原站类名多为哈希，**长期改造要以镜像为视觉基准重建组件**，
而不是在哈希类上堆样式 —— 后者在换掉原站样式表的那一刻全部失效。

顺带修：`site/design/` 一直没被打包（README 却会引用它）；文件名改成 `README.md`。

### 22.3 UTC 日期戳缺陷

交付包目录名用 `toISOString().slice(0,10)` —— 那是 UTC。在 UTC+8，
每天 0:00–8:00 生成的包会带**前一天**的日期（实测 10-11 凌晨跑出来叫 `-2026-10-10`）。
而交付包保留策略正是按名字里的日期排序的。新增 `localDateStamp()`（paths.mjs），
deliver / live 导出 / SEO 矩阵三处统一改用它。

### 22.4 控制台：黑话改人话 + 三处真重复

星图三项 `pages / edges / origin` → `页面 / 站内链接 / 原站` 并带悬停解释
（「站内链接」的悬停直接写着"不是页面数"）；站点角标 `61F` → `61/62`；
「已侦察：」→「站点：」（现在有只克隆未侦察的站点）。

三处重复：任务浮层缺视图守卫（在「任务」视图里同一份列表显示两遍）；
「更多报告」把上面已有卡片的 7 项又列一遍（改成「设计资产」，只列没有专属卡片的）；
「交互镜像导出」+「交互镜像体检」是同一件产物的两张卡（合并）。

### 22.5 交互镜像：站外引用只显示了一半

一直只显示 `externalAssets`（带扩展名的站外静态资源），
而 `external`（总数）从没露面。差额是 YouTube 嵌入、地图、统计脚本这类
**无扩展名**的外链 —— 实测 apify 站外引用 1826 条，其中静态资源 1419 条，
**407 条在界面上完全不可见**（含那 73 个 YouTube iframe）。
两个口径都摆出来后，README 也补了「离线时会缺什么」一节逐字段解释。

### 22.6 画布盲区（用户肉眼发现的）

用户在看同步对比时发现 vitest.dev 有两块是空的。查下来那不是 `<img>`，
是 **`<canvas>`** —— 内容由 JS 绘制，而静态镜像按设计剥离全部脚本。
**这是一整类盲区，不是两张图的问题。** 而像素分当时是 99.96%
（画布只占页面一小块，被容差吸收）—— 肉眼一眼可见，评分体系完全无感。

修复分三步，每步都是实测逼出来的：
1. 捕获阶段光栅化，构建阶段换成 `<img>`；
2. 采样必须**在页面水合之后**（`waitUntil` 默认 `domcontentloaded`，
   滚动发生在画布动画的 IntersectionObserver 注册之前 → 全程 0 个不透明像素）；
3. 抓**内容最全的一帧**而不是第一帧（画布是动画，Vite Powered 在不同帧里画 1 或 2 个六边形）。

排查过的其它盲区（结论是没问题，记下来免得重查）：
`<video>` 正常（thordata 的 4 个视频已本地化，克隆里 readyState=4）；
内联 `<svg>` 随 HTML 搬运不受影响；iframe 是外站嵌入，属固有边界。

### 22.7 差异形态：同样 96%，是"坏了一块"还是"只是渲染差异"

新克隆样本 ant.design 只跑到 **95.96% 像素**（仍 A 级），是迄今最低的。排查过程
（含一次自我纠正）：

1. 怀疑横向溢出 → **去量原站，原站也有同样 100 个元素、位置一模一样**，撤回；
2. 查 DOM 差额 → 完全来自我们**故意剥离**的 style/script/link，以及 canvas→img 的替换；
3. 查字体 → 两边 `font-family`、`document.fonts`、canvas 实测文本宽度**完全一致**；
4. 测整体位移 → 平移 ±1..3px 都更差，0px 最优 → 不是位移；
5. 算连通块 → **2801 块，最大仅 360px，前 5 块占 5%**，最大那块落在 `<h1>` 上
   → 差异碎在**字形边缘**，是抗锯齿级别，无一处内容缺失。

**结论：分数低不代表坏了。而用户看到 95.96% 时无从分辨 —— 这才是缺口。**

新增 `src/differ/shape.mjs`：按「前 5 大块占总差异的比例」分类
（`concentrated` ≥40% / `mixed` / `diffuse` ≤12%），写进 `score.json` 的 `diffShape`，
在详情面板「质检 → 视觉保真」里显示。10 个单测重点是**判据的方向性**：
同样 900 个差异像素，成一整块必须判 concentrated、散成 900 个孤立点必须判 diffuse ——
判反了比没有更糟。

### 22.8 仓库整治

根文档 10 → 7（删 PRODUCT.md 并入 PRD；删 DESIGN.md，组件规范按 v3 重写后并入
VISUAL-SYSTEM.md §6）；README 从"按版本堆的 changelog"重写为入口文档；
docs/ 的周报与带日期的评审/计划移入 `docs/archive/` 并加索引；
新增 `docs/ROADMAP.md`（只放当前待办）。

**删掉文档里与实现不符的承诺**：RISKS.md 曾写"robots 全禁的站直接拒收" ——
与"不内置 robots 限制"的设计决定冲突且代码里没实现。文档写了代码不做的事就是假文档。
同时修掉到处写着的"40+ 规则"（当时按源码数实际 54 条；现在这件事交给守卫测试了）—— 位数级过期的数字会让人整体不信这份文档。

### 22.9 本轮克隆样本（全部实测）

| 站点 | 技术栈 | 像素 | 总分 | 差异形态 |
| --- | --- | --- | --- | --- |
| cn.vuejs.org | VitePress（中文） | **100.00%** | A | 一致 |
| vitest.dev | VitePress | 99.96% | A | — |
| crawlee.dev | Docusaurus | 99.50% | A | — |
| ant.design | React + CSS-in-JS | 95.96% | A | 弥散 |
| apify.com | 全站 61 页 | ~99.1% | A | — |
| thordata.com | 全站 31 页 | ~96.1% | A | — |

适配器自动识别生效：cn.vuejs.org 判为 `vue-vite`，crawlee.dev / ant.design 判为 `generic`。

## 23. 2026-10-11 续十六：规模三件套（并发可配 / 增量重克隆 / 单页熔断）

ROADMAP 里排第一的那块。三项都落地并实测，另加一条此前没被问到的东西：
**整站克隆搬到引擎侧**（`POST /api/clone-site`）—— 原先只能靠控制台标签页里的
两个 worker 驱动，关掉页面任务就断。

### 23.1 并发可配

并发从代码常量搬进站点配方：`queue.concurrency`（默认 2）、`queue.maxPages`。
实际 worker 数取 **min(配方, 引擎槽)** —— 配方说 6 而引擎只有 2 个槽时，
多出的 worker 只会反复撞 409、空转重试，看着并行实际串行，还刷满日志。
引擎槽位上限 `HEIMDALL_FORGE_SLOTS`（默认 2，硬上限 8：每个槽 = 一个 Chromium）。

### 23.2 增量重克隆

新增 `core/src/fingerprint.mjs`：用**普通 Node fetch**（不起浏览器）取服务端 HTML 的
sha256 + ETag/Last-Modified，在 `pages/<name>/fingerprint.json` 留档。
`queue --incremental` 对已完成页逐个比对，只重排变了的。

边界写清楚了，不装作没有：**纯 CSR 站的服务端 HTML 是空壳**，空壳不变就检测不到改版。
所以指纹里带 `shell` 标记（去标签后正文 < 500 字），这类页在增量模式下一律重跑 ——
宁可多跑，不误判。诊断工具 `pnpm -C core probe:fingerprint <url...>`：
实测 excalidraw.com 判为空壳（6.8KB），thordata.com / cn.vuejs.org / ant.design 判为有正文。

### 23.3 单页熔断（含一次误杀与修复）

两条线（`core/src/task-watchdog.mjs`，注入时钟所以可单测）：
**硬超时**（`queue.pageTimeoutMs`，默认 15 分钟）与**无进展**（`queue.stallMs`，默认 6 分钟）。
到点 `taskkill /T /F` 杀**进程树** —— win32 上普通 kill 带不走 Chromium 孙进程（取消任务同理，一并修了）。

**误杀事故**：第一版的"无进展"只按 pipeline 的阶段事件计时。实测克隆 svelte.dev 首页时，
捕获阶段在下载大图（6.5MB / 3.3MB）几分钟内没有任何阶段事件 —— 它明明在干活，却被判死。
**判据错了：熔断该判"卡死"，不是"慢"。** 三步修复：

1. 引擎侧：子进程**任何 stdout/stderr 输出**都算进展（还在说话 = 还活着）
2. capture 下载循环**逐条打印**，且进度行打在**开下之前** —— 于是"沉默"就等于这一次下载卡住了
3. 单条资源加 `AbortSignal.timeout`（默认 120s，`HEIMDALL_ASSET_TIMEOUT_MS` 可调）：
   一个下不动的资源不该拖住整页

复测 svelte.dev 首页：**99.91% A**。缺的那个资源是跨域 mp4（GitHub Pages，实测 20s 才 1.1MB），
如实记进 `gaps.json`。有意思的是**差异形态正好判成「集中」** —— 形态分析把那块缺失指了出来，
而不是笼统报个百分比。两个能力互相印证。

### 23.4 仓库整治

- `console/package.json` 里 `probe:render` / `probe:diff` / `probe:shift` 三条命令
  **指向 `console/scripts/`，但脚本一直在 `core/scripts/`** —— 三条都是坏命令。
  删掉，改在 `core/package.json` 注册真实存在的（`probe:regions` / `probe:shift` / `probe:fingerprint`）。
- 删 `scripts/diff-blobs.mjs`：连通块分析已进 `differ/shape.mjs` 并在流水线里自动跑，
  留一个只做子集的 CLI 就是重复。
- **清掉四份文档里与设计决定相反的说法**：HANDOFF §7 红线、§18.8、PRD §9、USAGE §7
  还写着"严格反爬站白名单拒收" —— 与 §19.4「不内置 robots 限制」直接冲突。
  文档写了代码不做的事就是假文档。

### 23.5 新样本：Angular 翻出两个通用缺陷（都修了）

Angular 站点第一次进来就暴露两个此前所有样本都没踩到的缺陷 ——
VitePress / Docusaurus / 营销站都不带 `<base>`、也不依赖跨域图标字体。

**缺陷一：`<base href="/">` 让全部相对引用改基到站点根。**
Angular 应用在 `<head>` 里带 `<base href="/">`，浏览器据此把 `styles/cssom.css`
解析成 `/styles/cssom.css` —— 镜像页挂在 `/static/<host>/pages/<page>/clone/` 下，直接 404。
CSS 与图片**一起失效**，克隆页裸奔成无样式 HTML（实测首页像素 89.68%）。
修复：`dom-refs.mjs` 新增 `neutralizeBaseTag()`，把 href 改成 `./`（保留元素本身，
有些脚本会检测它存在），在 `build_clone` 的引用改写之后调用。

**缺陷二：跨域样式表里的字体从来进不了镜像。**
同源策略下浏览器读不到跨域样式表的 `cssRules`，所以 Google Fonts 的规则
压根没进我们序列化的 CSSOM —— Material Symbols 图标的连字名被当文字渲染出来，
页面上直接印着 `chevron_right` / `more_horiz`。
修复：`capture` 早就把"读不到"的跨域样式表记在 `cssom-refs.json` 的 `sheets[].error` 里，
`build_clone` 现在按这份清单服务端取回原文再抽（`css-refs.mjs` 新增 `extractFontRules()`）。

**这里踩了第二次坑**：第一版只抽 `@font-face`，图标**依然不显示** ——
Google Fonts 是连同辅助类一起发的：

```css
@font-face { font-family: 'Material Symbols Outlined'; src: url(...) }
.material-symbols-outlined { font-family: 'Material Symbols Outlined' }   /* ← 这条才是生效的关键 */
```

只搬字体不搬那条规则，元素的计算字体仍是 `Inter`，连字自然不成图标。
所以判据改成「`@font-face` + **凡把 font-family 指到这些族的规则**」，其余（第三方
reset、指向别的字体的规则）一律不带进来 —— 后者会打乱版面。这条判据有单测钉住。

**效果（angular.dev 两页，修前修后同页对比）**：

| 页面 | 修复前 | 修复后 |
| --- | --- | --- |
| / | 89.68% B（形态：集中） | **100.00% 像素**（TOTAL 99.7 A，静态差异 0px） |
| /ai | 86.90% B | **99.76% A**（TOTAL 99.7） |

**差异形态的判读在这两处都是对的**：修复前报「集中」（真的缺东西），修复后转「一致/混合」
——判据经此一轮反向验证。

**顺带修的**：`fetchBin` 原先只试一次，一次网络抖动就在 19 个字体引用里凭空多出一个
"不可达"缺口（实测重跑即消失）。现在**只对网络层失败重试 3 次**，HTTP 状态码与
内容问题不重试（404 再问还是 404，白等），并给单次抓取加 60s 超时。

### 23.6 本轮样本汇总

| 站点 | 技术栈 | 页面 | 像素 | 总分 | 备注 |
| --- | --- | --- | --- | --- | --- |
| svelte.dev | SvelteKit | /docs | **100.00%** | A | 一致 |
| svelte.dev | SvelteKit | / | 99.91% | A | 缺 1 个跨域 mp4（已记入 gaps） |
| angular.dev | Angular（`<base>` + 图标字体） | / | **100.00%** | A | 修复前 89.68% B |
| angular.dev | Angular | /ai | 99.76% | A | 修复前 86.90% B |

侦察各 42 页（svelte.dev 164 边、angular.dev 284 边）。
质量门：core lint 116 文件 OK，单测 **251**，控制台 build 通过。

### 23.7 回头看：这两个修复对**已有**克隆同样有效

跨域字体这条不需要重新抓取 —— 重建（build_clone）即可。盘了一遍已有产物：

| 站点 | 含 `<base>` | 含跨域样式表 |
| --- | --- | --- |
| thordata.com（31 页） | 0 | 31（都是 `accounts.google.com/gsi/style`，无 @font-face，**不受影响**） |
| vitest.dev | 0 | 1（`fonts.googleapis.com` Readex Pro，**受影响**） |
| apify.com / ant.design / crawlee.dev / cn.vuejs.org / svelte.dev | 0 | 0 |

vitest.dev 重建后：静态差异像素降到 **562px**、TOTAL **100.0**。

**顺带修掉形态判据在极小差异下的误报**：562px 只有 6 个连通块，于是
top5Share 恒为 1 → 必然判成「集中」→ 把用户支使去查几十像素的噪声。
新增 `negligible`（差异不足画面千分之一）：这个量级上"块少"是必然的，
判形态没有意义。阈值有单测，另一条单测钉住"跨过千分之一就恢复判定"，
免得把真缺失也放过去。

## 24. 2026-10-11 续十七：可用性一轮 + 审计深度（分页/分面、结构化字段、走势、真实用户指标）

### 24.1 两种镜像正名 + 交互镜像白屏的真因

用户问"死/活镜像"这两个口述名词够不够专业 —— 不够，已正式改为
**静态镜像（Static Mirror）** 与 **交互镜像（Live Mirror）**，用户可见处与文档全部替换，
代码标识符（`live` / `build_live` / `/lm/`）保持不变。两种镜像的取舍表写进 ARCHITECTURE.md §3。

**"打开像裸奔"查下来是真 bug**：引擎里那条「按 referer 溯源转发原站」的反向代理，
正则 `/\/lm\/([^/]+)\//` **要求 host 后必须跟斜杠**。而控制台的「交互镜像」链接
生成的正是 `/lm/ant.design`（首页无尾斜杠）—— 匹配不上 → 页面所有根相对 chunk
（`/xxx.async.js`）落到 SPA 兜底 → 404 → **整页白屏**。实测 ant.design 交互镜像是一张白纸。

修法两处：正则不再要求斜杠；`liveUrl` 对目录型路径补尾斜杠（URL 的基目录是最后一个
`/` 之前的部分，少一个斜杠相对引用就算错），不再依赖兜底。

**剩下的边界如实记下**：交互镜像挂在 `/lm/<host>/<path>` 路径前缀下，纯客户端渲染
（SPA/CSR）站的路由会把这段前缀当成真实路径 —— 实测 crawlee.dev / ant.design 会落到
它们自己的 404 页（apify / thordata 有本地快照，不受影响）。根本解法是每站一个子域，
但实测这台机器上 `*.localhost` 被一层代理接走（解析到 198.18.x.x），不可靠，暂不做。

### 24.2 「61/62 已克隆」是假的：分子分母来自两个集合

`/api/sites` 里 `pages` 是**侦察发现**的节点数、`forged` 是**磁盘上的克隆产物**数，
相除得到的"完成度"没有任何意义 —— apify 真正的重合只有 48 页。
现在四个数分开给：发现 / 克隆 / 重合 / 额外，界面按需取用，不再揉成一个分数。
另修一处反向计数：从 atlas 侧数重合会把 `https://x` 与 `https://x/` 算成两页，
得出比克隆页还多的重合数。

### 24.3 首屏重排 + 危险动作二次确认

原先星图顶部把**每个站点一个按钮加一个 ×** 和四个功能按钮平铺成一行：站点到八个
就折三行，选站与干活混在一起。改成 `SiteBar`（站点下拉 + 本站操作菜单 + 一行状态），
固定两个控件宽度，站点再多也不膨胀；星图与工作视图共用同一个（`SitePicker.vue` 删除）。
全量重跑、删除本站标红并二次确认；侦察输入框与五个导航按钮补上说明性 tooltip。

### 24.4 详情页：分数不该是"下载一个 JSON 自己看"

「分数 JSON」下载链接换成页内可读的还原度面板：视觉/结构/数据三项各带口径说明、
综合等级、可修与噪声拆解，原始 JSON 降级为末尾小链接。SEO 页文案同步更新
（"40+ 规则" → 66 条，并说清"侦察期轻量体检"与"完整审计"的区别）；
质检页顶部加"哪一项什么时候产生"速查表。

### 24.5 审计深度

- **分页 / 分面（6 条规则）**：分页页 noindex、站内链接带跟踪参数、分页页
  canonical 缺失/用法不一致、分页页共用 title、分面参数页无收敛策略。
  **连带发现一个真问题**：分页链接通常排在页尾，BFS 按 DOM 顺序入队会被页数配额挤掉 ——
  实测 news.ycombinator.com 30 页配额全被首页条目链接占满，`/?p=2` 一个都没进来。
  现在结构性 URL（分页/分面）优先入队。
- **结构化数据字段级校验（5 条规则）**：此前只判断"能不能解析 + @type 在不在"，
  于是一份只有 `{"@type":"Product"}` 的脚本和一份完整 Product 等价。现在按 Google
  富结果文档核必填字段（Product 要 name + image + offers|review|aggregateRating 三选一）、
  日期 ISO 格式、图片绝对地址。collect 侧把实体对象按白名单裁剪后带回（限制深度与条数）。
- **历史趋势**：`workspace/<host>/history.json`（原子写），审计与整站克隆各记一笔；
  报告页用 SVG 折线画走势，并注明"最近一次审计覆盖 N 页 —— 页数不同的两次分数不能直接比"。
- **真实用户指标（CrUX via PSI）**：做成**可选接入**，需自备 `HEIMDALL_PSI_KEY`。
  无 Key 的匿名配额是全局共享的，实测直接 429（`Quota exceeded ... project_number:583797351490`），
  所以默认不取，报告里如实写"只有实验室数据"；配了 Key 才取，并把实验室 LCP/CLS
  与真实用户 p75 并列对照。**解析逻辑有单测；取数那一步没有 Key，无法在这里验证 —— 不写成已验证。**

### 24.6 规则数不再靠人记

文档里那句「N 条规则」写错过两次（"40+" → "56"，按源码数只有 54）。
新增 `core/test/seo-rule-count.test.mjs`：从源码数出规则 id，断言总数（现 66）、
断言 id 不重复、断言分类前缀都在 CATEGORIES 里。改规则时这条会红，逼着同步文档与界面。

### 24.7 本轮实测与诚实边界

- 交互镜像：apify / thordata / cn.vuejs.org / svelte.dev / angular.dev / vitest.dev 都能返回
  正确页面。**但"渲染正常"这句当时是看 HTML 得出的，不足为凭** —— 见 §25：
  这些页面的 JS 其实一个都没跑起来，纯 CSR 站（vitest.dev / crawlee.dev / ant.design）
  当时落到的是它们自己的 404 页
- 分页规则在真实站点上是**干净的负例**：HN 的 `/?p=2` 被采到了，它自带自指 canonical、
  也不 noindex，所以不该报 —— 规则确实没报
- **尚未在真实站点上取到分页/分面的正例**（我们的样本站没有这些反模式；试过的
  blog.jetbrains.com 分页是纯 JS 驱动）。规则的接线由 `seo-rules-integration.test.mjs`
  从 `evaluatePage`/`evaluateSite` 两个真实入口钉住（6 条），而不是只测子模块

---

## 25. 2026-10-11 续十八：交互镜像其实一直没"活"过 —— 响应头静默丢失 + 独立域名入口

起点是用户的一处观感：vitest.dev 的交互镜像里，赞助商 logo 与两张卡片的配图是空的。

### 25.1 真因：`writeHead` 不认 WHATWG `Headers`，且不报错

三处代理（`/px/`、referer 兜底、镜像）都是这么写的：

```js
const headers = new Headers();
for (const [k, v] of upstream.headers) { ...; headers.set(k, v); }
res.writeHead(upstream.status, headers);        // ← 全部头被静默丢掉
```

Node 的 `writeHead` 只认普通对象或扁平数组。传 `Headers` 进去**不抛错、状态码照样正确**，
只是所有头消失。实测对照：

```
WITH Headers  -> ct: null      x-test: null
plain object  -> ct: "text/plain"  x-test: "1"
```

### 25.2 后果比"图片缺失"严重得多

Content-Type 为空后：浏览器以 `MIME type of ""` 拒绝执行模块脚本 —— vitest.dev 的
**7 个 module script 全部被拒**，也就是说**交互镜像的 JS 从头到尾就没跑起来过**。

之所以长期没被发现：PNG/JPG 靠魔数嗅探仍能渲染，页面的静态 HTML 又是对的，
于是症状只表现为"个别图挂了"（而丢的正好是 SVG —— SVG 必须有正确 MIME）。
§24.7 里"渲染正常"的结论就是这么得出来的，已在原处更正。

### 25.3 修好之后立刻暴露第二层：前缀进了 SPA 的路由

JS 一旦真的跑起来，vitest.dev（VitePress）整页变成 **"404 | Vitest"** ——
路由库读 `location.pathname`，看到的是 `/lm/vitest.dev/`，匹配不到任何路由。
这与 ROADMAP 里早就记下的"路径前缀边界"是同一件事，当时判断"暂不做"。

### 25.4 于是把独立域名入口做了

- `mirrorHostOf(host)`：`<host>.localhost` → `<host>`（用完整域名当子域，可无损还原）
- `serveMirror(req, res, u, host, prefix)`：两个入口共用同一份逻辑
  - 独立域名：`prefix=''`，pathname 即站点路径 → CSR 路由、cookie、localStorage 全对
  - 前缀入口：`prefix='/lm/<host>'`，字符串切片得到同样的 rest
  - 独立域名下服务本地快照时，把烘焙进去的 `/lm/<host>/` 前缀摘掉
  - 两处仍走引擎自己的分支：`/static/`（本地快照引用的 CSS/资产），其余全透传
- 修 ROADMAP 里那个"暂不做"的理由：当初怕 `*.localhost` 被代理接走（解析到 198.18.x.x），
  实测这台机器上 fake-IP 代理会把 `vitest.dev.localhost:8900` 转回 127.0.0.1 且 **Host 原样保留**。
  两个入口并存：控制台「交互镜像」走独立域名，旁边一个「/lm 备用」。

### 25.5 顺带修掉的

- **POST 不再被本地快照吞掉**：此前只要该路径有 live 快照就直接回文件，表单 POST
  会拿到 HTML、什么也不发生。现在只有 GET/HEAD 回快照，其余回源
- **首屏新增「只克隆此页」**：克隆与侦察在引擎侧本就互不依赖（`/api/forge` vs `/api/recon`），
  但界面只有「侦察」一个入口，"我只要这一页"的人被迫先侦察整站
- **交付包正名**：`node src/live/export.mjs <host>` 产出的是**交付包（Deliverable Bundle）**，
  与"静态镜像/交互镜像"（单页产物）是两个层次；再克隆几页后重新导出即全量。
  舍入 ARCHITECTURE.md §3

### 25.6 实测与诚实边界

- 修好后逐站核对（走独立域名入口的 `<title>`）：ant.design / vitest.dev / svelte.dev /
  apify.com / thordata.com / cn.vuejs.org / angular.dev / blog.jetbrains.com 全部返回原站标题；
  crawlee.dev 无本地快照（纯代理）返回 53589B，与原站直连字节数一致
- vitest.dev 交互镜像：`img` 坏图 **0**，`/vercel.svg` 带 `image/svg+xml`，脚本执行（截图见
  `workspace/_shots/live-subdomain-sponsors.png`）
- **未验证**：没有代理且系统不认 `*.localhost` 的环境下独立域名入口是否可达（本机测不了）。
  那种环境用前缀入口，CSR 站仍会落到它自己的 404 —— 这是本轮的已知边界
- 测试 **320/320**（新增 `test/proxy-headers.test.mjs` 6 条，含一条"Node 若支持 Headers
  就变红"的前提断言）· lint 128 文件

### 25.7 顺手挖出的第二个通用缺陷：协议相对 URL 被当成根相对

导出 ant.design 交付包时，体检报 8 个 unresolved，形态是
`/at.alicdn.com/t/webfont_….woff2` —— 少了一个协议、多了个 `/lm/ant.design` 前缀。
原始 HTML 里是 **`//at.alicdn.com/…`**（协议相对，浏览器会补成 https://）。

`build_live.mjs` 的根相对改写（`"/` → `"/lm/<host>/`）没排除第二个斜杠，
于是把它改成了 `/lm/ant.design//at.alicdn.com/…` —— 指向本机根目录、永远 404。
静态镜像那侧一直是 `startsWith('/') && !startsWith('//')`（dom-refs.mjs:117），
只有 live 这条路径漏了；bootstrap 里运行时那份 `px()` 也漏了，一并补上。

改写逻辑抽成 `src/live/live-html.mjs`（build_live 是顶层就执行的脚本，import 即跑，
抽出来才可测），新增 `test/live-html.test.mjs` 6 条钉住"协议相对必须原样保留"。

实测：ant.design 重建 live 后 webfont 引用恢复成 `//at.alicdn.com/…`；
交付包 unresolved **8 → 0**。

### 25.8 交付包实测（回答"能不能丢给同事单独部署"）

`node src/live/export.mjs ant.design` → `deliverable/ant.design-live-2026-10-11/`
（75 文件 / 3.2MB：serve.mjs + har.json + site/ + landing.html + Dockerfile/compose + checksums）。
即使该站**只有 1 个克隆页、没有侦察**也能导出。起 `node serve.mjs --port 8080` 实测：
落地页 200、`/lm/ant.design/` 返回原站标题、`/__heimdall/health` 可用。

- **给纯前端站部署时必须 `--root mirror`**（镜像挂在根路径）。默认的 `--root landing`
  会把页面放在 `/lm/<host>/` 前缀下，CSR 路由同样会渲染成该站自己的 404 ——
  这条已写进导出包 README
- 增量：再克隆几页后**重新导出**即全量；包是重新生成的，不做"往已部署实例里打补丁"。
  当前每次导出生成一个日期目录（`deliverable/` 的保留策略见 StorageCard）

### 25.9 评估 `ai-website-cloner-template`：不吸收代码，只吸收知识

判据是"它做了什么而我们没有"，逐文件读过之后的结论：

- **它是什么**：48 个文件 / 4360 行，`src/` 只有一个 `layout.tsx`、`page.tsx` 与一个
  shadcn 按钮 —— 一个 Next.js starter，外加驱动 agent 的提示词
  （`.agents/skills/clone-website/SKILL.md` 与两份 reference，合计 145 行 markdown）。
  没有爬虫、没有 LLM 调用、没有抓取/截图实现，抓取由 agent 用浏览器工具人工完成。
- **结论：不吸收**。它产出的是"AI 手写的、可维护的 Next.js 源码"，我们产出的是
  "可测量的镜像 + 评分 + 审计"。两者是不同物种，引入它的模板等于放弃我们唯一的差异
  （确定性、可复现、有分数）。它那里的资产规则是"人工核对"，我们是
  `magic bytes > Content-Type > 后缀`（asset-ext.mjs）；多视口它靠手扫，我们是自动三视口。
- **值得吸收的是它的领域知识**（都是小改动，尚未实施，记在这里免得丢）：
  1. **动效按驱动源分类**（时间/滚动揭示/连续滚动/点击悬停/指针画布 → 证据 → 实现），
     把我们的 `dynamicShare` 从"有/无"变成"哪一类"
  2. **Lenis 探测**（`html.lenis` / `window.lenis`）：平滑滚动会影响滚动截图与交互回放
  3. **后缀≠实际类型**告警（CDN 拿 AVIF 冒充 PNG）——我们已按真实类型落盘，可补进缺口清单
  4. **Framer 站按 `data-framer-name` 分段**，且只读可视变体而非全部节点
  5. **"先滚动到揭示段再截图/交互"**的纪律（我们把 canvas 做了，可推广到所有揭示内容）

---

## 26. 2026-10-11 续十九：0 代码闭环（登录 / 交付）+ 动效驱动画像

### 26.1 需要登录的站点：人工登录一次，机器复用

`src/session/store.mjs` + `src/session/login.mjs`。第一性原理写在 `docs/DELIVERY.md` §6：
身份只存在于浏览器里（cookie / localStorage），而短信码、2FA、扫码、SSO、人机验证
既自动化不了也不该去绕 —— 所以路线是**开一个真浏览器让人自己登**，我们把
`storageState` 存到 `workspace/<host>/session.json`，之后侦察 / 克隆 / SEO 审计 /
多视口验证全部自动带上（`sessionContext()` 直接展开进 `newContext()`，调用点不写 if）。

- **每 2 秒存一次**，不是为了频繁写盘，而是为了"用户直接关掉整个浏览器窗口"时
  最后一份仍然可用（进程一起没了，来不及在退出前保存）
- 落盘用同目录 rename（原子）：读者要么看到旧的、要么看到新的
- **安全**：`session.json` 等同凭据 —— 只在本地 workspace（`.gitignore` 覆盖，不进 git）、
  **不进交付包**（`live/export.mjs` 是白名单式拷贝，已加注释钉住）、
  HAR 里的 cookie/authorization 早已被清洗
- **诚实边界**：storageState 不含 sessionStorage / IndexedDB / Service Worker，
  HTTP Basic/Bearer 也不在覆盖范围。**未在真实凭据站点上验证过**（我们手上没有账号）
  —— 机制有单测（9 条），端到端要等有真实登录场景时再跑
- 控制台：本站操作 →「登录并保存会话」（菜单文字会带会话年龄）；侦察只抓到 ≤1 页时
  直接提示"若该站需要登录，先登录再侦察"

### 26.2 交付：路径、复制、打开文件夹

- `/api/live-health/:host` 增加 `bundlePath`（绝对路径）
- 新增 `POST /api/reveal {path}`：在资源管理器里定位产物。**只接受 DATA_ROOT 以内的路径**
  （实测 `{"path":"C:/Windows"}` 被拒）
- 控制台「交互镜像」卡片显示交付包绝对路径 + 「复制路径」「打开文件夹」，
  并写明交给同事要跑哪两条命令（`node serve.mjs --port 8080` / `docker compose up -d`）
- 交付本身该怎么做（重新导出 vs 打补丁、增量的三层做法）见 **`docs/DELIVERY.md`**，
  结论是**不做补丁协议**，把增量压到传输层：稳定输出目录 +（未做）差异清单 + 校验和

### 26.3 动效驱动画像（吸收 framer-and-motion 的分类学）

新增 `src/crawler/motion.mjs`，capture 阶段（滚动扫掠之后、冻结之前）采一次，
落 `motion.json`，引擎的 `/api/pages` 带出来，控制台质检页显示。
五类驱动：时间 / 滚动揭示 / 连续滚动 / 状态变化 / 指针画布，每类都带**我们的处置方式**
（冻结 / 滚动后采集 / 光栅化 / 计入噪声），因为分类不落到处置上就没有意义。

**踩到的坑值得记下来**：第一版只用 `document.getAnimations()` 采瞬时快照，
实测 svelte.dev 采出来是**零动效** —— 而我们的采集时机（扫掠 + 静置之后）恰好是
入场动画都播完、什么都没在跑的那一刻。是**采样方法错了**，不是页面没有动效。
改成在页面脚本之前装累计观测器（`animationstart` / `animationiteration` /
`transitionrun` 事件 + WAAPI 的 `Element.animate` 打点），同一页面立刻采到
`fade-in ×1` 与 `[waapi] div.banner ×2`。

**仍采不到的**：只在悬停时才存在的过渡（不交互就不触发），已在报告口径里写明。

### 26.4 本轮实测与质量门

- 真实 capture 端到端跑通（svelte.dev），motion.json 有真数据
- 交付包路径 / 会话状态 / reveal 边界三个接口实测；控制台 UI 实测（菜单项 + 卡片 + 两个按钮）
- 测试 **346/346**（新增 motion 11 条、session 9 条）· lint 135 文件

---

## 27. 2026-10-11 续二十：页面清单的重复、克隆档案的数字、克隆 tab 的空面板、交付包差异清单

### 27.1 同一页出现两行：尾斜杠没归一（真 bug）

用户侦察 ant.design 后看到"一模一样的路径"。根因：`https://x/` 与 `https://x` 是同一页，
却是两个不同字符串 —— 星图里两颗重叠星球、清单里同名两行；而产物目录名是按
**去尾斜杠的 path** 算的（`pageNameOf` / `pathOf`），所以克隆其中一条会让另一条也显示"已克隆"。
实测 ant.design：32 个节点里 4 组重复（`/`、`/components/overview`、两条 `/docs/*`）。

- 引擎侧：原本只有**种子 URL** 做了 `.replace(/\/$/,'')`，站内链接与 sitemap 没做 ——
  意图是对的，应用得不一致。抽成 `src/url-canon.mjs`（recon 与 seo/collect 共用一份实现），
  三个入口全部归一
- 控制台侧：**实时侦察的 SSE 路径**当时也没去重（只有侦察结束读 atlas 的 `buildStatic` 去了重），
  所以页面在侦察过程中就会重复长出来 —— 统一到 `urlKey()` 一处
- 实测重新侦察：42 个节点 / 42 个不同 path / 0 组重复 / 0 条带尾斜杠
  （页数从 32 涨到 42，因为配额不再浪费在重复页上）

### 27.2 「克隆档案 · N 页」显示的是侦察页数（口径错）

那个链接指向**克隆档案**（静态镜像的索引页），数字却取的是 `hudPages`（侦察抓到的页面数）——
于是刚克隆完一页这个数字纹丝不动，看着像"没算进去"。改成 `doneCount`（已克隆页数），
侦察页数放进 tooltip。**两个数属于不同的集合，从一个跳到另一个会骗人**（与 §24 的 61/62 同类）。

### 27.3 克隆 tab 点进去是空的；克隆过程中看不到任何进展

两个问题一起修：

- **空面板**：任务结束或刷新过页面之后，这个 tab 只剩一个「重新克隆」按钮 ——
  而磁盘上明明躺着两张可直接对比的截图。现在常驻**证据区**：原站 / 静态镜像并排，
  带 cache-buster（重新克隆后必须刷新）
- **看不到进展**：整页克隆要几分钟，此前界面上唯一的变化就是阶段条上一个圆点变色。
  现在加**实时运行窗**：已用时间 + 子进程正在打印的日志（尾部 14 行）
- 为此引擎要把子进程输出流出来：`emitLog()` 把非 `@@EVENT@@` 的 stdout/stderr 行
  作为 `{kind:'log'}` 推给 SSE。**故意不走 `push()`** —— push 会把每个事件写进 sqlite，
  而捕获阶段每下一张图就打印一行，一次整站克隆上万行，进数据库纯属糟蹋。
  日志只留内存环缓冲（200 行），SSE 重放时先日志（过程）再事件（状态）

### 27.4 交付包差异清单 `changes.json`（round 2 的"要继续做"）

见 `docs/DELIVERY.md` §5：**不做补丁协议**，把增量压到传输层。缺的那一环补上了：

- `src/live/changes.mjs`（纯函数、8 条单测）：两份 checksums 做差集 →
  新增 / 变化 / 删除 / 不变 + 计数 + 上一次导出的时间
- 导出时写进包里，控制台卡片直接显示「与上次导出相比：新增 0 · 变化 1 · 删除 0 · 不变 181」
- **踩到的两个坑**：① 上一次的校验和必须在**目录被清空之前**读
  （同一天重导落在同一个目录，清完再读就只能和自己比，表现为永远"首次导出"）；
  ② `checksums/changes/health/heimdall-live` 四个根级元数据文件带时间戳、每次必然不同，
  必须排除，否则用户每次都看到"变化 4"，真正关心的"页面变了没"被噪声淹没
  （`har.json` 因记录本次请求时间，报"变化"是正常的，已在 note 里写明）
- 实测：连导两次 → 第一次「变化 2」，第二次「变化 1（har.json）· 不变 181」

### 27.5 本轮实测与质量门

- 归一化：重新侦察 ant.design 实测无重复；`/api/pages` 无同 target 重复
- 实时日志：SSE 实测有 `{kind:'log'}` 事件流
- 克隆 tab：控制台实测并排截图与两个 CTA 都在
- 交付包差异：连导两次的 counts 已在上
- 测试 **359/359**（+13：url-canon 5、live-changes 8）· lint 139 文件

---

## 28. 2026-10-11 续廿一：校准曲线补齐 + 一次真审计（发现凭据泄露与死按钮）

### 28.1 AI 校准：曲线其实一直在盘上，缺的是"为什么没跑"

`fixup-history.json` 本来就写了（`{best, rounds:[{round,before,after,kept}]}`），
控制台的**质检 tab** 也读了 —— 用户觉得"一结束就没了"，是因为它换了个 tab 出现。
真正的缺口是：三条提前返回（模型未启用 / 缺产物 / 可修性门控）**什么都不写**，
于是界面上只剩一个空的"AI 校准"格子，用户分不清"校准跑了但没改动"和"压根没跑"。

- `fixup.mjs` 新增 `writeSkip()`，三种跳过原因落盘（含人类可读的 detail）
- 克隆 tab 也显示校准结论：有轮次就画曲线，没有就写原因
- 实测：正常路径写出 rounds；`HEIMDALL_LLM=0` 时写出 `{skipped:'llm-disabled', detail:…}`

### 28.2 审计发现的问题（这才是本章的重点）

两路并行只读审计：控制台体验 + 引擎健壮性/安全。**都是可验证的问题，不是风格意见**。
其中三条最刺眼：

1. **`/static/<host>/session.json` 把登录凭据原样发出去**（我上一轮加的登录态功能带来的）。
   `network.har` 同样：**工作区里那份是未脱敏的**（带 cookie/authorization），
   交付包里那份才是清洗过的。任何 HTTP 客户端都能拉走。`HEIMDALL_TOKEN` 也拦不住
   —— 它只覆盖 `/api/` 与 `/px/`。
2. **详情面板的「开始克隆此页」是个死按钮**：模板绑了 `@open-forge="openForge"`，
   而**这个函数从来没定义过**。Vue 模板里的一切都是运行时属性查找，编译器不报错，
   点下去只有一条 TypeError。
3. **切站之后数字串台**：`/api/pages` 的响应晚于切站返回时，会把上一个站的分数写进
   本页的 `pageScores`（按 nodeId 存，两边同号就串）—— 实测切到一个没有克隆页的站点，
   表头显示"平均视觉 99.1%"。另外 61 页的站点第一眼会显示"0 页已克隆"（数据还没到）。

### 28.3 本轮修掉的

- `/static/**` 与 workspace 兜底：拒绝 `session.json` / `network.har`（实测 403 / 不服务）
- `/api/reveal`：前缀判断改成 `relative` 包含判断（`DATA_ROOT\..\..\x` 此前能过）
- 请求体上限 8MB（此前十来个 POST 处理器各自累加、都没有上限）→ 实测 413
- 任务对象 LRU 淘汰（`events`/`logs` 只涨不消）
- `openForge` 补上；并加 `test/console-handlers.test.mjs`：扫模板里所有 `@event="名字"`，
  断言名字在**同文件里被定义过**。**第一版守卫是废的** —— 它只查"这个名字出现过"，
  于是把名字写在注释里也算通过，实测把函数改名后测试依然全绿；改成必须匹配
  `function NAME` / `const NAME =` 之后才真的能红（本次就是这么验证的：改名 → 红 → 改回 → 绿）
- 切站竞态：`loadPageStatus` 记下发起时的 host，响应回来若已切站就丢弃；
  并新增 `pagesLoading`，数字没到之前显示"统计中…"而不是 0
- 报告页三张卡（克隆档案 / 同步滚动对比 / 竞品情报包）不再恒给可能 404 的链接，
  改读引擎的 `available` 与真实 URL；盘点失败时 `/api/sites` 返回 500 而不是空清单
- 术语：`kindCn` 补 upgrade/storage/deliver（此前任务中心把"响应式升级"显示成"克隆"）

### 28.4 还没做的（按用户可感知收益排序，供下一轮选）

1. 清理已确认的死代码（未用导入/computed/CSS 类、`tokenOf` 两份实现、`STAGES` 两份映射）——小
2. 资产扫描 / 镜像导出 / 对标矩阵无进度（静态文案"约 2-5 分钟"）——中
3. 长任务中断后续跑的可视化（任务中心只显示"运行中"）——中
4. 键盘可达性：排序表头是 `<span @click>`、纯图标按钮无 aria-label、进度无 aria-live——中
5. 引擎：`/api/assets`、`/api/sites`、`/api/pages` 在请求线程里同步遍历磁盘（会冻住事件循环）——中
6. 侦察节点 id 按完成序分配 → 两次侦察的 atlas.json id 不同（确定性问题）——中
7. 部署包 `serve.mjs` 默认监听全网卡（引擎侧是显式绑回环，两处不一致）——小，但要考虑 Docker 场景

### 28.5 质量门

测试 **367/367**（+6：handler 守卫 2、路径守卫 6 —— 含一条"前缀判断确实会放行 `..`"的前提断言）
· lint 141 文件 · 四项安全修复逐条 curl 实测

---

## 29. 2026-10-11 续廿二：⊕ 六项体验/工程优先级（全部落地）

用户要求"按上一轮列的优先级直接开始做"。本轮把 §28.4 的六条 + 一次全面核查做完了。
**过程中自己制造并修好了一个崩溃**（见 §29.3），那条反而成了本轮最有价值的收获。

### 29.1 长任务的可恢复性（原优先级 1）

`queue.mjs` 本来就能续跑（`queue.json` 跳过已完成页），缺的是**让用户知道这件事**。

- 新端点 `GET /api/queue/:host` → `{total, done, failed, pending, queued, unfinished, active}`
- 控制台「本站操作」在 `unfinished > 0` 时多出一项
  **「继续整站克隆（剩 N 页）」**，点击即 `clone-site {incremental:true}`（续跑不重头）
- 任务中心的历史行：`interrupted`/`failed` 且 kind 为 `clone`/`forge` 的，
  多一个 **「继续克隆 / 重新克隆」** 按钮 —— 引擎重启把 running 标成 interrupted 之后，
  这就是用户唯一需要的出口
- **实测**：用 `page.route` 伪造一条 interrupted 的 clone 历史，界面上确实出现
  「继续克隆」，且只有它一条（`canRetry` 不误伤 done/cancelled）

### 29.2 进度与预计时间（原优先级 2）

三个长任务此前只在**结束时**发一个事件，过程中只有静态文案"约 2-5 分钟"。

- `audit/assets.mjs`：`asset-gaps-start` + 每页 `asset-gaps-page {index,total}`
- `seo/matrix.mjs`：`matrix-start` + 每站 `matrix-site {index,total,phase}`
- `live/export.mjs`：`live-stage {stage,status,index,total}`，覆盖
  生成镜像页 → 拷贝资产 → 合并 HAR → 补齐缺口 → 本地化资源 → 离线体检 → 打包校验
- 控制台把这三个事件接成 `task.progress`，任务中心直接显示 `n/total` 或阶段名
- 验证/监控/审计/响应式升级**本来就有**进度事件，不在缺口内（对照后确认）

### 29.3 引擎同步 IO（原优先级 5）—— 顺带撞出一个崩溃

- `/api/assets`：整个遍历（每页资产树 + asset-map）进缓存。
  **实测 cold 2.03s → warm 0.008s（约 267×）**
- `/api/sites`：整段进缓存；**顺带修掉"每页 manifest.json 被读两遍"**
  （重合统计与 origin 兜底各一个循环，合并成一次读）
- 代理白名单 `isProxyHost`：从"每请求 stat"改成"列一次目录得到集合"（同样的缓存），
  顺带更安全 —— 只有目录里真实存在的名字能命中，`..` 类构造永远匹配不上
- `/api/atlas/:task`：`readFileSync` 改成 `createReadStream().pipe(res)`
- 缓存策略：8s TTL **+ 任何任务结束即 bust + 删站/删页即 bust**。
  光靠 TTL 会让"刚克隆完打开资产页还是旧的"变成新 bug
- **崩溃**：改 `/api/assets` 时把 `orphanReport` 圈进了缓存回调的作用域，而它在回调外
  仍被引用 → `ReferenceError` 在请求处理函数里抛出 → **整个引擎进程退出**，
  所有接口一起没。修掉之后加了兜底（见 §29.3b）
- **29.3b 兜底**：`createServer` 的回调改名 `handleRequest`，外层包一层
  `Promise.resolve(handleRequest(...)).catch(...)` —— 任何路由抛异常只让**这一个请求**
  变 500，不再带崩进程。这不是假想的防御：本轮就是被它咬到的

### 29.4 无障碍（原优先级 4）

- **live region**：主状态行 `role=status`（占位 `/api/...` 进度都走它）、
  错误 toast `role=alert`、成功 toast `role=status`、"统计中…"、
  克隆实时日志 `role=log`（计时器 `aria-hidden`，否则读屏每秒念一次）
- **对话框**：详情面板补 `role=dialog aria-modal` + 打开时聚焦关闭按钮 +
  Tab 在面板内循环 + 关闭时把焦点还给打开它的元素（**实测通过**）
- **标签页**：`role=tablist/tab/tabpanel` + `aria-selected` + 方向键/Home/End
  （**实测：ArrowRight 让 `overview → seo`**）
- **排序表头 / 菜单**：`.sortable` 与 `.wv-url` 补 `role=button tabindex=0` + 回车/Space
  （**实测：回车让 `aria-label` 从"当前升序"变"当前降序"**）；本站操作菜单打开即聚焦首项、
  上下键移动、Esc 把焦点还给按钮（**实测通过**）
- 星图 canvas 补 `role=img` + 说明（并指明"逐页清单见「页面」视图"是键盘路径），
  不做伪造的键盘导航
- 图标按钮补 `aria-label`（收起仪表面板、展开/收起任务中心 + `aria-expanded`）

### 29.5 死代码与重复实现（原优先级 3）

- **`emit` 12 → 1**：新建 `src/emit.mjs`，用 codemod 把 12 个脚本的复制件换成 import
  （queue.mjs 那份"仅 --json-events 时输出"的分叉也收进同一处）
- **`readJson` 5 → 1、`mb` 5 → 1**：新建 `src/fsutil.mjs`；`mb` 此前已开始分叉
  （`n/1048576` 与 `n/1024/1024`）
- **`tokenOf` 2 → 1**（Atlas.vue 改从 api.js 导入）、
  **`STAGES` 2 → 1**（DetailDock 模板改用已有的常量）
- 死导入 7 个（Atlas.vue：apiJson/fmtTime/fmtDate/fmtBytes/fmtDuration/liveUrl/typeCn）、
  死变量 3 个（liveHealthHost / detailSeo / openDetail / DetailDock 的 pageName）、
  死 CSS 6 组（`.sr-only` `.num` 整个 `.pages-list` 家族 `.seek-caret` `.set-note` `.stage.skipped`）
- **`pageNameOf` 的"两份实现"是误报**：console 与 core 各一份，跨运行时，属既有约定
  （pages.js 顶部已注明），不动

### 29.6 确定性（原优先级 6）

- 侦察节点 id 此前是 `n${idSeq++}`，而 visit 是 **3 路并发** —— 谁先加载完谁拿小号。
  同一个没变的站点侦察两次，得到两张 id↔url 对不上的 atlas
- 改为 `stableNodeId(url)` = `n` + sha1(url) 前 8 位（实现与理由落在 `src/url-canon.mjs`，
  **可单测**）；落盘前对 nodes 按 url、edges 按 (from,to) 排序
- 顺带清掉星图 thumbs 里不属于本次星图的孤儿 png（id 换算法后旧文件会留下）

### 29.7 新增守卫

- `core/test/emit-protocol.test.mjs`：**只有 `src/emit.mjs` 能直接写 `@@EVENT@@`**。
  已验证会红（临时放一个内联写的文件 → 测试报出它 → 删掉即绿）
- `core/test/url-canon.test.mjs` +2：stableNodeId 的顺序无关性与格式稳定性

### 29.8 质量门

测试 **371/371**（+4）· lint 144 文件（+2：emit.mjs / fsutil.mjs）·
控制台 `vite build` 通过 · 浏览器逐条实测（对话框焦点、标签页方向键、排序表头回车、
菜单键盘、伪造历史行的续跑按钮）· 引擎冷/热缓存耗时对照（2.03s → 0.008s）

### 29.9 还没做的（更新后）

1. **`POST /api/storage/gc` 与 `DELETE /api/sites/:host` 仍同步扫 CAS**（约 0.5s）——
   同一教训的漏网，应照 `startStorageScan` 挪进子进程
2. **`/api/pages/:host` 的首次遍历**仍在请求线程（有 mtime 缓存，只在新克隆后触发）
3. **交付包的"可改"程度**：资源清单 / 文案清单 / 域名替换 —— 数据都算过，
   缺的是组织成用户视角的入口（详见 `docs/DELIVERY.md` §7）
4. **控制台 E2E 测试**：改界面现在只能手工点验
5. **首启向导**：新用户第一次打开不知道该做什么
6. **部署包 `serve.mjs` 默认监听全网卡**（引擎侧显式绑回环，两处不一致）
7. `argOf` / `getNum` 的重复（2 处 + 4 处 + 若干变体）尚未合并

---

## 30. 2026-10-12 续廿三：改站起点 + 剩下的工程项

用户的问题定调了这一轮：「用户想做某个网站的竞品，我应该给的是交付包吗？……
为了实现这个价值，我们的项目还有哪些方面做不够好？」

结论记在 `docs/DELIVERY.md` §7：交付包给的是**起点**不是成品（数据/业务逻辑/版权三条边界），
而这条路径上真正卡住的不是算法，是**信息组织** —— 数据早就算出来了，只是没按"要改什么"摆出来。

### 30.1 改站起点清单 `src/deliver/edit-manifest.mjs`

把已有产物重排成三张表（**不新增任何抓取**）：

- **域名**：原站域名出现在哪些文件的哪些位置（只数渲染文本，跳过 json 里的来源记录）
- **资源**：原始 URL ↔ 本地路径 ↔ 用在几页 ↔ 大小 ↔ 类型，按被引页数排序；
  并单独挑出"仍是外链、页面上看得见"的视觉资产（必须处理的那一批）
- **文案**：每页标题 / 描述 / H1 / CTA / 价格

产出 Markdown（给人看）+ JSON（给机器）；`deliver.mjs` 与 `live/export.mjs` 两个包都带它，
两份 README 各加一节「要换成自己的站？从 edit-manifest.md 开始」，带真实读数。
实测 apify 61 页 → 4032 资源 / 域名 4849 处 / 约 4.8s，所以**走子进程 + 任务**，
控制台「报告 → 改站起点」卡片触发。

### 30.2 域名替换 `src/deliver/replace-domain.mjs`

会写用户产物，所以设计从严：

- **默认预览，不写任何文件**；真改要显式 `--apply`，且逐文件备份到
  `deliver/_domain-replace-backup-<stamp>/`（附还原说明）
- **主机名边界匹配**：命中自身与子域（`cdn.example.test` → `cdn.mysite.com`），
  不误伤 `xexample.test` / `example.testfoo`
- **绝不碰 json**：asset-map / ref-index 里的域名是"来源记录"，改了资源查找表就废了
- 实测：apply → 替换 → 从备份还原，md5 与原始**逐字节一致**

控制台是两段式：预览 → 确认替换。踩到一个自己的坑：预览里的"含主机名"用
`[a-z0-9.-]*from` 匹配，把 `xexample.test` 也算了进去（它只是结尾长得像，不是子域）——
替换本身没错，但读数会骗人。改成"先取候选主机名，再按 `= from` 或 `.from` 结尾过滤"。

### 30.3 引擎请求期同步 IO 收尾

- `/api/assets` 与 `/api/pages` **共用同一份资产索引**（同一批文件此前各走一遍）；
  索引抽出 `assetIndex(host)`，`byPageAssets` 只统计 clone/assets 以保住「资产」列口径
- CAS 回收（`/api/storage/gc`、删站、删页）改走 `audit/cas-gc.mjs` 子进程 + 任务，
  结果以 `cas-gc` 事件回来；控制台 StorageCard 改走 SSE。实测「预览：可回收 703.9MB」
- 删掉随重构失效的 `pageMetaCache`

### 30.4 CLI 参数解析 12 → 1，以及一个**只会在交付之后炸**的 bug

`argOf`/`getNum`/`has` 在 12 个脚本里各写一遍，而且已经分叉（有的版本
`--api --token x` 会读出 `--token`）。收进 `args.mjs` 的 `makeArgs`。

**但 `live/serve.mjs` 是个例外**：它会被原样拷进交付包，而包里只有 serve.mjs 与 har.mjs。
顺手把它也改成 `import '../args.mjs'` 之后，仓库里一切正常、单测全绿 ——
**一导出成包就 `Cannot find module`**。这是我第二次被"改完就顺手上"咬到。

对策不止是改回去，而是加了一条守卫：`core/test/bundle-selfcontained.test.mjs` ——
交付包里的脚本只允许 import `node:` 内建或同目录文件。已验证会红
（把坏 import 放回去 → 测试报出它 → 改回即绿）。

### 30.5 首启向导

一个站点都没有时，星图是空的，用户不知道下一步做什么。空态里写清"侦察 → 克隆 → 拿走"
三步，并提示需要登录的站点先去「登录并保存会话」。用桩掉 `/api/sites` 的响应实测过。

### 30.6 交付包监听地址

`live/serve.mjs` 一直 `listen(PORT)`（所有网卡），但日志永远打印 `127.0.0.1` —— 会误导人。
现在默认仍是 `0.0.0.0`（交付包是拿去部署的，绑回环外面访问不到），但日志把实际地址说清楚，
并提供 `--host 127.0.0.1`。实测 netstat 确认两种情况的绑定。config 里写明 `bind`，
README 说明"与引擎默认不同是有意的"。

### 30.7 控制台 E2E（这块此前一个测试都没有）

`core/test/console-e2e.test.mjs`：起**真引擎**（临时数据目录 + 最小 fixture 站点）+
**真 Chromium**，断言星图可访问名、站点清单、排序表头键盘操作、详情面板对话框语义与 Esc、
改站起点卡片、全程无未捕获异常。2.2 秒跑完。

**已验证会红**：把构建产物里的 `aria-modal` 改掉 → 测试失败 → 改回即绿。
没构建 `console/dist` 时跳过并**说明原因**（静默通过比没有测试更糟）。

### 30.8 质量门

测试 **385/385**（+14：改站清单 5、域名替换 6、交付包自包含 2、控制台 E2E 1）·
lint 149 文件 · `vite build` 通过 · 浏览器逐条实测 · 交付包导出后能正常起服务

### 30.9 还没做的

1. `/api/assets` 的索引仍是请求线程现算（已降到"每 8 秒最多一次"，超大站首次仍占一两秒）
2. 首启向导只在星图空态出现（已有站点时想从零再起一个没有引导）
3. 改站路径继续加深：就近打开资源、替换后自检
4. 设置页仍在 `Atlas.vue` 内（拆之前要先把 LLM 表单状态做成 composable）

---

## 31. 2026-10-12 续廿四：交互镜像其实一直被自己的截图工具冻着 + 动效三层说清

用户的问题：「动效：JS 驱动的动画不逐帧复刻」，为什么不做？能实现复刻吗？
查这条边界的时候，撞出一个比它更大的问题。

### 31.1 交互镜像里所有 CSS 动画与过渡都是死的 —— 我们自己的截图工具干的

冻结样式（`animation-duration: 0s !important`）是为了让**截图**可复现才注入的：
动画在飞的时候，原站和镜像各截各的，比出来的是时序差不是相似度。

但 capture 的顺序是「注入冻结 → 截三帧 → 抓 dom.html」，而交互镜像正是从 dom.html
生成的 —— 于是每一页镜像都带着这份样式。**实测 apify 61/61 页中招**，
hover 过渡全是瞬移。这个产物卖的就是"能跑起来看动效"，自相矛盾。

- 冻结样式收进 `src/freeze.mjs` **唯一来源**（原本 6 份复制粘贴，差异是
  swiper 归位与同意弹层隐藏两个可选叠加项，现在按名字点名）
- capture 写 dom.html 时 `stripFreeze()` 剥掉；`build_live` 再兜一道
- 于是历史产物也能修：`build_live <host>` 重跑即可，不必重爬。

**实测**：重建后 apify 0/66、thordata 0/36 仍带冻结样式（原为 61/61、36/36），
站点自身的 styled-components / goober / onetrust 内联样式原样保留。

守卫加在 `scripts/smoke-forge.mjs`，两条方向相反的断言：
CSS 关键帧**必须**进镜像（这是"CSS 动效已复刻"的依据，以前只是文档承诺）、
冻结样式**必须**不进任何产物。为此给 fixture 站点加了真的一组关键帧，
否则断言没有可以证伪的对象。按惯例先证明会红（摘掉 stripFreeze → 报
"截图冻结样式不得进入原站产物"，装回 → PASS）。

### 31.2 队列与侦察结果脱节

`queue.json` 一旦落盘就再没看过 atlas，于是**重新侦察发现的新页永远进不了队列**，
而且看起来像已经跑完了。thordata 卡了 5 页、apify 卡了 14 页（其中 4 页其实早就
单页克隆过，只是从没记进队列）。现在载入队列时与 atlas 对齐并补入（按 url 排序保证可复现）。

**造这个修复的时候又踩了自己一脚**：补页写在了 `--max` 截断之后，等于把 `--max` 变成无效。
改成"先对齐、后截断"。

### 31.3 `recon apify.com 30` 会崩

这正是 CLI 帮助文本里印的例子。`new URL('apify.com')` 抛 `TypeError: Invalid URL`。
引擎那条路没暴露是因为它先 `new URL(url).href` 把非法输入变成 400，只有 CLI 会真崩栈。
新增 `asUrl()`（url-canon.mjs）补协议，recon / forge / capture 共用。

### 31.4 把"不逐帧复刻"换成三层 + 一份能用的档案

真实情况是分层的，原来那句话把三层混成了一层：

| 类型 | 静态镜像 | 交互镜像 |
|---|---|---|
| CSS 动画与过渡 | ✅ 活的（只剥脚本，样式表原样保留） | ✅ 活的 |
| JS 动效（打字机/GSAP/轮播） | ❌ 停在捕获那一帧 | ✅ 活的（原脚本保留、URL 重指） |
| 滚动揭示 | ⚠️ 定格在捕获时状态 | ✅ 活的 |

缺的不是复刻能力，是**把动效说清楚并把代码交出去**。而代码就在已经存下来的
`cssom.css` 里，离线就能抽 —— 不需要重爬、不需要重克隆，历史产物也能补。
新增 `src/crawler/motion-css.mjs`（纯函数，零依赖的括号配对扫描器）：

- `motion.md` / `motion.json`：逐页动效账（几处 / 几处循环 / 几处内联挂载）
- `raw/<page>/motion-css.css`：原样抽出的关键帧，分 A/B 两段
- `raw/<page>/motion-css.json`：每条动画的选择器 / 时长 / 延迟 / 缓动 / 是否循环

**B 段才是重点**：定义了但捕获时没被引用的关键帧。入场 / 滚动揭示类动效几乎都长这样 ——
关键帧常驻样式表，而引用它的那条规则（`.fadeInDown-enter-active{animation:…}`）
只在过渡的那几百毫秒里存在，静止采样时它已经没了。**抓不到引用，但代码已经在手上。**
实测 thordata 首页 18 组关键帧里 15 组属于这类。

实测交付包：thordata 36 页 / 445 组关键帧 / 244 处引用（49 处无限循环）。

### 31.5 两处复制粘贴出来的常量

- **User-Agent 14 份**：漂移的代价最隐蔽 —— 原站截图用一个 UA、镜像截图用另一个，
  分数会变但没有任何东西报错。收到 `src/ua.mjs`；`live/serve.mjs` 因交付包自包含
  约束保留本地副本，并加守卫盯着它与唯一来源一致
- **HTML 转义 9 份、两种变体**（6 份转 `& < "`，3 份还转 `>`）：统一到 `src/html.mjs`，取严格的那套

### 31.6 本轮数据

thordata 35/35 页克隆完成；apify 74 页（65 done / 9 失败，均为瞬时超时，
单独重跑已成功）；新侦察并克隆 linear / framer / vercel / tailwindcss / supabase / stripe。

测试 410/410；smoke 通过（fixture 加了动效后仍是 visual 100.0% / dom 100.0%）。

### 31.7 跨域样式表被静默丢掉 —— 丢掉的恰恰是站点的地基

服务端土办法：拿新加的 linear.app 当试验田，第一眼就看到 4 页 C 级、
像素 59% 而 **DOM 100%**、动态噪声还只有 0–9%。也就是说差的不是动画，是别的东西。
把原站截图和镜像截图摆在一起看：镜像是一个**默认样式的竖排链接列表**。

根因：`sheet.cssRules` 对**跨域样式表**直接抛异常，原来的处理是跳过这个表、
在 cssom-refs.json 里记一条 error。而 linear.app 把 CSS 放在 `static.linear.app`，
**58 份样式表全被跳过**（reset / 设计变量 / 布局 / Header / Grid 全在里面）。
它不报任何错：DOM 分 100%（DOM 确实没错）、缺口清单为空 —— 只有像素分掉到 59%，
而那还会被读成"这个站动画多"。

修法：跨域表用 Playwright 的 request 上下文按 URL 取**原文**补回来（不受 CORS 限制，
带同一份 cookie）；相对 `url()` 的基准天然正确，因为 collectCssRefs 用的是 `sheet.href`。

**实测 linear.app/build**：像素 59.0% → **97.8%**，总分 79.5(C) → **98.9(A)**；
错位像素 531,490 → 29,052（少 18 倍）；最大差异块 384,980px → 2,904px；
4 个字体本地化到位、缺口清单为空。

守卫做在离线冒烟里：fixture 站点改成**两个 origin**（页面一个端口、样式表另一个端口），
逼出这条代码路径。已验证会红：摘掉补取 → `[smoke] FAIL — CSS 关键帧必须保留在镜像样式表里`。

**为什么以前没撞上**：之前碰到跨域表都是 `accounts.google.com` / `fonts.googleapis.com`
这种一行的小表，丢了不影响观感。这个 bug 是"新站点暴露老问题"的典型 ——
所以"多克隆一些不同的站点"本身就是一种测试手段，不只是攒素材。

顺带把这类失败**摆到明面上**：补取之后仍读不到的样式表，进 `gaps.json`
的 `cssSheetsUnreadable` 并打警告 —— 它以前只躺在 cssom-refs.json 的一个字段里，没人看。

**受影响但尚未重跑的**：thordata 36 页 / angular.dev 2 页 / vitest.dev 1 页 / framer.com 5 页
（丢的都是 Google Fonts 或 GSI 的一行小表）；linear.app 15 页已用 `queue linear.app --force` 重跑。

### 31.8 233 处"资源本地化失败"，其实一个字节都不用抓

接着上一条查 framer.com 的 `fail 187 / fail 55`。为了能查，先把**失败变成可行动的**：
`linker-report.json` 现在记 `assetFailures: [{url, why}]`（每页上限 25 条），
而不是只报一个数字 —— 就是它一眼指出了根因。

全部 233 条都是同一类，而且网址长得都一样：

```
https://www.framer.com/%22data:image/svg+xml,&lt;svg%20xmlns=%22...
```

链接器处理的是**序列化后的 HTML 文本**，属性里的引号是 `&quot;`、内联 SVG 的尖括号是 `&lt;`。
于是 `url(&quot;data:image/svg+xml,&lt;svg…&gt;&quot;)` 解码后以 `"` 开头 →
`data:` **不在开头** → 被判成"外部资产" → 去抓一个必然 404 的地址。

它们是内联 data URI，本来就该原样留在 HTML 里。改在 `isNonAssetRef` 里做实体解码 + 去引号 ——
所有调用点共用这个判定（build_clone 也用它），修一处全好。

**实测 framer.com：assets 失败 233 → 0**（本地化成功数不变 —— 说明从来没有真资源被误抓过，
这些计数从头到尾都是假的）。
