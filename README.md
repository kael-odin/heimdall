# Heimdall · 千面镜像引擎

> **一个网址，一个宇宙。**
> 输入 URL，输出：一张全站星图 · 一座活体克隆 · 一份情报包。

参赛项目 —— 灵匠第二届极客 AI 创新活动「AI 工作流改造局」：
把"竞品分析"这件每个产品、市场、测试同事都在重复做的事，
从「开 DevTools 抄一周」变成「贴个网址等十分钟」。

命名出自北欧神话的全视之神海姆达尔：能看穿九界、听见草生长的声音。
他是这座网站宇宙的侦察之眼 —— 延续 kael-odin 系列的神话命名体系。

## 文档导航

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| [PRD.md](PRD.md) | 第一性原理推导、产品定义、三件套、还原度体系 | **先读这个** |
| [DEMO-SCRIPT.md](DEMO-SCRIPT.md) | 90 秒灵魂 Demo 逐秒分镜剧本 | 做控制台/答辩前 |
| [VISUAL-SYSTEM.md](VISUAL-SYSTEM.md) | 深空观测站视觉系统：色彩/字体/3D 星图/动效守则 | 做任何 UI 前 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 三层架构、栈适配器、还原度公式、里程碑 | 开工前 |
| [RISKS.md](RISKS.md) | 合规红线、技术风险预案、演示日 checklist | 每周对一遍 |

## v2 新增（2026-10-08 起）

- **SEO 审计**：`node core/src/seo/audit.mjs <host> --max 20` → `workspace/<host>/seo/{seo.html,seo.csv,seo.json}`，40+ 规则覆盖索引/内容/结构化数据/性能/链接/安全
- **任务持久化**：`node:sqlite`（旧版 Node 自动降级 JSON）存储任务/事件；引擎重启后历史可查，崩溃遗留的 running 标记为 interrupted
- **沙盒改造台**：`node core/src/sandbox/serve.mjs <host> <page>` → 在线改 HTML/CSS、实时预览、与原版逐像素对比（实测：改背景色相似度 24.7%，还原后 100%/0 像素差）
- **报告中心 / 资产清单**：控制台「报告」页动态列出所有可用报告（档案/SEO/监控/Token/组件/验证/情报），并按体积展示 Top 资产
- **MCP / 浏览器入口**：`node core/src/mcp/server.mjs`（stdio MCP，12 个工具）；`node core/src/browser/bookmarklet.mjs`（在任意页面一键送入 Heimdall）
- **资产缺口扫描**：CLI `node core/src/audit/assets.mjs <host>` 或控制台「报告 → 资产缺口 → 运行扫描」；视觉缺口与元数据/追踪/设计替代分开统计（apify 与 thordata 实测视觉缺口均为 0）；页面清单直接显示每页资产体积/缺口/交互/更新时间
- **逐页快捷入口**：详情面板可直达 打开克隆 / 活镜像 / 同步对比 / 分数 JSON
- **竞品 SEO 对标矩阵**：`node core/src/seo/matrix.mjs <本站> <竞品1> <竞品2>` → 站点分/覆盖率/LCP/页面类型/高频问题对比（HTML+CSV+JSON）
- **组件抽取**：`node core/src/extract/extract-components.mjs <host>` → header/hero/pricing/faq/footer/cta 独立预览（outerHTML + 命中 CSS + 素材路径回指）
- **统一 CLI**：`node core/src/cli.mjs`（或 `pnpm -C core cli`）覆盖 recon/forge/queue/audit/watch/verify/tokens/live/dedupe/deliver/serve
- **设计 Token 提取**：`node core/src/extract/extract-tokens.mjs <host>` → colors/字体/字号/间距/圆角/阴影/断点/CSS 变量（含频次）→ tokens.css + 可视化预览
- **单端口 / Docker 部署**：`docker compose up -d` → http://localhost:8900 打开控制台（引擎同时服务 API/SSE/静态产物/控制台 SPA + Playwright Chromium）
- **变更监控**：`node core/src/watch/watch.mjs <host>` → 基线快照 + 两次采样排除动态噪声 → 标题/描述/canonical/robots/正文变化报告（HTML/JSON），支持 `--fail-on-change` 接入定时任务
- **活镜像 L3（可部署）**：`node core/src/live/export.mjs <host>` → 自包含部署包（零依赖 Node 服务器 + HAR 回放 + Dockerfile/compose + 校验和），本地快照优先 → HAR 回放 → 原站代理
- **工作台 IA（v2）**：底部导航切换 星图/页面/任务/报告/设置；页面表格支持搜索、类型/状态筛选、批量克隆、逐页视觉分与状态；报告中心聚合档案/SEO/对比/情报
- **多协议 LLM + 配置自检**：`LLM_PROTOCOL=chat|responses|anthropic`；控制台「设置 → 模型服务」显示协议/模型/端点（不含 Key）并提供真实连接测试；「引擎 Token」= 保护引擎 API，与模型 Key 分离
- **多视口 + 交互回放验证**：视觉（375/768/1440 全页 diff）＋功能（按钮/折叠/标签页点击状态比对）→ 四维成绩单；实测 apify pricing：视觉 96.0% A、交互 3/3
- **多视口验证**：`node core/src/verify/verify.mjs <host> <page>` → 375/768/1440 全页 diff（实测 apify storage：桌面 98.2% / 平板 89.4% / 移动 78.4%，暴露单视口口径看不到的移动端差距）
- **任务中心**：控制台内每次克隆与审计独立进度，不再互相覆盖；引擎新增 `/api/jobs` 与任务取消
- **安全默认值**：引擎默认只监听 `127.0.0.1`，代理只允许 workspace 已知 host；可用 `HEIMDALL_TOKEN` 开启鉴权
- **数据目录可迁移**：`HEIMDALL_DATA_DIR` 把 workspace/deliverable 移出仓库
- **质量门**：`pnpm lint` / `pnpm test` / `pnpm smoke`（本地 fixture 离线 E2E）+ GitHub Actions
- 完整审查与路线图：[docs/REVIEW-2026-10-08.md](docs/REVIEW-2026-10-08.md)

## 一图看懂

```
  你贴一个网址
       │
       ▼
 ┌──────────┐   ┌──────────┐   ┌──────────┐
 │  侦察     │──▶│  造物     │──▶│  收割     │
 │  Recon    │   │  Forge    │   │  Harvest  │
 │  全站星图  │   │  活体克隆  │   │  情报包    │
 └──────────┘   └──────────┘   └──────────┘
   看见整站        拥有整站        榨干整站
```
