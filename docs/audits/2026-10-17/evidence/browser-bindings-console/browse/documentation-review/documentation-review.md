# Browser 来源归属界面：设计文档收尾核对

2026-10-17 · fresh Impeccable documenter · **documentation-complete**

本片属于现有项目验收工作台中的 **Operate / code-led / 普通扩展**。最终实现与既有 token、组件处理及实际截图一致；文档收尾完成。既有 finish review 的结论为 `ship`，本核对没有改变其范围。

## 范围与设计文件结论

仅核对 `console/src/AcceptanceCatalog.vue` 的接线、`AcceptanceBrowserBindings.vue`、`acceptance-browser-bindings.js`，以及邻近 Catalog / Baseline / Execution 的既有样式和共享 CSS。产品方向输入为 AI 比赛“自动验收开发项目还原度 BUG 检测系统”；用户已授权实现决策。本片只负责运行来源侧的组织归属与证据核对。

**本片无需更新 DESIGN.md + .impeccable/design.json 双文件。** `reference/new-work.md:33` 规定扩展继承现有世界和构图；`:150` 区分了两种收尾：新世界或批准的系统变更必须写 token-bearing DESIGN.md 和 sidecar；普通扩展应比较最终构建、保留系统文件并报告证据和既有漂移。本片没有新世界、系统 token 变化、批准 comp 或 shipping raster。`reference/document.md` 的 token 提取和 canonical 值保留规则用于这次比较，不被扩成全局文档修复。

根 PRODUCT.md / DESIGN.md 缺失不抹去代码中已建立的视觉系统，也不构成本片阻断。已有 `.impeccable/design.json` 和 Atlas surface brief 均保持原样。父任务已运行本会话唯一一次 context，报告根文档缺失、Atlas brief 不匹配 Catalog；本 documenter 没有重复 context 或运行 doctor。

## 最终实现与 incumbent 比较

| 方面 | 核对结果 | 证据 |
| --- | --- | --- |
| 深浅主题与语义色 | 一致。新组件使用既有背景、表面、文字、边线、accent、ok、warn、bad 变量。sidecar 的 10 组 dark/light canonical 配色与当前 CSS 一致。 | `style.css:19-85`；`AcceptanceBrowserBindings.vue:208-270`；sidecar colorMeta。 |
| 字体与信息密度 | 一致。系统 UI 字体、12px 工作台文案、13/14px 标题、11px 等宽 ID/路径与邻近工作台共用语言。未创建新的全局字体级差。 | `style.css:47-49,104-108`；新组件 `:208-216`；Catalog `:367-383`；Baseline `:214-230`。 |
| 控件、形状与状态 | 一致。原生 select/input/checkbox/details，44px 操作目标，6px 小圆角、1px token 边线、平实表面、相同 hover/focus 和语义反馈。 | 新组件 `:164-177,218-245,254`；Baseline `:225-230`；Execution `:281-287,304`。 |
| 组成与响应式 | 一致。归属表单 → 已存历史 → 所选核对 → 按需证据披露，嵌入已有内部滚动工作台。窄屏字段单列、事实纵排，长 URL/ID 换行。 | 新组件 `:220,249,263,272-273`；8 张截图；`layouts.json`。 |
| 产品真值与证据层级 | 一致。来源侧明确选择并重新确认；已存历史与实时核对分离；变化来源有警示；URL 查询已隐藏；证据按需读取校验。Browser 批准/选用/执行保持关闭。 | 新组件 `:171-197`；helper `:147-169,207-237`；`browser-checks.json`。 |
| 视觉资产 | 无新世界资产要求。页面中显示的保存截图是证据内容；8 张 PNG 是测试材料，均不构成 shipping raster 或 comp。 | 新组件 `:197`；截图；finish review 的既有边界。 |

## 实际核对的证据

读取了 `browser-bindings-console-review-20261017/finish-review.json` 和 `.md`，其结论为 `ship`、无 material finding。独立打开并目视了 smoke 目录中的全部 8 张 captures：桌面 dark 的 form/review/evidence/source-changed，以及 390px 移动端 dark/light 的 form/review。截图非空，主题、状态与命名对应；这些是工作台滚动区域的视口截图。

读取了同一 smoke 目录的 `browser-checks.json`、`layouts.json`、`browser-errors.json`：已有真实 CDP 产物记录 **14/14** 检查通过、8 个布局均无横向溢出、0 pageErrors、归属/核对阶段 0 目标请求、`executionReady: false`。这是 2026-10-17T04:22:50.214Z 的受控本地 fixture / 真实 engine worker 证据。本 documenter 只读这些结果，未复跑。

## 既有漂移与保留决定

| 项目 | 当前证据与处理 | 是否阻断本片 |
| --- | --- | --- |
| 根 PRODUCT.md / DESIGN.md 缺失 | 文件不存在；本片没有新建或补写全局产品/设计文档。 | 否 |
| sidecar 没有相应根 DESIGN.md | schemaVersion 2，generatedAt 为 2026-10-10T16:10:37.496Z；保留现有 3 个组件样例及其生成器声明。已核对配色一致，不将旧时间戳单独视为值失配。 | 否 |
| 现有 surface brief 为 Atlas | `primary_target: console/src/Atlas.vue`，不匹配本片 Catalog；保留该文件，不把 Atlas 页面构图提升为本片约束。 | 否 |
| 唯一已提供 detector 项是旧 Catalog 边线 | `border-left: 2px solid var(--accent-dim)` 内容与 HEAD 相同；当前为 Catalog `:373`，既有 finish-review 写作 `:374`，属于行号变化。未运行第二次 detector，未修旧壳。 | 否 |

## 写入边界与后续有效性

本次仅在新目录 `core/workspace/_runs/browser-bindings-console-documentation-20261017/` 新建本 MD 和 `documentation-review.json`。未修改产品源码、公开文档、README、DESIGN.md、sidecar 或 surface brief；未读取 agents 定义文件；未运行 build、browser、tests、detect、context 或 doctor。JSON 记录了三个目标源码和四个保留系统文件的 SHA-256，以便后续门禁判断是否仍为同一快照。

核对范围不覆盖全局设计系统整理或完整比赛产品验收；没有新增键盘实测或数值对比度测试，也不声称任意站点通用可用。证据覆盖桌面深色与 390px 移动端深浅色。后续若修改产品或视觉实现，需要重新核对受影响的比较与证据；本片缺少历史全局文档不产生额外审批点。