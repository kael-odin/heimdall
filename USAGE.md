# 使用指南 · Heimdall 最终形态

> 你（用户）如何启动、如何克隆、如何查看成果。三分钟上手。

---

## 1. 启动（每次开机后一次）

两个终端窗口（或用 `start` 后台化）：

```cmd
:: 终端 1 —— 引擎（必须先起）
cd /d D:\Github-Star\heimdall\core
node src\engine-server.mjs 8900

:: 终端 2 —— 星图控制台
cd /d D:\Github-Star\heimdall\console
pnpm exec vite --port 5173 --host 127.0.0.1
```

起好后浏览器打开 **http://127.0.0.1:5173** —— 这就是星图控制台。

## 2. 克隆一个新站（全流程）

1. 顶部输入框输入域名（如 `stripe.com`）→ 点「侦察」
2. 星图入场动画 → 爬虫光点逐星点亮（全站结构 1-3 分钟）
3. **点任意一颗星** → 右侧施工舱自动锻造该页：
   - 01 捕获骨架 → 02 注入皮肤 → 03 渲染校准 → 04 AI 校准（AI 看图改 CSS，改坏自动回滚）→ 05 像素定谳 → 06 情报入库
4. 完成 → 判定区大分数（如 96.3% A）→ 下方直接内嵌活体镜像页
5. 点「锻造内环」→ 批量并行锻造 6 个主要页面

## 3. 查看克隆成果（你问的"到底行不行"）

**方式 A —— 克隆档案页（推荐，最直观）：**

- apify.com（8 页，平均 97.3%）：http://127.0.0.1:8900/static/apify.com/index.html
- thordata.com（6 页，5A+1B，平均 97.2%）：http://127.0.0.1:8900/static/thordata.com/index.html

每个卡片显示：该页截图缩略、还原度/评级、语义标签（产品数/套餐数/价格数）。
**点卡片 = 直接打开该页的活体镜像站**，可以随便点、随便滚——导航和文案是原站的，行为是静态的（无登录/无后端交互）。

**方式 B —— 直接打开单个镜像文件（无需任何服务）：**

```
D:\Github-Star\heimdall\core\workspace\apify.com\pages\home\clone\index.html
```
双击即可（资源全是相对路径）。每页还有 `shot-src.png`（原站截图）和 `shot-clone.png`（镜像截图）可肉眼对比，`diff.png` 是差异热图。

**方式 C —— 情报包：**

```
D:\Github-Star\heimdall\core\workspace\apify.com\intel\apify.com-intel.xlsx
```
三个 sheet：概览（每页还原度）/ 语义情报（价值主张/产品/套餐/官方宣称）/ 定价与CTA 全量。

## 4. 同屏同步滚动对比（原站 vs 镜像）

克隆档案页每张卡片上点「⇔ 同步对比」，或直接开：
- http://127.0.0.1:8900/static/thordata.com/compare.html?p=pricing
- http://127.0.0.1:8900/static/apify.com/compare.html?p=home

左侧是捕获时的**原站全页快照**，右侧是**活体镜像**（可交互）。任意一侧滚动，另一侧按比例同步——逐屏目检还原质量。
（旧版产物没有原站全页图会提示"重新锻造此页"；新锻造的页自动带。）

## 5. 镜像站内导航（点击跳转）

已克隆页面之间的链接**在镜像内互相跳转**（linker 自动接线 + 幂等自愈：thordata 178 处 / apify 82 处累计改写）；
未克隆的同源页会**新标签打开原站**（诚实降级，永不 404）。
favicon/图标等全站小件自动补齐（跨页借用 + 坏链修复，余 10 项为无害的 .well-known 探测路径）。
已实测：镜像内点击 logo/导航可真实跳转到对应克隆页。

## 6. 还原度怎么读

- **total**：0.5×像素 + 0.3×结构 + 0.2×数据，≥95 为 A
- **像素**：多帧最优匹配后的首屏像素相似度（打字机/轮播噪声已排除）
- **可修性**：剩余差异里"静态可修"的占比——低于 30% 说明分数损失主要是动画噪声，不是克隆质量差
- 动效重的页（如 thordata home 94.4% B）低于静态页（98%+ A）是**正常且诚实**的——损失来自 JS 动效（W4 情报包范畴），不是布局抄错

## 7. 已知边界（诚实清单）

- 克隆页是**静态镜像**：无登录、无搜索交互、无后端请求（这些属于 L3 AI 重写范畴，比赛未承诺）
- 部分页首屏有打字机/轮播动画，镜像页该区域静止（评分已排除此类噪声）
- 白名单模式：严格反爬的站会侦察失败（明说拒收）

## 8. 全站批量锻造与交付包

```cmd
:: 全站批量（持久化队列，断点续跑：重跑自动跳过已完成页）
cd /d D:\Github-Star\heimdall\core
node src\queue.mjs thordata.com --max 30

:: 打交付包（给前端开发的素材包：README 指南 + 镜像站 + 情报 + 原材料）
node src\deliver.mjs thordata.com
:: 产出 deliverable	hordata.com-2026-09-30\ —— 整个文件夹转发即可
```

交付包内 `README-改造指南.md` 是前端开发的第一入口：怎么起服务、目录结构、
改造建议路径（读 raw/cssom.css 拿设计 token）、已知边界、还原度口径。

## 9. 命令速查

```cmd
:: 单页完整锻造（等价于点星）
cd /d D:\Github-Star\heimdall\core
node src\pipeline.mjs https://apify.com/pricing pricing

:: 全站侦察
node src\crawler\recon.mjs https://example.com 40 2

:: 刷新某站克隆档案页
node src\crawler\index-page.mjs apify.com

:: 刷新情报 xlsx
node src\harvest\xlsx.mjs apify.com
```

## 10. 控制台工作台（v2）

控制台底部导航：**星图 / 页面 / 任务 / 报告 / 设置**

| 视图 | 用途 |
|---|---|
| 星图 | 3D 探索 + 点选页面 + 详情剖析（原有能力） |
| 页面 | 全宽表格：搜索、类型/状态筛选（带计数）、批量克隆/移除、列排序、逐页视觉分/资产体积/视觉缺口/交互回放/更新时间、原站/详情/重锻/删除 |
| 任务 | 本会话全部克隆与 SEO 审计任务：状态、分数、耗时、错误 |
| 报告 | 一键打开克隆档案 / SEO 报告 / 同步对比 / 情报 Excel |
| 设置 | 主题、星图自转、引擎地址（支持远程/共享引擎）、引擎 Token |

同事只需：打开控制台 → 输入域名 → 侦察 → 页面表勾选 → 批量克隆 → 报告中心看结果。

小技巧：
- 「页面清单」可再次点击收起（或按 Esc / 点右上「✕ 返回星图」）
- 站点右侧 ✕ = 删除整站产物；页面行「删除」= 删除该页克隆并从星图移除节点
- 「重锻」可对已克隆页面重新跑流水线（覆盖旧产物，保留 CAS 资产）
- 站点/页面删除只影响 workspace 产物，CAS 资产库保留（可被其它页面复用）

## 11. SEO 审计（v2 新增）

一条命令对任意站点做 40+ 项 SEO 体检：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\seo\audit.mjs apify.com --max 20
```

产物（`core/workspace/<host>/seo/`）：

| 文件 | 用途 |
|---|---|
| `seo.html` | 自包含报告，双击即看（站点分 / 分类分 / 逐页问题 + 证据 + 建议） |
| `seo.csv` | 逐条问题清单，Excel 直接打开 |
| `seo.json` | 结构化结果，供 CI / 接口消费 |

规则分类：抓取与索引 / 内容与语义 / 结构化数据与社交 / 性能与体验（LCP·CLS）/ 链接与架构 / 安全与合规。
CI 门控：`--threshold 70` 时站点分低于阈值退出码为 1。

控制台：站点栏点「SEO 审计」→ 任务中心显示进度 → 完成后右下角打开报告。

## 12. 资产去重（CAS，v2）

站点批量锻造结束后自动执行去重；也可单独运行：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\store\dedupe.mjs apify.com          :: 内容寻址 + 硬链接去重
node core\src\store\dedupe.mjs apify.com --dry-run :: 只统计不修改
```

- CAS 目录：`core/assets-cas/<aa>/<bb>/<sha256><ext>`（`HEIMDALL_DATA_DIR` 可迁移）
- 实测 apify：25,917 个文件 → 3,191 个唯一，节省约 241MB（48%）
- 账本：`workspace/<host>/asset-ledger.json`
- 队列支持 `--no-dedupe` 跳过

## 13. 安全与数据目录（v2）

- 引擎默认只监听 `127.0.0.1`；内网共享时设置 `HEIMDALL_HOST=0.0.0.0` + `HEIMDALL_TOKEN=<token>`，控制台可用 localStorage 的 `heimdall-token` 携带。
- 活镜像/代理只允许 `workspace/<host>` 已存在的域名（防 SSRF/开放代理）；额外域名用 `HEIMDALL_ALLOWED_HOSTS=a.com,b.com`。
- 把 1.4GB 产物移出仓库：`set HEIMDALL_DATA_DIR=D:\heimdall-data`，workspace/deliverable 都会迁到该目录。

## 14. 多视口验证（v2）

单页快照的 1440×900 分数会掩盖移动端差距。用 verify 做 375/768/1440 三档全页对比：

```cmd
cd /d D:\Github-Star\heimdall\core
node src\verify\verify.mjs apify.com storage            :: 单页三视口
node src\verify\verify.mjs apify.com --all --max 10      :: 前 10 页，输出站点汇总
node src\verify\verify.mjs apify.com storage --threshold 85  :: CI 门控（综合分低于阈值退出码 1）
```

产物：`workspace/<host>/verify/<page>/verify.json` + `diff-<viewport>.png`（差异热图）。
综合分 = 移动 0.25 / 平板 0.25 / 桌面 0.5。

**交互回放（功能保真）**：单页验证默认开启——在“原站”和“克隆页”上发现同一批按钮/折叠/标签页，用同一条 DOM 路径点击，比较点击后的状态签名（aria-expanded/可见元素数/文本长度）与视口截图像素。

- `--no-interactions`：关闭交互回放
- `--all` 时默认跳过；加 `--interactions` 开启
- 结果在 `verify.json.functional`，差异图 `ix-*.png`
- 实测 apify.com/pricing：视觉 96.0% A（移动 94.0/平板 95.9/桌面 97.1）＋交互 3/3

实测 apify.com/storage：桌面 98.2%（A）/ 平板 89.4%（B）/ 移动 78.4%（C）→ 综合 91.0%（B）。
这证明"单视口 95.9%"确实高估了真实保真度——移动端字体/换行/高度差是主要来源。

## 15. 活镜像部署包（L3，v2）

把站点导出成"可以直接部署"的活镜像包：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\live\export.mjs thordata.com                 :: 生成部署包
node core\src\live\export.mjs thordata.com --offline       :: 离线模式（不回源）
node core\src\live\export.mjs thordata.com --rebuild       :: 先重建 live 页面再打包
```

产物（`core/deliverable/<host>-live-<date>/`）：

| 文件 | 说明 |
|---|---|
| `serve.mjs` + `har.mjs` | 零依赖 Node 服务器（本地快照 → HAR 回放 → 原站代理） |
| `har.json` | 清洗后的 HAR（不含 cookie/authorization），原站重新部署后旧 chunk 仍可回放 |
| `heimdall-live.json` | host/origin/port/offline/replayApi 配置 |
| `site/live/**`、`site/static/**` | 活镜像页面 + 克隆页/CSS/资产/档案/SEO 报告 |
| `landing.html` | 落地页（镜像/档案/对比/SEO 报告入口） |
| `Dockerfile`、`docker-compose.yml` | 一键容器部署 |
| `checksums.json` | 全文件 SHA-256 清单 |

部署：

```cmd
cd core\deliverable\thordata.com-live-2026-10-08
node serve.mjs --port 8080          :: 直接跑
docker compose up -d                :: 或容器
```

路由：`/lm/<host>/**`（活镜像）、`/static/<host>/**`（克隆档案）、`/__heimdall/health`（健康检查）。
离线模式：`--offline` 或配置 `offline: true`，未捕获资源明确 404，不回源。

## 16. 变更监控（v2）

监控目标站点是否发生变化（标题/描述/canonical/robots/H1/结构化数据/字数/正文指纹）：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\watch\watch.mjs apify.com --max 20        :: 首次运行建立基线
node core\src\watch\watch.mjs apify.com --max 20        :: 之后运行输出变更报告
node core\src\watch\watch.mjs apify.com --accept        :: 确认变化并更新基线
node core\src\watch\watch.mjs apify.com --fail-on-change :: 有变化退出码 1（定时任务/CI 用）
```

- 每次采集默认**两次采样**：两次不一致的字段判为动态噪声（计数/轮播/推荐位），不计入变化
- 字数波动 <5% 视为动态；正文小幅变化降级为 info
- 产物：`workspace/<host>/watch/{baseline.json,watch.json,watch.html,history/}`（历史保留最近 30 份）
- 控制台「报告」页可一键运行并打开变更报告

## 17. Docker / 单端口部署（v2）

一条命令起完整工作台（引擎 + 控制台 + 报告 + Playwright）：

```cmd
cd /d D:\Github-Star\heimdall
docker compose up -d          :: 构建并启动
:: 打开 http://localhost:8900
:: 数据持久化在 heimdall-data 卷（对应容器内 /data）
```

- 引擎同时服务：API/SSE、`/static` 产物、`/lm` 活镜像、控制台 SPA（`HEIMDALL_CONSOLE_DIR`）
- 内网共享：在 compose 里设置 `HEIMDALL_TOKEN`，并在控制台「设置 → 引擎 Token」填入同一值
- LLM：设置 `HEIMDALL_LLM=1` + `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` 后 AI 校准/语义增强生效
- 不使用 Docker 时也可本机单端口：先构建控制台，再启动引擎

```cmd
pnpm -C console build
set HEIMDALL_CONSOLE_DIR=D:\Github-Star\heimdall\console\dist
node core\src\engine-server.mjs 8900
```

## 18. 设计 Token 提取（v2）

从已克隆页面的 CSSOM 提取设计系统资产：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\extract\extract-tokens.mjs apify.com --pages 5
```

产物（`workspace/<host>/design/`）：

| 文件 | 说明 |
|---|---|
| `tokens.json` | 颜色/字体/字号/字重/间距/圆角/阴影/断点/CSS 变量 + 使用频次 |
| `tokens.css` | 可直接引用的 CSS 变量（`--hmd-color-*/--hmd-space-*...`，保留原站变量为 `--src-*`） |
| `tokens.html` | 可视化预览（色板 / 字阶 / 间距 / 圆角 / 阴影 / 断点 / 原生变量） |

实测 apify（home+pricing+3 页）：77 色 / 13 字体族 / 58 字号 / 92 间距值。

## 19. 统一 CLI（v2）

所有能力一个入口（等价于各脚本，便于同事记忆与自动化）：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\cli.mjs help
node core\src\cli.mjs recon  apify.com 30
node core\src\cli.mjs forge  https://apify.com/pricing pricing
node core\src\cli.mjs queue  apify.com --max 60
node core\src\cli.mjs audit  apify.com --max 20
node core\src\cli.mjs watch  apify.com --max 20
node core\src\cli.mjs verify apify.com pricing
node core\src\cli.mjs tokens apify.com --pages 5
node core\src\cli.mjs live   apify.com --offline
node core\src\cli.mjs dedupe apify.com
node core\src\cli.mjs serve  8900
```

也可以 `pnpm -C core cli <command> ...`。

## 20. 任务持久化（v2）

- 引擎把任务与事件写入 `HEIMDALL_DATA_DIR/jobs.db`（Node 内置 `node:sqlite`，零依赖；旧版 Node 自动降级为原子写 JSON）
- 引擎重启后：`GET /api/jobs` 的 `history` 仍可查询；上次崩溃遗留的 running 任务自动标记为 `interrupted`
- 控制台「任务」页底部展示持久化历史（最近 50 条）
- 可用 `HEIMDALL_JOBS_DB` 自定义数据库路径；`HEIMDALL_JOBS_FORCE_JSON=1` 强制 JSON 存储

## 21. 组件抽取（v2）

把已克隆页面的常见组件抽成可复用素材：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\extract\extract-components.mjs apify.com --pages 2 --max 12
```

产物（`workspace/<host>/design/components/`）：

| 文件 | 说明 |
|---|---|
| `<page>-<key>.html` | 独立预览（组件 outerHTML + 命中 CSS + :root 变量；素材路径自动回指 clone 目录） |
| `components.json` | 清单（tag/classes/选择器/规则数/字节/来源页） |
| `components.html` | 画廊（16 个 iframe 预览，可逐个打开） |

覆盖类型：header/nav、hero、pricing、faq、footer、cta。
实测 apify（home+pricing）：16 个组件（header 45KB / hero 114KB / pricing 140KB / faq / footer / 4×CTA）。

## 22. 竞品 SEO 对标矩阵（v2）

```cmd
cd /d D:\Github-Star\heimdall
node core\src\seo\matrix.mjs apify.com thordata.com --max 15
node core\src\seo\matrix.mjs apify.com thordata.com --refresh   :: 强制重新审计
```

- 数据源：各站 `workspace/<host>/seo/seo.json`（缺失时自动先审计）
- 产物：`workspace/_matrix/<sites>-<date>/{matrix.html,matrix.csv,matrix.json}`
- 对比维度：站点分 / 页面数 / title 长度 / description·H1·结构化数据覆盖率 / 平均 LCP / 平均字数 / 每页问题数 / 页面类型分布 / 各站高频问题
- 报告中绿色 = 该指标最优

## 23. 资产缺口扫描（v2）

检查克隆页有没有丢失 logo / 图标 / tab 图标 / 背景图 / 字体等细节：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\audit\assets.mjs apify.com --max 61
```

产物：`workspace/<host>/audit/{asset-gaps.json,asset-gaps.html}`

- **视觉缺口**：img/srcset/picture fallback/lazy data-src、icon、svg-use、video/audio、CSS url()、内联背景 —— 这些才真正影响画面
- **元数据/追踪/设计替代**：canonical/alternate/og:image/.well-known、追踪像素、被 cssom.css 取代的 stylesheet/preload —— 单独归类，不算视觉缺口
- 实测：apify 61 页 **视觉缺口 0**；thordata 31 页从 **673 → 0**（重新锻造 + 重接线后）
- 本轮修复的缺口根因：`<picture>` fallback/lazy `data-src` 漏采；跨页资产缓存导致 `linked-*` 悬空引用；CSS `refNNN` 编号与原始引用错位；HAR 未用于回放；Vite `/src/` 资源相对路径无法回源恢复

- 控制台一键：**报告 → 资产缺口 → 运行扫描**（完成后出现报告入口；任务中心显示缺口数）
- 页面清单新增列：**资产（体积/数量）· 视觉缺口 · 交互回放 · 更新时间**，均可排序；点击某行 → 详情面板顶部有「打开克隆 / 活镜像 / 同步对比 / 分数 JSON」快捷入口
- 重新锻造以应用最新采集：`node core\src\queue.mjs <host> --force`

## 24. MCP 与浏览器入口（v2）

**MCP（给 agent 用）**：把 Heimdall 能力暴露成 MCP 工具，任何支持 MCP 的客户端都能调用。

```cmd
cd /d D:\Github-Star\heimdall
node core\src\mcp\server.mjs        :: stdio MCP 服务器（12 个工具）
```

工具：`heimdall_status/jobs/recon/forge/audit/watch/verify/tokens/components/matrix/live_export/dedupe`。
环境变量 `HEIMDALL_API`（默认 http://127.0.0.1:8900）与 `HEIMDALL_TOKEN`。

**浏览器书签入口（给同事用）**：

```cmd
node core\src\browser\bookmarklet.mjs --api http://<引擎地址>:8900 --token <token>
:: 产物：workspace/_browser/heimdall-bookmarklet.html（把按钮拖到书签栏）
```

在任意页面点书签 → 当前 URL 直接送入 Heimdall（侦察/克隆/审计/监控），到控制台「任务」页查看。

## 24. 沙盒改造台（v2）

在克隆页上直接改样式/文案，并与原版做逐像素对比：

```cmd
cd /d D:\Github-Star\heimdall
node core\src\sandbox\serve.mjs apify.com pricing --port 8090
:: 打开 http://127.0.0.1:8090
```

- 左侧：HTML（沙盒副本）+ CSS 覆盖（sandbox.css）；右侧：实时预览
- 「保存 (Ctrl+S)」写入 `workspace/<host>/sandbox/<page>/`
- 「与原始对比」→ Playwright 全页截图 + pixelmatch，输出相似度/差异像素/高度差 + diff.png
- `--reset` 可从克隆页重置沙盒 HTML

## 25. LLM 与引擎 Token 配置（v2）

### 两个“Token”别混淆

| 名称 | 环境变量 | 作用 |
|---|---|---|
| 引擎 Token | `HEIMDALL_TOKEN` | 保护你的 Heimdall 引擎 API（`/api/*`、`/px/*`）。内网共享/公网暴露时才需要；控制台「设置」里填入同一值。留空 = 不鉴权（默认仅本机可用） |
| 模型 Key | `LLM_API_KEY` | 调用模型服务的凭证（如 `sk-...`）。只放在 `core/.env`，不要填到控制台、不要提交 git |

### 三要素配置（示例）

```ini
# core/.env
HEIMDALL_LLM=1
LLM_BASE_URL=https://xc.lifesecretary.com:8000/v1
LLM_API_KEY=sk-你的key
LLM_MODEL=deepseek-v4-pro
LLM_MODEL_FAST=deepseek-flash
LLM_PROTOCOL=chat
```

- 改完 `core/.env` 需要**重启引擎**生效
- 控制台「设置 → 模型服务」会显示协议/模型/端点（只显示域名，不显示 Key），点「测试连接」会发起一次最小真实请求
- 验证模型列表：`GET {LLM_BASE_URL}/models`（当前中转可用：`deepseek-flash / deepseek-v4-flash / deepseek-v4-pro`）

### 协议支持

| LLM_PROTOCOL | 请求端点 | 说明 |
|---|---|---|
| `chat`（默认） | `{base}/chat/completions` | OpenAI 兼容；支持 `response_format: json_object`（不支持时自动去掉约束重试） |
| `responses` | `{base}/responses` | OpenAI Responses API（`input/output_text`） |
| `anthropic` | `{base}/messages` | Anthropic Messages（`x-api-key` + `content blocks`，图片转 base64） |

- 视觉（fixup 看图改 CSS）：三种协议都会自动转换图片格式；如果当前模型不支持图片，会**自动降级为纯文本补丁**（依赖 style-probe 的逐元素差异清单），不会阻塞流水线
- 没有视觉模型时，建议：`LLM_MODEL` 用推理/质量更强的模型（如 `deepseek-v4-pro`），`LLM_MODEL_FAST` 用 `deepseek-flash`

### 安全建议

- Key 只写入 `core/.env`（已被 gitignore）；`.env.example` 只有占位符
- 不要把 Key 粘贴到聊天/工单/截图里；如已泄露请立即在服务商处轮换
- 引擎默认只监听 `127.0.0.1`；内网共享请同时设置 `HEIMDALL_HOST=0.0.0.0` + `HEIMDALL_TOKEN`

## 26. 质量门（v2）

```cmd
pnpm lint    :: 零依赖语法门（core）
pnpm test    :: node:test 单测（评分/抽取/适配器/SEO 规则）
pnpm smoke   :: 离线 E2E：本地 fixture → recon → forge → 产物断言 → SEO 审计（不碰外网、不写真实 workspace）
```
