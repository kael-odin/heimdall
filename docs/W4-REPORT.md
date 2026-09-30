# W4 验收报告 · 情报包与三维公式闭环

日期：2026-09-30 · 状态：**✅ 阶段通过（规则版 harvest + 全五阶段流水线）**

## 结果

- **流水线五阶段全绿**：捕获骨架 → 注入皮肤 → 渲染校准 → 像素定谳 → 情报入库。实测 apify use-cases 页 **99.2%（A）**，情报包：标题 33 · 价格 2 · CTA 17 · 链接 96。
- **三维还原度公式闭环**：`total = 0.5×pixel + 0.3×dom + 0.2×data`。data = 六维字段覆盖率（meta/headings/prices/cta/tables/links 的 src→clone 覆盖）的均值。home 页修复后 data 100%，total 95.8 → **98.3%**。
- **harvest 规则版 v1**：parse5 抽取 meta/h1-3 树/价格 token/CTA/表格/站内链接 → `intel/intel.json` + `intel/intel.csv`（Excel 直开）。**LLM 增强留插槽**（env `HEIMDALL_LLM=1`，待接 key）。
- **施工舱 W4**：第五 chip"情报入库"（紫色语义=数据层）、情报包摘要条、"锻造内环"按钮（串行 6 页逐颗点亮）。

## 关键修复：数据维度的"假价格"

data 首测 87.5%，prices 维度仅 37.5%。追查发现 `$5`/`$14` 这些根本不是价格——是 **Next.js RSC payload 里的组件引用 token**（`["$","$5",null,...]`），而 harvest 的 walk **不剪枝**，`<script>` 内部 `#text` 全被当可见文本累加。src（含脚本数据）与 clone（脚本已删）天然不等价。修复 = 子树剪枝的 `textOfVisible`（情报只认可见文本，这也是情报语义本身的要求）。修复后 prices 100%。

方法论：维度分数异常时，**把两侧集合打印出来做差集**，一眼定位污染源——比看总分猜快十倍。

## 待办（W4 后半 → 终审）

1. **LLM 增强决策**：harvest 语义抽取（功能矩阵/产品名/套餐结构）+ L3 diff 修复循环都需要 LLM API——需用户确认可用通道（如智谱 glm key）后接入
2. Excel 真格式（exceljs）替代 CSV；情报包跨页汇总视图
3. 批量 forge 并发加速（现串行 ~1 分钟/页）
4. 视觉打磨专项（impeccable / ui-ux-pro-max，2D→3D 决策）
