---
version: 2
slug: "console-src-atlas-vue"
primary_target: "console/src/Atlas.vue"
related_targets:
  - "console/src/ui.css"
  - "console/src/style.css"
  - "console/src/types.js"
  - "console/src/DetailDock.vue"
---

# Heimdall Console · Batch 3

## Scope

- Mode: Operate
- Primary target: `console/src/Atlas.vue` 及其拆出的组件与共享样式
- **Replace**: 深空观测站 / HUD 识别（Batch 2 的 "OWN-WORLD" 已作废）
- Preserve: 星图作为默认入口、任务语义、中文业务术语、全部可用的 API/任务/克隆/报告操作
- Add: SEO 回归基线门禁入口、交付包保留策略、v3 视觉系统

## Direction contract

### THESIS

把控制台从「一台仪器」改成「一张工作台」。Batch 2 建立了正确的工作流分工
（星图 + 四个工作视图 + 详情面板），但它把识别层放在霓虹辉光上 ——
而辉光是一种需要先学会才能读的语言，且**在浅色主题下根本不成立**。
用户每天要在这里读几十份报告，克制的界面在长时间工作下更耐用，
也更容易让别人愿意用它。

### OWN-WORLD

Anthropic / Claude Code 的产品语汇：暖炭（`#1F1E1D`）与象牙（`#FAF9F5`）、
单一黏土橙强调（`#CC785C` / 浅色 `#B05730`）、细描边叠柔和投影、
系统字体栈 + 等宽数字。没有辉光、没有四角刻度、没有内嵌渐变。

层级由「底色深浅 + 描边」表达，状态由「颜色 + 文字」双通道表达 ——
不再依赖"某处亮起来"。语义色（绿/琥珀/红/李）只做状态信号，不承担主操作。

### STORY

混合团队打开控制台，先看到当前站点、任务状态、质量风险和可以执行的操作。
研发从页面清单进详情面板拿证据（保真、缺口、历史），
SEO/增长从报告页进审计结果与基线回归；
两者都能在报告页看到磁盘占用、CAS 孤儿和交付包保留计划，删除前先看到释放量。

### FIRST VIEWPORT

星图仍是默认入口，但**首屏不再等 three.js**：
外壳（站点条、导航、工作视图）以 157KB 的包先可交互，1.4MB 的星图渲染层随后并行加载。
这既是首屏速度问题，也让日常改控制台代码不必重下那 1.4MB。

### FORM

组件拆分按**职责**而非行数：

| 组件 | 职责 | 状态归属 |
| --- | --- | --- |
| `Atlas.vue` | 壳：星图 + 站点条 + 仪表面板 + 任务中心 + 报告页 + 设置页 | 站点、选中页、任务 |
| `DetailDock.vue` | 单页详情四标签页 | 质检数据（含按站点缓存的 asset-gaps） |
| `PagesView.vue` | 页面清单 | 筛选/排序/勾选（纯视图状态不下发） |
| `ReportsView` 的卡片 | 存储治理 / 资产清单 | 各自持有（自带轮询与筛选） |
| `JobsView.vue` | 任务中心 | 无 |
| `Graph3D.vue` | 3D 星图渲染 | 无（色板由父组件按主题给） |
| `format.js` / `pages.js` / `api.js` | 共享纯函数与唯一 URL 拼接处 | — |

**拆分边界的两条规则**（踩过才写下来）：
1. 纯视图状态跟着组件走，不外传 —— 父组件从不读它们，用事件把结果带出去即可。
2. `<style scoped>` 只作用于本组件模板内的元素；抽出去的子组件内部元素拿不到
   `.wv-*` 这类类名，样式会**静默失效**（照常渲染，只是变丑，不报错）。
   所以共享的设计系统类先提成全局 `ui.css`。

### FINISH

unreviewed and undocumented is unfinished。本批次的验收全部是**实测**：
逐文本节点按真实合成背景量对比度、`scrollWidth === innerWidth`、
底部固定元素矩形重叠检查、逐功能点击验证（搜索/排序/勾选/标签页/回收/筛选）。
`DESIGN.md` 与 `VISUAL-SYSTEM.md` 已同步；`.impeccable/design.json`
改为从 `style.css` / `types.js` 生成（`pnpm -C console design`），不再手工维护。

## Quality bar

- 正文与控件文字过 WCAG AA；`:focus-visible` 全局可见；键盘可达；reduced-motion 降级。
- 破坏性操作（CAS 回收、交付包删除、站点删除）一律二次确认，且文案写明影响范围与释放量。
- 硬链接场景下"可释放"必须按 `nlink` 算，不能报目录大小 ——
  否则用户以为省了 300MB，实际只有 111MB。
- 桌面与窄视口都可用；表格内容可横向滚动，但**控件不得变得不可达**
  （Batch 2 的实测教训：390px 下站点切换器曾被裁掉）。
