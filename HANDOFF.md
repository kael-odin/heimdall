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
| 统一 CLI | ✅ | `node src/cli.mjs <command>` 覆盖 recon/forge/queue/audit/watch/verify/tokens/live/dedupe/deliver/serve |
| 设计 Token | ✅ v1 | `node src/extract/extract-tokens.mjs <host>` → tokens.json/css/html（色板/字阶/间距/圆角/阴影/断点/变量 + 频次） |
| 部署 | ✅ v2 | Dockerfile + docker-compose（引擎+控制台+Playwright 单端口 8900，数据卷 /data）；本机单端口用 HEIMDALL_CONSOLE_DIR |
| 变更监控 | ✅ v1 | `node src/watch/watch.mjs <host>`；两次采样排除动态噪声；字段级变化报告 + `--fail-on-change` 门控 + 历史快照 |
| 活镜像 L3 | ✅ v1 | `node src/live/export.mjs <host>` → 自包含部署包：零依赖 serve.mjs + HAR 回放 + Dockerfile/compose + checksums；离线模式可断原站运行（smoke 覆盖导出/离线启动/本地页面/CSS/404） |
| 多视口验证 | ✅ v1 | `node src/verify/verify.mjs <host> <page>`；375/768/1440 全页 diff（apify storage 实测 91.0% B：桌面 98.2 / 平板 89.4 / 移动 78.4） |
| SEO 审计 | ✅ v1 | `node src/seo/audit.mjs <host> --max 20` → seo.html/csv/json，40+ 规则、六分类评分 |
| 质量门 | ✅ | `pnpm lint` / `pnpm test`（12 单测）/ `pnpm smoke`（fixture 离线 E2E，含 SEO 审计）+ GitHub Actions |
| 安全默认值 | ✅ | 绑定 127.0.0.1、代理 host 白名单、路径越界防护、可选 token、CORS 限定来源 |

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
