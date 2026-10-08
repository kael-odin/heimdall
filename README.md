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
