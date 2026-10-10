---
name: Heimdall Console
description: 深空观测站 HUD —— 本地站点克隆与 SEO 审计工作台的仪器化控制台界面。
colors:
  # 底色层 / ground
  abyss: "#0B0B10"
  abyss-light: "#F4F6FA"
  dust: "#1E1E23"
  dust-light: "#FFFFFF"
  muted: "#232328"
  muted-light: "#E8ECF2"
  # 主色：侦察
  cyan: "#22D3EE"
  cyan-light: "#0E7490"
  cyan-dim: "rgba(34, 211, 238, 0.45)"
  cyan-dim-light: "rgba(14, 116, 144, 0.5)"
  cyan-line: "rgba(34, 211, 238, 0.22)"
  cyan-line-light: "rgba(14, 116, 144, 0.28)"
  cyan-wash: "rgba(34, 211, 238, 0.12)"
  cyan-selected: "rgba(34, 211, 238, 0.10)"
  cyan-tint: "rgba(34, 211, 238, 0.035)"
  # 语义色
  amber: "#F59E0B"
  amber-light: "#B45309"
  violet: "#A78BFA"
  violet-light: "#7C3AED"
  green: "#34D399"
  green-light: "#047857"
  red: "#EF4444"
  red-light: "#B91C1C"
  # 文字
  text: "#F8FAFC"
  text-light: "#0F172A"
  text-dim: "#94A3B8"
  text-dim-light: "#475569"
  text-faint: "#7E8CA0"
  text-faint-light: "#5B6675"
  # 中性细线 / 内嵌面
  hairline: "rgba(148, 163, 184, 0.10)"
  line-neutral: "rgba(148, 163, 184, 0.16)"
  surface-inset: "rgba(255, 255, 255, 0.04)"
  surface-soft: "rgba(30, 30, 35, 0.5)"
  # 页面类型墨色（数据可视化调色板，types.js）
  page-marketing: "#22D3EE"
  page-marketing-light: "#0E7490"
  page-pricing: "#F59E0B"
  page-pricing-light: "#B45309"
  page-listing: "#8B5CF6"
  page-listing-light: "#6D28D9"
  page-blog: "#34D399"
  page-blog-light: "#047857"
  page-product: "#F472B6"
  page-product-light: "#BE185D"
  page-doc: "#7B8CA6"
  page-doc-light: "#4B5563"
  page-help: "#FBBF24"
  page-help-light: "#A16207"
  page-tools: "#C084FC"
  page-tools-light: "#7E22CE"
  page-case-study: "#38BDF8"
  page-case-study-light: "#0369A1"
  page-career: "#A3E635"
  page-career-light: "#4D7C0F"
  page-company: "#5EEAD4"
  page-company-light: "#0F766E"
  page-auth: "#F87171"
  page-auth-light: "#B91C1C"
  page-legal: "#64748B"
  page-legal-light: "#475569"
  page-generic: "#94A3B8"
  page-generic-light: "#64748B"
typography:
  display:
    fontFamily: "Orbitron, monospace"
    fontSize: "54px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "normal"
    fontFeature: "'tnum'"
  headline:
    fontFamily: "Orbitron, monospace"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.3em"
  stat:
    fontFamily: "Orbitron, monospace"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "normal"
    fontFeature: "'tnum'"
  title:
    fontFamily: "'Noto Sans SC', 'Microsoft YaHei UI', sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "normal"
  body:
    fontFamily: "'Noto Sans SC', 'Microsoft YaHei UI', sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "normal"
  label:
    fontFamily: "'Share Tech Mono', monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.22em"
  mono:
    fontFamily: "'Share Tech Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.04em"
rounded:
  xs: "2px"
  sm: "3px"
  md: "4px"
  pill: "999px"
spacing:
  "2xs": "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
  "2xl": "16px"
  "3xl": "18px"
  "4xl": "30px"
components:
  panel:
    backgroundColor: "{colors.dust}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
  panel-inset:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.text-faint}"
    rounded: "{rounded.sm}"
    padding: "9px 11px"
  button-primary:
    backgroundColor: "{colors.cyan-wash}"
    textColor: "{colors.cyan}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "rgba(34, 211, 238, 0.18)"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
  button-danger:
    backgroundColor: "rgba(239, 68, 68, 0.06)"
    textColor: "{colors.red}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  button-audit:
    backgroundColor: "rgba(52, 211, 153, 0.06)"
    textColor: "{colors.green}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  field:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "6px 9px"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.green}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  tab:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.text-faint}"
    rounded: "{rounded.sm}"
    padding: "8px 0"
  tab-active:
    backgroundColor: "rgba(34, 211, 238, 0.06)"
    textColor: "{colors.cyan}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-faint}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
  nav-item-active:
    backgroundColor: "{colors.cyan-selected}"
    textColor: "{colors.cyan}"
  report-card:
    backgroundColor: "{colors.dust}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "16px"
  kpi-tile:
    backgroundColor: "{colors.cyan-tint}"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.sm}"
    padding: "10px"
  table-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "0"
    padding: "8px 14px"
  table-head:
    backgroundColor: "rgba(11, 11, 16, 0.95)"
    textColor: "{colors.text-faint}"
    rounded: "0"
    padding: "8px 14px"
---

# Design System: Heimdall Console

## Overview

**Creative North Star: "The Deep-Space Observatory"（深空观测站）**

控制台不是仪表盘，而是一台**仪器**。整个界面建立在同一个表面基元上——深色观测场上一块 1px 青色细线的面板，四角带 L 形装饰刻度，内部是自上而下的暗色渐变。所有内容都"读"出来：页面是星图上的星球，任务是仪器上的读数，报告是观测记录，存储治理是仓库盘点。中文业务术语与英文仪器标签混排（`报告中心 · apify.com`、`OBSERVATORY · 仪表面板`、`VISUAL FIDELITY · 视觉还原度`），这是观测站里"仪表刻印"的语感，不是装饰性的标题排版。

密度是刻意的：表格行 12px、元数据 10.5–11.5px、标签 10px 且带 0.12–0.34em 字距；信息优先于留白。颜色按**职责**分配且互不替代：青色永远是侦察与主操作，琥珀永远是警告与进行中，紫色永远是 AI 校准，绿色是完成，红色是失败。发光被严格收敛——只有状态和选择会发光，正文和框线从不发光，因此"某处亮起来"本身就携带语义。深度不靠阴影，靠 1px 细线的分层、面板内的暗色渐变，以及唯一的模糊面：右侧详情坞。

第二版把浮层式界面改造成真正的工作台：`pages` / `jobs` / `reports` / `settings` 变成整高可滚动的 `.work-view` 面板并各自拥有表头（`.wv-head`），星图专属的浮层（品牌/统计、站点条、快捷键条、仪表面板）只在星图视图渲染。同一个视觉世界，但从"悬浮仪表堆叠"走到了"可工作的观测站"。

**Key Characteristics:**
- 单一表面基元：1px 细线仪器面板 + 四角刻度 + 暗色渐变地。
- 五色语义分工，青色为唯一主色，发光仅标记状态与选择。
- 三字体分工：Orbitron 数字/标识、Share Tech Mono 标签与数据、Noto Sans SC 正文。
- 汉字正文以可读字号为准（正文 ≥12px，标签 10px 起），不再用 8–9px 装饰字。
- 双主题（`data-theme="dark"` 默认 / `light` 日间模式），全部主题色在 token 层翻转。
- 深度 = 细线 + 色阶 + 辉光；没有任何投影。

## Colors

深色观测场做底，冷青做唯一主色，语义色（琥珀/紫/绿/红）只做状态信号；浅色主题把每个会在白底上失去对比度的值整体下沉到 AA 区间。

### Primary
- **Reconnaissance Cyan 侦察青**（`#22D3EE` / 浅色 `#0E7490`）：唯一主色。用于品牌标识、主按钮、表格中的 URL 链接、面板细线、激活的分页导航与站点按钮、搜索栏的"侦察"动作、进度条。浅色值由 `#0891B2` 修正而来——原值在白底上只有 3.68:1，不满足 AA。
- **Cyan Veil 青色渐隐**（`rgba(34, 211, 238, 0.45)` 为 `-dim`、`0.22` 为 `-line`、`0.12` 为 `-wash`、`0.10` 为 `-selected`、`0.035` 为 `-tint`）：同一个色相的透明度阶梯，分别承担"强调边框/圆点"、"面板与输入框描边"、"主按钮底色"、"激活态底色"、"KPI 瓦片底色"。浅色主题下 `-dim`/`-line` 换成 `rgba(14, 116, 144, ·)` 的 0.5 / 0.28，其余阶梯沿用同一 rgba。

### Secondary
- **Signal Amber 信号琥珀**（`#F59E0B` / 浅色 `#B45309`）：警告与**进行中**。用于运行中的任务状态、`hud-pulse` 呼吸的状态灯、进行中的锻造阶段、`--warn-text`、危险操作的提示文字、可变现的"可回收 CAS"。它不用于主操作。
- **Calibration Violet 校准紫**（`#A78BFA` / 浅色 `#7C3AED`）：AI 专属。只出现在 AI 校准曲线卡（`.fixup-curve`，含虚线边框）、情报包条（`.intel-bar`）和任务类型名（`.job-kind`）。任何非模型功能不得使用紫色。

### Tertiary
- **Verdict Green 判定绿**（`#34D399` / 浅色 `#047857`）：完成、通过、成功。用于"已克隆"状态、通过项边框、SEO 审计按钮、活跃引擎指示灯（带 `0 0 8px` 发光）、成功提示条。浅色值由 `#059669`（3.6:1）修正为 `#047857`（5.6:1）。
- **Fault Red 故障红**（`#EF4444` / 浅色 `#B91C1C`）：失败、危险、删除。用于失败状态文字、删除/回收按钮、错误条（`.dock-err`、`.storage-error`、`.set-msg.bad`）、让它成为光标的危险悬停。浅色值由 `#DC2626`（在淡红底上 4.47:1）修正为 `#B91C1C`（6.6:1）。

### Neutral
- **Abyss 深渊地**（`#0B0B10` / 浅色 `#F4F6FA`）：`html/body/#app` 底色，也是浮层（`.seek`、`.keys`、`.status`、`.task-center`、`.site-btn`）的半透明基色。
- **Panel Dust 面板尘**（`#1E1E23` / 浅色 `#FFFFFF`）：面板渐变的顶端色（`linear-gradient(180deg, rgba(30,30,35,.92), rgba(20,20,26,.94))`）；浅色主题下面板与详情坞直接变纯白。
- **Track Muted 轨道灰**（`#232328` / 浅色 `#E8ECF2`）：进度条、站点占用条的底色。
- **Signal White 主文字**（`#F8FAFC` / 浅色 `#0F172A`）：正文与标题。
- **Dim Slate 次文字**（`#94A3B8` / 浅色 `#475569`）：说明文字、表格标题列、次级按钮、报告卡正文。
- **Faint Steel 弱文字**（`#7E8CA0` / 浅色 `#5B6675`）：字距标签、时间戳、占位符、辅助注释。深色值由 `#64748B`（面板底 4.13:1）修正为 `#7E8CA0`（4.8:1）；浅色值由 `#94A3B8`（白底 2.4:1）修正为 `#5B6675`（白底 5.8:1 / 浅灰底 5.2:1）。
- **Hairline / Neutral Line**（`rgba(148, 163, 184, 0.10)` / `0.16`）：表格行分隔与中性控件描边。这两个字面值在组件里被反复复用（行分隔、`ov-item`、`seo-row`、`stage`、`wv-actions` 按钮框），是事实上的中性 token。
- **Surface Inset / Soft**（`rgba(255, 255, 255, 0.04)` / `rgba(30, 30, 35, 0.5)`）：输入框与选单的内嵌底、标签页与阶段行的静默底。

### Page Type Ink 页面类型墨色
14 种页面类型（`types.js`）是星图、图例、表格、详情面板共用的数据调色板，每个类型**双值**：`color` 给深色观测场，`light` 给浅色主题。浅色值全部按 WCAG AA（小字 ≥4.5:1）在白底上校过——原霓虹值（如 `#22D3EE`）在白底上只有 1.8:1，文字不可读。新增类型必须在 `PAGE_TYPES` 注册两色，`typeColor(type, theme)` 取值，图例从数据动态生成。映射关系：marketing 青、pricing 琥珀、listing 紫、blog 绿、product 粉、doc 石板、help 黄、tools 淡紫、case-study 天蓝、career 青柠、company 薄荷、auth 红、legal/generic 灰。

### Named Rules
**The Glow-Is-Evidence Rule.** 发光只标记**状态与选择**，不用于装饰。允许发光的位置是：品牌字与统计数字的文字辉光、`.hud-rule` 上的 5px 方块刻度、`.status.live`、运行的阶段圆点、还原度评分数字、主按钮/锻造按钮的悬停、活跃引擎指示灯、图例圆点。其余任何新增表面不得自带辉光——屏幕某处亮起来，就必须意味着有东西在运行或被选中。

**The Three-Light Rule.** 青 = 侦察/主操作，琥珀 = 警告/进行中，紫 = AI。三者不可互换，也不可扩展出第四种语义色；需要新语义时优先复用绿/红。

**The AA-First Rule.** 任何承担文字的新颜色，必须在其所落的底色上（白底、面板底、淡色提示底）实测 ≥4.5:1 才算通过。本批次的对比度修正（`--text-faint` 两主题、浅色 cyan/green/red）就是这条规则的结果。

## Typography

**Display / Numeral Font:** Orbitron（`--font-num`，回退 `monospace`）
**Body Font:** Noto Sans SC（`--font-cn`，回退 `'Microsoft YaHei UI', sans-serif`）
**Label / Mono Font:** Share Tech Mono（`--font-mono`，回退 `monospace`）

**Character:** Orbitron 只在两个地方出现——品牌字与数字读数——因为它的几何宽字面天然像仪器刻度盘上的数码字；Share Tech Mono 承担所有标签、路径、时间戳和机器数据，是"仪表刻印"；中文正文交给 Noto Sans SC，保证汉字在 12–13px 的密集度下仍然可读。三者的分工是**语层**分工，不是风格混搭。

### Hierarchy
- **Display**（Orbitron 900, 54px, line-height 1, `tabular-nums`）：仅用于锻造判定区的一处还原度百分比（`.score-num`）。带 `0 0 32px` 的文字辉光，辉光色随评级切换（绿/琥珀/红）。
- **Headline**（Orbitron 700, 24px, letter-spacing 0.3em）：品牌字 `HEIMDALL`（带 `0 0 24px` 青色文字辉光）；详情坞标题降一档到 19px / 0.06em。
- **Stat**（Orbitron 700, 26px, `tabular-nums`）：星图 HUD 的 pages / edges / origin 读数与存储 KPI 数值（18px），全部 `tabular-nums` 以免数字跳动。
- **Title**（Noto Sans SC 500, 15px）：报告卡标题；设置卡标题 14px。
- **Body**（Noto Sans SC 400, 12.5–13px, line-height 1.6–1.8）：说明段落、设置表单、报告卡描述、空态文案。正文最大宽度以 `70ch` 封顶（`.storage-head p`）。
- **Label**（Share Tech Mono 400, 10px, letter-spacing 0.12–0.34em）：字段名、分组名、仪器刻印（`OBSERVATORY`、`TASKS`、`VISUAL FIDELITY`）。中文标签在同一行以 Noto Sans SC 跟随。
- **Mono data**（Share Tech Mono 400, 11–12px, letter-spacing 0.04em）：URL、路径、时间戳、`分`/`%` 读数、站点名。

### Named Rules
**The Three-Voice Rule.** 全文只有三套字：Orbitron（数字与标识）、Share Tech Mono（标签与数据）、Noto Sans SC（正文）。新增界面不得引入第四套字族，也不得把 Orbitron 用在句子级文本上。

**The Readable-Floor Rule.** 10px 是字号的绝对下限，且只有字距 ≥0.12em 的全大写拉丁标签可以用。承担阅读的正文不得低于 12px；窄屏（≤768px）不缩小正文字号，只改变布局。

## Layout

骨架是**固定定位的仪器 chrome + 中间的工作视图**。`html/body/#app` 高度铺满且 `overflow: hidden`，页面本身从不滚动；只有工作视图的正文区滚动。星图视图下，浮层围绕四边分布：左上 `.hud`（品牌 + 统计 + 状态）、顶部居中 `.seek`（主题切换 + 域名输入 + 侦察）、其下 `.sites`（站点条）、左下 `.panel`（仪表面板，窄屏默认折叠为 `.panel-open`）、左下角 `.task-center`、底部居中 `.keys` 与 `.view-nav`、右侧 `.dock`（页面详情坞）。工作视图下这套星图浮层不渲染。

面板内边距写死为 `14px 16px`（`.panel`）、`16px`（`.report-card` / `.set-card` / `.storage-card`）；间距阶梯 2/4/6/8/10/12/14/16/18px，星图 HUD 的统计间距是唯一的大跳跃（30px）。（此前的 `--dust` / `--pad` 两个 token 零引用，已删除。）

- **工作视图 `.work-view`**：`position: fixed`，`left/right: 24px`，`top: 78px`，`bottom: 86px`，flex 列，`overflow: hidden`。上为 `.wv-head`（品牌名 + 统计 + 站点选择器 + 筛选 + 动作 + 返回星图，`flex-wrap: wrap`，底边 1px 青色细线），下为可滚动内容区（`.wv-rows` / `.reports-scroll` / `.settings-grid`）。
- **表格**：`.wv-row` 是 11 列 CSS Grid（勾选 34px / 路径 / 标题 / 类型 / 状态 / 视觉 / 资产 / 缺口 / 交互 / 更新 / 操作），`min-width: 1180px`，横向滚动由 `.wv-rows` 承担。表头 `.wv-th` 粘顶。列随视口分级丢弃：1560px 丢「更新」、1360px 丢「交互」、1180px 丢「资产」、1024px 丢「类型」，同时逐级压缩列宽与 `min-width`（1180→1040→960→860→760）。
- **报告中心**：`.reports-scroll` 是 `repeat(auto-fit, minmax(240px, 1fr))` 自适应网格，间距 14px；跨列卡片用 `.report-wide`（`grid-column: 1 / -1`）。1440px 下自然形成 5 列。
- **设置**：`.settings-grid` 单列 flex，`max-width: 860px`；表单是 `96px 1fr` 的两列网格，保证标签列对齐。
- **底部导航 `.view-nav`**：固定底部居中，5 个视图（星图/页面/任务/报告/设置），每项图标在上、标签在下，激活项青色 + `rgba(34,211,238,.10)` 底。
- **移动端 ≤768px**：`.work-view` 撑满宽度，`top: 118px`、`bottom: 64px`；`.wv-head` 的每个控件独占整行；`.wv-row` 从 Grid 改为 `flex-wrap` 卡片，表头整行 `display: none`，各单元格用 `::before` 补写中文前缀（`视觉 ` / `缺口 ` / `资产 ` / `类型 `）并按 `order` 重排；报告网格自然塌成单列；`.keys`、`.archive-link`、`.audit-link` 隐藏。表格允许横向滚动，但控件永不因滚动而不可达。

## Elevation & Depth

**这个系统没有投影。** 深度由三样东西表达：1px 细线（`--line: 1px`，青色 `-line` 或中性 `hairline`）做层级切分；面板内 `linear-gradient(180deg, …)` 的暗色渐变做"凹陷的玻璃后面是仪器"的观感；以及受约束的文字/方框辉光做状态。唯一拥有真实"高度"的表面是右侧详情坞 `.dock`：它 `z-index: 10`、宽 32%（`min-width: 400px`）、左侧 1px 青色边、`backdrop-filter: blur(14px)`，顶部还有一条 sticky 的 2px 青色渐隐亮线（`.dock::before`）。除此之外没有任何 surface 抬升；悬停与聚焦靠**边框颜色变化 + 发光**表达，不靠位移。

### Shadow Vocabulary
全部是辉光（`box-shadow`/`text-shadow`），没有 offset 投影：
- **Brand halo**（`text-shadow: 0 0 24px rgba(34,211,238,.55)`）：品牌字；浅色主题显式置 `none`。
- **Stat halo**（`text-shadow: 0 0 14px rgba(34,211,238,.5)`）：HUD 统计数字；浅色主题置 `none`。
- **Tick glow**（`box-shadow: 0 0 8px var(--cyan)`）：`.hud-rule` 上的 5px 刻度方块。
- **Verdict halo**（`text-shadow: 0 0 32px rgba(...)`）：还原度大数字，按绿/琥珀/红切换。
- **Status dot / legend dot**（`box-shadow: 0 0 8px rgba(52,211,153,.7)` / `0 0 6px currentColor`）：运行时圆点与图例色点。
- **Control hover glow**（`box-shadow: 0 0 26px rgba(34,211,238,.35)` / `0 0 16px rgba(245,158,11,.3)` / `0 0 18px rgba(34,211,238,.2)`）：锻造按钮、批量锻造、档案/审计链接的悬停。
- **Inset glow**（`box-shadow: 0 0 20px rgba(34,211,238,.25) inset`）：搜索栏"侦察"按钮的悬停。
- **Dock separation**（`backdrop-filter: blur(14px)` + `border-left: 1px solid var(--cyan-line)`）：全站唯一的模糊面。

### Named Rules
**The No-Drop-Shadow Rule.** 不使用任何带偏移的投影。需要"更高一层"时，用更亮的 1px 边框、更暗的渐变地或 z-index 分层来表达；需要"醒目"时用辉光，且仅限于状态与选择。

**The Glow-Follows-State Rule.** 辉光永远是状态变化的**结果**，不是静态装饰：静默元素悬停时才亮，运行时才呼吸，选中时才滞留。默认态的控件没有辉光。

## Shapes

几何语言是**仪器的方形**：面板 4px 圆角（`--r`），控件 3px，进度条/滚动条 2–3px，胶囊 999px（仅 `.set-badge`）。没有一处完全直角，也没有一处圆角超过 4px——圆角只用来削掉数字屏的锐利，不表达柔性。

- **1px 是默认笔触**（`--line`）；2px 只用于面板四角的 L 形刻度（`.hud-panel::before/::after`，10×10px，`border-width: 2px 0 0 2px` / `0 2px 2px 0`，色 `--cyan-dim`）。这是全系统唯一的"角装饰"，也是辨识度最高的形状特征。
- **虚线表示"辅助/待定"**：`.seo-note`、`.intel-bar`、`.storage-actions` 的左分隔、`.set-foot` 的上分隔都用 `1px dashed`，与实线区分主从。
- **圆点 = 状态**：图例 8px 圆点、引擎指示灯 8px 圆点、阶段步进器 6px 圆点、扫描中的 8px 空心圆。全部 `border-radius: 50%`。
- **滚动条是系统的一部分**：宽/高 6px，滑块 `--cyan-line`、悬停 `--cyan-dim`，3px 圆角。
- **文本选中**底色 `rgba(34,211,238,.3)`。

## Components

### Buttons
- **Shape:** 3px 圆角（`{rounded.sm}`），1px 描边。
- **Primary:** 青色底纹 `rgba(34,211,238,.12)` + 青色文字 + `rgba(34,211,238,.5)` 描边，内边距 `6px 12px`，字号 12px（`.wv-primary`）。锻造按钮是它的放大版：`linear-gradient(180deg, rgba(34,211,238,.22), rgba(34,211,238,.06))` 底、实心青色 1px 边、全宽、`13px 0`、14.5px 字与 0.2em 字距。
- **Hover / Focus:** 悬停只改描边色（→ `--cyan-dim`）或加深底纹；主按钮悬停加 `0 0 26px rgba(34,211,238,.35)`。键盘聚焦走全局 `:focus-visible`：`outline: 2px solid var(--cyan); outline-offset: 2px`。位移过渡 180ms（`--dur`）。
- **Ghost / Row action:** 无底色、`rgba(148,163,184,.25)` 描边、`--text-dim` 文字、`3px 7px` 内边距、11px 字（`.wv-actions`、`.panel-collapse`、`.dock-close`）。悬停转青色。
- **Danger:** 红字 + `rgba(239,68,68,.35…)` 描边 + `rgba(239,68,68,.06)` 底（`.danger`、`.storage-buttons .danger`）。禁用态一律 `opacity: .35–.5` 且 `cursor: not-allowed`（不是 `default`，只有存储卡用 `default`）。

### Chips
- **Style:** 「更多报告」与详情坞快捷链接用胶囊式 chip：青色文字、`--cyan-line` 描边、3px 圆角、`5px 10px`、12px 字，无底色。悬停加 `rgba(34,211,238,.08)` 底。
- **State:** 站点 chip（`.site-btn`）有默认 / 悬停 / `active`（青字青边）/ `empty`（整体 `opacity: .55`、描边转红、计数转红）四态。列表切换按钮复用 chip 形状并加 `active`。

### Cards / Containers
- **Corner Style:** 4px（`{rounded.md}`）。
- **Background:** 面板基类 `.hud-panel` = `linear-gradient(180deg, rgba(30,30,35,.92), rgba(20,20,26,.94))`；浅色主题变纯白 `#FFFFFF`。报告卡、存储卡、设置卡、工作视图、详情判定区、底部导航全部继承 `.hud-panel`。
- **Shadow Strategy:** 无投影，见 Elevation & Depth。
- **Border:** `1px solid var(--cyan-line)`，加四角 L 形刻度。
- **Internal Padding:** 卡片 16px（`.report-card`、`.set-card`、`.storage-card`）；面板 14px 16px。

### Inputs / Fields
- **Style:** `rgba(255,255,255,.04)` 底（浅色转 `#FFFFFF`）、`1px solid var(--cyan-line)`、3px 圆角、`6px 9px` 内边距、12px 字。下拉必须声明 `color-scheme: dark`（浅色主题声明 `light`）并把 `option` 背景显式写死（暗色 `#14141a`/`#e2e8f0`，浅色 `#fff`/`#0f172a`），否则原生选单会在深色主题里闪白。
- **Focus:** 全局 `:focus-visible` 是 2px 青色环（`outline-offset: 2px`）。两处例外各有等价替代，**不得再退回 `outline: none` 且无替代**：
  - `.seek input` 自身无边框（`border: 0`），焦点由外层药丸表达：`.seek:focus-within { border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan-dim) }`。
  - `.set-form` 的 `select` / `input`：`outline: none` 但同时换成 `border-color: var(--cyan)` + `box-shadow: 0 0 0 2px rgba(34,211,238,.28)`。
- **Disabled:** `opacity: .4–.5`，`cursor: not-allowed`；`.sp-select` 无站点时禁用并显示「尚无已侦察站点」。
- **Placeholder:** `--text-faint`，`opacity: .85`。

### Navigation
底部 `.view-nav` 是固定居中的仪器坞：`.hud-panel` 底、4px 内边距、每项 62px 最小宽（窄屏 56px）、图标在上标签在下（13px / 10px）。默认 `--text-faint`，悬停 `--text`，激活青字 + `rgba(34,211,238,.10)` 底 + `aria-current="page"`。星图左上 `.hud` 另有品牌字、1px 青色渐隐横线与三个统计读数；顶部 `.seek` 是主题切换 + 域名输入 + 侦察按钮的组合条，输入框无边透明底、按钮左接 1px 青色分隔线。

### Signature Components

**Instrument Panel（`.hud-panel`）** — 全系统的唯一表面基元，也是这个世界最可识别的形状：1px 青色细线 + 4px 圆角 + 四角 10px L 形刻度 + 暗色渐变地。任何新容器都应该是一个 `.hud-panel`，而不是一个新发明的卡片。

**Work View（`.work-view` + `.wv-head`）** — 工作台化的核心：整高固定面板，表头一行承载站点选择器、统计、筛选与动作，正文区独立滚动。星图浮层严禁出现在工作视图内。表头控件在 ≤768px 每个独占一行，保证窄屏下没有一个按钮被挤出可达范围。

**Data Table Row（`.wv-row`）** — 11 列 Grid，粘顶表头，行悬停 `rgba(34,211,238,.05)`，`--dur` 全局过渡。状态列用文字色表达语义（已克隆绿 / 克隆中琥珀 / 失败红 / 未克隆弱灰），URL 列是青色等宽可点项，操作列是 ghost 按钮组。排序表头在悬停时转青。

**Site Picker（`SitePicker.vue`）** — 工作视图表头里的站点切换器 + SEO 审计动作。为什么存在：站点切换曾是星图浮层，在工作视图里会压住内容、窄屏下按钮被裁。它把选择器放进表头，让四个工作视图各自持有站点上下文。

**Icon（`Icon.vue`）** — 自绘 SVG 图标集，统一 24 网格、1.6 描边、圆头圆角，`width/height: 1em`、`stroke: currentColor`。存在的理由是 Unicode 字形（☰ ☾ ☀ ✕）跨平台字形不一、基线不可控、描边无法统一，且读屏会把符号当正文念出。仅图标按钮必须传 `label`，与可见文字同用时传 `decorative`。

**Storage Card（`.storage-card`）** — 报告中心的跨列证据卡，内部三段：KPI 四瓦片（实际占用 / 逻辑体积 / 可回收 CAS / 站点数，Orbitron `tabular-nums`）、站点占用条（按最大站点归一化的青色条 + 等宽右对齐数值 + 文件数）、CAS 回收区（虚线左分隔）。回收是**预览 → 二次点击确认 → 执行**的三段式，附「nlink=1 才进候选」的安全判据说明，绝不一键毁灭。窄屏下 KPI 塌成 2 列、主体塌成单列。

**Stage Stepper & Verdict（`.stages` / `.verdict`）** — 六阶段仪表格（编号 + 名称 + 状态圆点），状态四态：静默 / `running`（琥珀边 + 琥珀呼吸圆点）/ `done`（绿点 + 绿编号）/ `skipped`（`opacity: .5`）。判定区用 54px Orbitron 数字 + 组成部分解 + 可修差异进度条（绿→青渐变填充）收束。

**Detail Dock（`.dock`）** — 右侧 32% 详情坞，四个标签页（概览 / SEO 剖析 / 质检 / 锻造克隆）。`ov-grid` 是 2 列键值瓦片，`q-list` 是「键 120px + 值」的虚线分隔行，`seo-row` 用边框色表达 ok / warn。它是全站唯一带 `backdrop-filter` 的表面。

## Do's and Don'ts

### Do:
- **Do** 让每一个新容器都成为 `.hud-panel`：`1px solid var(--cyan-line)`、4px 圆角、四角 L 形刻度、暗色渐变地。这是系统的单一表面基元。
- **Do** 周边绕 `--cyan-line` / `--cyan-dim` 组织，并在浅色主题显式翻转；浅色主题的面板与详情坞写纯白 `#FFFFFF`。
- **Do** 按 `The Three-Light Rule` 分配语义色：青 = 侦察/主操作，琥珀 = 警告/进行中，紫 = AI（仅 AI 校准与情报），绿 = 完成，红 = 失败/危险。
- **Do** 按 `The Glow-Is-Evidence Rule` 收束辉光：只有状态与选择发光，且只在悬停、运行、选中时出现。
- **Do** 用 `Icon.vue` 的 `<Icon name="…" />` 提供 chrome 图标（24 网格 / 1.6 描边 / 圆头 / `1em` / `currentColor`）；仅图标按钮传 `label`，与可见文字同用传 `decorative`。
- **Do** 用三套字按 `The Three-Voice Rule` 分工，并守住 `The Readable-Floor Rule`：正文 ≥12px，10px 只给带 ≥0.12em 字距的全大写拉丁标签。
- **Do** 在 `types.js` 里为每个页面类型注册 `color` + `light` 两值，浅色值必须在白底上 ≥4.5:1，并只用 `typeColor(type, theme)` 取值。
- **Do** 给原生 `<select>` 声明 `color-scheme` 并显式写 `option` 背景（暗 `#14141a` / 浅 `#fff`），否则深色主题下选单会闪白。
- **Do** 让销毁性动作走预览 → 二次确认 → 执行（存储回收、CAS 回收、删除站点），并始终显示影响范围与释放量。
- **Do** 复用既有的中性细线字面值 `rgba(148,163,184,.10)`（行分隔）与 `rgba(148,163,184,.16)`（中性描边），不要发明新的灰阶。
- **Do** 在工作视图里用 `.wv-head` 承载站点选择器与筛选，让正文区独立滚动；表格可以横向滚动，但控件不得不可达。

### Don't:
- **Don't** 使用任何带偏移的投影（`The No-Drop-Shadow Rule`）；深度用细线 + 色阶表达。`backdrop-filter: blur(14px)` 只属于详情坞。
- **Don't** 引入玻璃卡片墙、渐变文字或装饰性霓虹——世界本身靠细线与克制辉光说话，这三点是已确认的视觉拒绝项。
- **Don't** 在非 neobrutalist 的世界里引入硬偏移阴影；本世界没有，也不要加。
- **Don't** 把 Orbitron 用到句子级文本上，也不要引入第四套字族。
- **Don't** 把 Star Map 的浮层（`.hud`、`.sites`、`.keys`、`.panel`、`.task-center`）渲染进工作视图——它们会压住任务内容，这正是本批次把它们限定在 `view === 'atlas'` 的原因。
- **Don't** 在组件里写死深色背景而不提供浅色主题覆盖；星图浮层的五处写死底色曾导致浅色主题下出现 1.45:1 的不可读组合。
- **Don't** 把 8–9px 当正文用；密集不等于微小。
- **Don't** 让同一语义有两种颜色，或让同一颜色承担两种语义（`The Three-Light Rule`）。
- **Don't** 把 KPI、评分或体积填成虚构数据——指标必须能下钻到产物或请求。
