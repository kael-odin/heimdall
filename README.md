# Heimdall · 站点复刻与审计工作台

> 给它一个网址，交回三样东西：**一张全站星图 · 一份像素级可核验的复刻 · 一份竞品情报**。

参赛项目 —— 江苏灵匠「第二届灵匠极客 AI 创新赛」· 主题「AI 工作流改造」。
把"竞品分析"这件产品、市场、测试都在重复做的事，从「开 DevTools 抄一周」变成「贴个网址等十分钟」。

命名出自北欧神话的全视之神海姆达尔 —— 能看穿九界、听见草生长的声音。

---

## 快速开始

```bash
git clone <repo> && cd heimdall
pnpm install && pnpm -C core exec playwright install chromium

# 克隆任意站点的一页（不需要先启动引擎）
node core/src/cli.mjs forge https://example.com home

# 或：启动控制台（引擎 + 界面同一个地址）
pnpm -C console build
cd core && HEIMDALL_CONSOLE_DIR=../console/dist node src/engine-server.mjs 8900
# 打开 http://127.0.0.1:8900
```

完整流程：

```bash
cd core
node src/cli.mjs recon example.com 60     # 侦察全站 → 星图
node src/cli.mjs queue example.com        # 批量克隆（断点续跑 + 单页熔断）
node src/cli.mjs queue example.com --incremental   # 站点改版后：只重跑源站变了的页
node src/cli.mjs verify example.com --all # 多视口保真验证
node src/cli.mjs live example.com         # 导出可部署的交互镜像
node src/cli.mjs deliver example.com      # 打包成前端可接手的交付包
```

`node src/cli.mjs`（无参数）列出全部命令。

---

## 它产出什么

| 产物 | 形态 | 给谁 |
| --- | --- | --- |
| **静态镜像** | `deliverable/<host>-<date>/`：镜像页 + 原站 CSSOM + 渲染后 DOM + 差异热图 + 还原度 CSV + 接手 README | 前端：照着写自己的第一版 |
| **交互镜像** | `deliverable/<host>-live-<date>/`：Dockerfile + `serve.mjs` + HAR 回放 + 健康报告 | 运维/前端：`docker compose up -d` 直接对着它写代码 |
| **SEO 审计** | `workspace/<host>/seo/`：HTML 报告 + CSV + JSON，66 条规则六分类 | SEO/增长 |
| **竞品情报** | `intel/<host>-intel.xlsx`：概览 / 语义情报 / 定价与 CTA | 产品/市场 |
| **全站星图** | `workspace/<host>/recon/atlas.json` + 控制台 3D 视图 | 所有人：先看清这个站的结构 |

---

## 核心机制

```
捕获渲染态 → CSSOM/资产归档 → 镜像构建 → 多视口验证 → 审计/情报 → 部署交付
```

与"让 AI 照着截图重写一遍"的根本区别：**我们测量，不生成。**

- **资产是真的**：原站的字体文件、图片、图标原件直接搬，不是近似的
- **保真度是数字**：像素 / DOM 结构 / 字段覆盖三维评分，可复现、可对质
- **缺口可枚举**：每份包都带自己的缺口清单（CSS 引用、HTML 引用、离线资源），不藏
- **确定性**：同一条命令跑两次结果一致，可以直接 diff 两个日期的包看站点改了什么

AI 用在三处判断上（像素差异的 CSS 校准、语义情报抽取、页面分类），
**不用在搬运上** —— 确定性搬运才能保证可复现、可验证。

---

## 文档导航

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| [PRD.md](PRD.md) | 产品定义：用户、定位、三件套、产品原则 | 先读这个 |
| [USAGE.md](USAGE.md) | 完整使用指南（启动、克隆、查看、部署） | 上手时 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 三层架构、栈适配器、还原度公式、产物规范 | 改代码前 |
| [DEMO-SCRIPT.md](DEMO-SCRIPT.md) | 演示脚本 + 评委问答预案 | 答辩前 |
| [VISUAL-SYSTEM.md](VISUAL-SYSTEM.md) | 控制台设计系统（令牌、字体、3D 星图规范） | 改界面前 |
| [RISKS.md](RISKS.md) | 合规红线、技术风险预案、演示日 checklist | 每周对一遍 |
| [HANDOFF.md](HANDOFF.md) | 开发记录：每批改了什么、为什么、实测数据 | 想知道"为什么这样写" |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 还没做的事 | 排下一批 |

`docs/archive/` 存放阶段性的验收报告与审查记录（历史证据，不再更新）。

---

## 能力清单

**克隆**
- 单页 / 全站队列（持久化、断点续跑、末尾 CAS 去重）
- 响应式变体还原（多视口快照 + 低分页自动升级）
- 画布内容光栅化（JS 绘制的 `<canvas>` 转静态图，否则脚本一剥就是空白）
- 站点配方三层合并（内置默认 → 运行时学到 → 人工整理），换站不用改代码

**验证**
- 多视口（375/768/1440）像素 diff + 交互回放（按钮/折叠/标签页状态比对）
- **差异形态分析**：区分"某块内容缺失（集中）"与"文字抗锯齿差异（弥散）"——
  同样 96% 的相似度，含义可能完全相反
- 原站↔镜像同步滚动对比工具
- 资产缺口扫描（视觉缺口 vs 元数据噪声分开统计）

**审计**
- SEO 66 条规则 / 六分类：抓取索引、内容语义、结构化数据、性能体验、链接架构、安全合规
- 服务端 HTML vs 渲染后对比（识别 JS 渲染依赖，含 hreflang 校验）
- 变更监控（基线快照 + 去噪）+ **SEO 回归门禁**（可接 CI，回归自动红）
- 跨站对标矩阵（站点分 / 覆盖率 / LCP / 页面类型）

**交付**
- 静态镜像包（前端改造素材 + 接手 README）
- 交互镜像包（Docker + HAR 回放 + 健康报告 + 三级回退）
- 交付包保留策略（按站点与类型保留最近 N 份，认不出的命名绝不自动删）

**运维**
- 内容寻址存储（CAS）+ 硬链接去重，删站真的释放磁盘（`nlink===1` 判据）
- 磁盘占用看板 + 孤儿回收（安全预览 → 二次确认）
- 控制台配置第三方大模型（Key 只落本地、永不回显）

---

## 仓库结构

```
core/            确定性引擎（零外部服务依赖）
  src/crawler/     捕获、构建、链接接线、站点配方
  src/seo/         SEO 规则引擎、采集、报告、回归基线
  src/live/        交互镜像导出、健康检查、自愈
  src/differ/      像素与 DOM 差异
  src/verify/      多视口验证、交互回放
  src/audit/       资产、存储、交付包治理
  sites/           人工整理的站点配方（进 git）
console/         Vue 3 控制台（8 个组件 + 全局 UI 样式表）
config/          SEO 门禁的目标站点与基线（进 git）
docs/            路线图 + archive/ 历史记录
```

数据目录：`core/workspace/`（产物）与 `core/deliverable/`（交付包），
可用 `HEIMDALL_DATA_DIR` 移出仓库。两者都不进 git。

---

## 质量门

```bash
pnpm lint          # 语法检查（全部 core 模块）
pnpm test          # 单元测试
pnpm smoke         # 离线 E2E（本地 fixture，不联网）
pnpm -C console build
```

CI 见 `.github/workflows/`：`ci.yml` 每次推送跑确定性检查；
`seo-gate.yml` 每日定时跑 SEO 回归门禁（手动触发可指定单站）。
