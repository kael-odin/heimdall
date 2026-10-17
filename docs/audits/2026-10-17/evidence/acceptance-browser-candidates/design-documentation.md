# D2 设计继承审查记录

日期：2026-10-17。审查角色：Impeccable Documenter。范围：普通功能扩展，保留现有 Heimdall Console 身份。

结论：D2 的完整 Browser 候选合同延续现有工作台的暖中性色、黏土橙操作色、细边框、紧凑字号与原生折叠层级。此次只写此 ignored 审查记录；未新增 DESIGN.md、未再生成 `.impeccable/design.json`，未修改生产代码或修复既有风格漂移。

## 已检查的事实来源

- 角色约束：`C:/Users/44548/.agents/skills/impeccable/agents/impeccable_documenter.toml` 与 `reference/document.md`，完整阅读。
- 原有 token：`console/src/style.css:23` 起的深色和浅色 custom properties；`style.css:90` 的全局焦点与邻近禁用、reduced motion 规则；`style.css:118` 起的 `.surface`。
- 原有应用入口：本仓库没有 `App.vue`；`console/src/main.js:1` 引入全局样式，`:17` 挂载 `Atlas.vue`。`Atlas.vue:150` 起管理现有主题，`:1867` 挂载 AcceptanceWorkbench。
- 原有组件习惯：`console/src/ui.css`，以及 `AcceptanceCatalog.vue`、`AcceptanceBrowserBindings.vue` 的按钮、字段、列表、证据和 620px 响应式样式。
- 已有系统记录：`.impeccable/design.json`，schemaVersion 2，原 generatedAt 为 `2026-10-10T16:10:37.496Z`，明确由 `console/scripts/gen-design-json.mjs` 从既有源码生成。
- 本次产物：`console/src/AcceptanceBrowserCandidates.vue`、`AcceptanceBrowserBindings.vue`、`AcceptanceCatalog.vue`、`acceptance-browser-candidates.js`。
- 语法与行为证据：`core/workspace/_runs/browser-candidate-ui-helper-20261017-38c09d8a/`，8/8 helper 用例通过，JS syntax 通过，三份 Vue 的 parse、compileScript、compileTemplate 通过；该目录保留 stdout、stderr、命令退出状态与五文件 SHA-256。

## 五行系统摘要

1. 调色：沿用 `--bg` / `--surface` / `--surface-2` 的暖炭或象牙层次、`--text` / `--text-dim` 的阅读层级，黏土橙 `--accent` 用于明确主动作与焦点，状态继续使用 `--ok` / `--warn` / `--bad`。
2. 字级：现有正文系统字体栈保持不变；本次区域标题 14px、段内标题 13px、操作正文 12px，技术 ID 与原始 JSON 使用现有 `--font-mono` 的 11px，未新增展示字或字体资源。
3. 描边层次规则：表面层次由 1px token 描边与实色表面表达；新合同区域使用 `--r-sm`，沿用父目录的 10px 外面板与 6px 内部控件关系，未增设装饰渐变、硬阴影或粗侧边条。
4. 操作规则：按钮与 summary 保持至少 44px；主确认使用现有 accent 反色，次级读取使用 surface 描边，focus-visible 和 disabled 状态可辨；图标复用现有 Icon 组件。
5. 密度与阅读规则：合同按身份、计划、完整原始块、观察、摘要、确认顺序组织；原生 details 延迟挂载完整文本，不删字段；620px 以下标签、事实与按钮换行，图片保持容器内宽度。

以上“规则”是对已交付代码的审查性描述，未写成新的全局设计规范。

## 继承对照

| 观察项 | 原有应用事实 | D2 产物事实 | 审查结果 |
| --- | --- | --- | --- |
| 主题身份 | style.css 的暖中性底色、黏土橙与语义状态 token；Atlas 切换 `data-theme` | 三 Vue 样式使用既有 token；新合同区域未声明新颜色常量 | 继承 |
| 工作台层级 | Catalog、Browser Bindings 已有 24px 段间距、细分隔线、14/13/12px 字级 | Candidates 使用同样段间距和分隔线，嵌入 Catalog 后续流程 | 继承 |
| 控件外形 | 44px 最小高度、1px border-strong、r-sm 圆角、surface 底色 | 新按钮、确认框、折叠 summary 与同组来源操作保持同形态 | 继承 |
| 证据阅读 | Bindings 的原生 details、等宽技术文本、440px 内部滚动及自适应图片 | 完整合同保留所有原始字面量；按 details 延迟渲染；截图同一时刻仅显示一张 | 继承并按合同体积约束扩展 |
| 操作确认 | 上层目录已有显式 checkbox 与一次 POST，不自动认领 | 候选保存需完整 DTO 校验、人工 checkbox；结果未知时提供只读集合核对动作 | 流程语义与视觉状态一致 |
| 生命周期反馈 | 目录刷新、错误、成功提示与共享 writing 状态 | ready=false、切换、关闭或卸载即清理原文、确认与图片；父层保留安全提交事实 | 交互扩展，未新增品牌语言 |
| 文字与 URL | 既有技术区使用 code、文本节点和受控证据图 | raw plan、规则与 URL 均用 Vue 文本插值；helper 不建外链、不执行 HTML、不持久化原始合同 | 与证据工作台身份一致 |
| 图标与动态 | Icon SVG 组件、短状态反馈、全局 reduced-motion | 新读取动作复用 refresh SVG，保留轻微按下反馈，无新持续动画 | 继承 |
| 移动结构 | Catalog/Bindings 在620px 改为堆叠、事实标签独立行 | Candidates 事实网格改一列，行操作换行，证据按钮可扩展，原始文本换行 | 源码一致；实际最终视口由主任务 Browser 证据确认 |

## 不固化为规范的既有漂移

`style.css:48` 的 `--font-display` 仍别名到系统 UI 栈；`ui.css:15` 起的旧 brand-sub 字距和装饰性 brand-rule，以及 Atlas 若干旧 glyph 控件，属于此次功能之前已有的实现痕迹。Documenter 的 craft floor 不允许把这些直接提升为新的展示字体、装饰标签或图标规范；普通扩展也未授权重做整个应用，所以这里只记录，未固化或修复。

11px JSON/摘要字号仅记录为既有技术证据阅读区的实际样式，不推广为通用正文标准。对最终浅色/深色、移动端阅读与交互的结论以主任务的实际 Browser 证据为准；语法编译和 helper 测试不替代视觉验收。

## 本次验证边界

本审查基于当前源码、现有系统文件与已完成的本地纯 helper / SFC 检查。Documenter 未启动新 Browser、未执行 detector、未运行构建、未修改生产文件；集中运行的最终 build / Browser 验收由主任务负责。没有把未确认的运行结果写为通过。
