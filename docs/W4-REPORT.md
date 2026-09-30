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

# L4.5: LLM 增强层
- core/llm.mjs：OpenAI 兼容客户端（.env 配置，key 不入库），文本/JSON/视觉全通，网络重试×3 + AbortSignal 超时（中转站偶发半死连接会永久悬挂 fetch）
- 双模型：glm-5.3-flash 主（质量）/ deepseek-flash fast（速度 10s 级 vs glm 2-4min），fixup 用 fast
- core/differ/fixup.mjs：L3 AI 校准循环——双截图喂视觉模型 → JSON {analysis, css} → 写 clone/styles/fixes.css → 重截重 diff → 分数提升保留/下降回滚（≤2 轮），fixup-history.json 分数曲线
- capture/shot 同时出 jpeg 小图（quality 55）供视觉调用（全尺寸 png base64 2.5MB+ 会撞中转限制）
- pipeline：fixup 阶段 + FIXUP_PIXEL_GATE 门控（.env 可配，默认 0.97；⚠️ pixel 门控是权宜——受动画噪声影响，"可修性判断"待精细化，用户已点名要调）
- E2E：95.4
## L4.5 追加：LLM 增强层与 AI 校准循环（2026-09-30）

- core/llm.mjs：OpenAI 兼容客户端（.env 配置，key 不入库），文本/JSON/视觉全通，网络重试×3 + AbortSignal 超时（中转站偶发半死连接会永久悬挂 fetch）
- 双模型：glm-5.3-flash 主（质量）/ deepseek-flash fast（速度 10s 级 vs glm 2-4min），fixup 用 fast
- core/differ/fixup.mjs：L3 AI 校准循环——双截图喂视觉模型 → JSON {analysis, css} → 写 clone/styles/fixes.css → 重截重 diff → 分数提升保留/下降回滚（≤2 轮），fixup-history.json 分数曲线
- capture/shot 同时出 jpeg 小图（quality 55）供视觉调用（全尺寸 png base64 2.5MB+ 会撞中转限制）
- pipeline：fixup 阶段 + FIXUP_PIXEL_GATE 门控（.env 可配，默认 0.97；⚠️ pixel 门控是权宜——受动画噪声影响，"可修性判断"待精细化，用户已点名要调）
- E2E：95.4% 页触发校准→回滚正确；99+ 页跳过。校准曲线前端可见

## W5：评分与校准机制正名（2026-09-30，用户指令"减少权宜之计"）

### 多帧采样评分（动画噪声根除）
- capture 产 3 帧（frame-1/2/3，间隔 1.2s，JS 动效不受 CSS 冻结，帧间差即噪声证据）
- differ：评分取「与克隆差异最小的帧」；帧间差集=动态区域掩码；最好帧差异拆分为 dynamicPx/staticPx
- score.json 新增 breakdown：{frames, bestFrame, dynamicPx, staticPx, dynamicShare, refinable}
- home 实测：动态噪声 5%（3531px）被识别排除，refinable 95%，TOTAL 97.2% A

### 可修性门控（pixel 单维门控废弃）
- fixup 自判：staticShare ≥ 0.002 且 refinable ≥ 0.3 才值得 AI 校准（.env: FIXUP_MIN_STATIC / FIXUP_MIN_REFINABLE）
- 动画噪声页自动豁免（emit fixup-skip，前端显示豁免原因）；prompt 同步告知"不要修动画"

### 校准循环的守门与状态一致性（实战教训）
1. **回滚必须重截**：ROLLBACK 清 fixes.css 后 shot-clone.png 残留"带补丁"的截图，污染下一轮基线（曾致 LLM 把 JSON 错误页当克隆页分析）——回滚后重截+重 diff 恢复基线
2. **补丁卫生检查**：括号平衡/体量上限/禁 body|html|通配符规则（某轮 165 字节补丁造成 -47 分：deepseek 把深色主题当差异修）
3. **AI 补丁命中率现状**：类名是 styled-components 哈希（sc-a54b2c-0），LLM 猜选择器命中率低——下一步给 LLM 喂差异区域 computed style 对比数据
4. 跨进程事件链：孙进程(fixup) stdout @@EVENT@@ 经 inherit 管道到 engine ✓ 验证通过

### 结构清理
- env.mjs 统一（llm/pipeline 各自解析 .env 的碎片化终结）
- serve.mjs 退役：engine-server 常驻 /static/*（临时 serve 与端口冲突根除），shot/fixup 走 8900 静态路径
