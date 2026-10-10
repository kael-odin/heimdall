---
version: 1
slug: "console-src-atlas-vue"
primary_target: "console/src/Atlas.vue"
related_targets: []
---

# Heimdall Console · Batch 2

## Scope

- Mode: Operate
- Primary target: `console/src/Atlas.vue` and its shared console styles
- Preserve: deep-space observatory/HUD identity, current star-map default, existing task semantics, Chinese business terminology, all working API/task/clone/report actions
- Add: storage governance visibility, CAS reclaim preview/apply, evidence-first quality details, WCAG AA interaction baseline

## Direction contract

### THESIS
把星图保留为 Heimdall 的记忆点，但让控制台成为一座可工作的观测站：用户先知道当前站点、任务状态、质量风险和可执行操作，再进入星图探索。拒绝把每一项能力继续堆进单个浮层或单体组件。

### OWN-WORLD
深空观测站继续作为产品识别：深渊底色、青色侦察、琥珀警告、紫色 AI、1px 仪器线和克制辉光。把发光收敛到状态与选择，把正文抬到可读字号，使用更清晰的中性层级、明确焦点环和语义颜色；不引入玻璃卡片墙、渐变文字或装饰性霓虹。

### STORY
混合团队打开控制台后，仍可探索星图，但能在几秒内切换站点、看到克隆/SEO/验证任务、发现质量告警和磁盘/CAS 状态。研发从页面详情进入证据与镜像，SEO/增长从报告和页面清单进入审计结果；删除或回收空间前先看到影响与释放量。

### FIRST VIEWPORT
保持星图默认入口。顶部为品牌、当前站点选择和主任务状态；底部导航保留星图/页面/任务/报告/设置。页面/报告/设置工作视图采用真正可滚动的工作区，不遮挡任务。报告中增加存储治理卡：站点逻辑体积、实际占用、CAS 在用/孤儿、扫描、回收预览与二次确认操作。

### FORM
工作台优先、星图探索保留；组件从 `Atlas.vue` 按职责拆出（AppShell/Navigation/SiteSwitcher/TaskCenter/Pages/Reports/Settings/Atlas/Detail），先用 Vue 3 原生组合式状态，避免为了拆分引入无必要的状态库迁移风险。存储卡使用数据密度与证据链接，不用同尺寸装饰卡片堆叠。

### FINISH
unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Quality bar

- WCAG AA contrast target for body/control text; visible `:focus-visible`; keyboard-reachable controls; reduced-motion fallback.
- Every new storage action has loading, error, empty, preview, confirmation and success states.
- CAS apply is never a one-click destructive action: preview shows candidate files/bytes; apply requires explicit confirmation and reports freed/skipped/failed.
- Desktop and narrow viewport both remain usable; table content may scroll horizontally but controls cannot become unreachable.
