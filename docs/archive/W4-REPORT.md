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

## W4 阶段三：AI 补丁弹药 + 情报包完整度（2026-09-30）

### style-probe（AI 补丁从"猜"到"照抄"）
- src/differ/style-probe.mjs：原站 vs 克隆逐元素 computed style 配对差异（L1 搬运保证 DOM 同构，按 tag.类:兄弟序号路径配对）
- 20 个关键属性（字号/字重/行高/颜色/背景/圆角/四向 padding/margin/宽高/display/textAlign）
- fixup 每轮先跑 probe，把"哪个元素哪个属性差多少"的精确清单喂给 LLM——选择器就在 path 里，弹药即选择器
- 实测：25 个元素的精确差异（skip-link 宽 146.97→137.84、导航 52.52→48.25 级别的分辨率）

### harvest LLM 语义增强（deepseek fast）
- 规则抽取拿到"字面"，LLM 抽"含义"：pageType / valueProps / products / plans(名称+价格+计费+权益) / notableClaims
- 只依据原文不编造（pricing 实测：5 套餐正确识别，无价格字段诚实标注"未标注"）
- intel/semantic.json 落盘，随 forge 自动生成

### 跨页情报 xlsx（exceljs，真 Excel）
- 每次 forge 后自动刷新 workspace/<host>/intel/<host>-intel.xlsx
- 三 sheet：概览（每页三维还原度+评级+可修性+语义类型）/ 语义情报（价值主张/产品/套餐/宣称）/ 定价与CTA 全量
- 实测 apify：概览 4 页、语义 60 行、定价与CTA 120 行

### 工程收口
- engine forge 并发槽 2（实测 200/200/409），侦察与锻造独立互斥
- pipeline 每轮自动刷新 host 级 xlsx

## W6：视觉打磨第一轮（2026-09-30，ui-ux-pro-max 设计系统）

- 设计规范：HUD/Sci-Fi FUI 风格（1px 细线仪器框/霓虹青点睛/等宽数据字/装饰括角/克制辉光），dials=variance 7/motion 6/density 7
- style.css v2：完整 token 体系（色/字/几何/动效时长全走变量）+ .hud-panel 装饰角基类
- Atlas.vue 换血：HEIMDALL 主标题+副标/分节线刻度、输入条 HUD 化、阶段 01-06 编号步进器（running 琥珀脉冲/done 绿点）、FIDELITY VERDICT 判定区（54px 大分数+三维拆解+可修性进度条）、SOURCE/MIRROR 双联标签
- 坑：Vue v-for 对象遍历第 2 参是 value 第 3 参才是 index——编号 NaN 修复
- 待续：星图节点贴缩略图、入场运镜、reduced-motion、星系盘面光照层次

## W6 视觉第二轮：星图分镜级渲染（2026-09-30）

- 节点贴缩略图（LOD）：根节点/hover/锻造完成恒星 + r≥7 才渲染贴图（其余纯辉光点保帧率）；球面光（中心亮/边缘暗）模拟行星受光；thumbCache 预载
- 盘面光照：星系核球（中心辐射冷光椭圆）+ 倾斜银河带（青→紫渐隐）
- 边深度：向内环渐亮（nearness 权重）
- 入场运镜：0-2.4s 相机由奇点 zoom 3.2→1 拉出（ease-out cubic）+ 前 0.8s 全屏白青爆发辉光；prefers-reduced-motion 直达终态
- 实测：无 pageerror；hover 卡、贴图球、核球光、银河带全部呈现

## W9：对比页打磨 + 待办清理（2026-09-30，用户点名对比体验）

### 同步对比 v2：统一桌面视口（响应式变形根除）
- 用户观测：窄容器里镜像触发响应式断点 → "明明很还原却看起来是移动版"
- 根因：左=1440px 快照缩到 58%，右=iframe 按容器宽 ~800px 渲染 → 命中平板/移动断点，两侧坐标系不同
- 修复：两侧统一 1440px 虚拟视口 + transform scale 等比缩放（zoom 标注实时显示）；iframe innerWidth 实测 1440 ✓；滚动同步保持 34/35%
- **方案定论（截图 vs 在线）**：在线 iframe 嵌原站被 X-Frame-Options 全挡（现代站标配），且 cookie/地域差异引入不可控变量；截图快照确定性、离线可靠——是正确选择。在线访问以"打开原站 ↗"按钮承载（新标签），做最终裁决用

### 待办清理
- clone-heimdall.cmd：一键启动（引擎+控制台+自动开浏览器，纯 ASCII）
- keeprate.mjs：AI 补丁命中率仪表——首份观测 5/17 = 29%（含 style-probe 前 history，目标 >40%，持续观测）
- forgeAll 扩到内环+外环 10 页（引擎 2 并发槽消化）

## W10：对比页体验收口 + 图标长尾清零（2026-09-30，用户实测反馈驱动）

### 用户实测三反馈全修
1. **镜像 footer 图标缺失**（Get in touch / Follow us）：三层病灶逐层剥——
   a) 内联 style 的 background-image（capture 只覆盖 src/href/srcset 的盲区）→ linker 2b 内联 url 本地化（49 处 + &quot; 双编码尾巴剥离）
   b) `styles/styles/` 双前缀 + `..../assets/` 四点残留（build 重写半途产物）→ css heal 归一
   c) ref 雪碧图缺失 → css 跨页借用（同站全局 CSS ref 序号一致，借用安全，实测九宫格图标全对）
   最终 thordata pricing 克隆页 404 → 0，footer 八个社交图标全渲染
2. **切页快照"未捕获"**：旧产物缺 shot-src-full.png → fullshot.mjs 批量补拍（Playwright 直开原站 fullPage，并发 2，不重跑流水线）；旧 manifest 无 target 的从 atlas.json 反查回填。两站 14 页快照全量齐备
3. **切页 URL 不更新**：load() 加 history.replaceState，刷新/分享不丢状态

### 方法论沉淀
- 排查 404 的正确姿势：浏览器 Network 面板的失败 URL + grep 产物双端对照，按形态分类逐个击破（内联盲区/双前缀/四点残留/文件缺失四类）
- JS 文件里写正则字面量经 bash→python 三层转义极易烂尾（本 ./ 转义漏写导致正则提前终止）——复杂路径匹配改用字符串 split 扫描（'../assets/' 是固定字面量，零转义）

## W11：交付形态落地（2026-09-30，产品定位升级：交付物=给前端的改造素材包）

- deliver.mjs：交付包打包器——deliverable/<host>-date/{README-改造指南.md, site/(镜像+档案+对比), intel/, fidelity.csv, raw/(dom+cssom 原材料)}
- 定位阐述：给前端的不是"可上线代码"而是三重素材——像素级视觉参考（还原度背书）/可交互原型/情报底稿；改造建议=以镜像为视觉基准重建组件而非在哈希类上堆样式
- queue.mjs：全站批量锻造——持久化队列 queue.json（断点续跑：有产物即 done 跳过）+ 双 worker 对接引擎 2 槽 + SSE 等 exit；thordata 全站 30 页队列后台跑中（5 done 起步）
- 通用性/oneshot 话术定稿：CSSOM 最终态抓取栈无关（React/Vue/jQuery 渲染时规则全捕获）；oneshot 三支柱=L1 确定性搬运天然 97+/多帧评分排除噪声/AI 校准守门不倒退；天花板=JS 交互需 L3 真重写（当前 CSS 级修补）、反爬站白名单拒收

## W13+：活镜像 POC（2026-09-30，用户定位升级"可落地可上线的功能级复刻"）

### 架构：/lm/<host>/* 融合路由（engine）
- 本地 live/<path>/index.html 存在 → 校准快照（视觉/结构已对齐）；否则全代理回原站（未锻造页/JS/API 全透传）
- 全方法透传 + cookie 透传（剥 Domain/Secure 落我们域）+ 剥 X-Frame/CSP + location 重写
- 已锻页=校准视觉+活数据；未锻页=原站原样透传 —— 全站皆活

### build_live.mjs：dom.html → live/<path>/index.html
- <base href="/lm/<host><dir>/"> + bootstrap（fetch/XHR patch 绝对域+根相对）+ 全文根相对/动态 import/绝对域重写
- CSS 用本地校准版（死镜像同款）双保险；图片等资源走代理（版本永远匹配）
- thordata 31 页全量转换（纯本地字符串操作，秒级）

### 验收（Playwright，thordata pricing）
- 页面渲染 ✓ / 标题正确 / 价格数据可见 ✓ / **导航点击弹出 105 菜单元素 = Vue hydration 成功，交互活了** ✓
- 残留（如实入档）：4 个懒加载 chunk 404（hydration 链死引用，不影响视觉/数据/主交互）+ CookieConsent/crisp 挂件 2 个第三方错误（镜像环境固有限制）

### 已知架构坑（四次连环）
1. engine 本地候选含目录 → readFileSync EISDIR → async handler rejection = 连接挂死（非 502）→ 候选只放文件
2. <base> 管不了 / 开头根相对（直接打当前源根）→ 全文根相对重写 + bootstrap 根相对规则
3. 动态 import() 是语言级，不走 fetch patch → import(" 形态内联重写
4. 正则字面量三层转义炼蛊 → 路径匹配改字符串 split 扫描

## W14：活镜像打磨（2026-10-01，cookiebot 深层/ttq/分 host stub 策略）

- magic stub 递归 Proxy 在 apify 挂死（chunk 对 stub 做 spread/序列化 → ownKeys 无限枚举）→ 补 ownKeys/getOwnPropertyDescriptor 仍挂 → **分 host 策略**：thordata 用 MAGIC（实测 CLEAN），apify 用保守 stub + 第三方挂件（cookiebot/tiktok）不剥经代理真跑（活镜像原则）
- thordata 30 页 cssom 的 url("styles/ 归一（引用少一层 ../）
- 功能性验收：两站 6/6 页全渲染可交互（含 3 次按钮点击遍历）；残留 pageerror 为 cookiebot 深层外围噪声（CookieV2/_env/updatePageElementsList——不影响渲染/数据/主交互），chunk 404 为快照时效（apify 部署频繁，定期重锻刷新）

## W15：活镜像残留清零攻坚（2026-10-01）

### 已达成
- **thordata pricing 活镜像：pageerror=0 ✓ 4xx=0 ✓ 完全 CLEAN**
- apify pricing 活镜像：pageerror=0 ✓ 4xx=0 ✓（pricing 抽样）
- 两站 6/6 页（各 3 页抽样）渲染+3 次按钮点击交互全部通过

### 修复链（每个 404/错误对应一类根因）
1. chunk 预检剔除：live html 写盘前对全部 script src 走 /px/ 纯反代 GET 预检，原站 404 的 script 标签剥除（快照时效根除）
2. 根相对收尾正则（icons/ 等任意目录）+ url(&quot; 编码形态
3. 第三方追踪 SDK 剥除扩展：mixpanel/cookiepro/onetrust/tiktok/redditstatic/clarity.ms/gtm/dc/fbq/analytics.
4. 挂件全局 stub 扩展：Cookiebot（consent/dialog/_env）、ttq（_ttq_create/_env/methods.push 兼容函数）、qp、$crisp
5. **顺序修正**：剥挂件必须在 bootstrap 注入之前（2d 正则会把含 mixpanel 关键词的 bootstrap 当挂件删掉——曾致 stub 全部消失）

### 残留（如实入档）
- apify store/use-cases 点击触发的深层组件仍有被剥脚本的下游引用（5-6 errs）——逐站第三方依赖图分析，边际收益递减
- chunk 404 快照时效：apify 部署频繁，定期重锻刷新（queue 断点续跑即为此设计）
- 分 host stub 策略已定型：thordata=MAGIC 递归 / apify=CONSERVATIVE+挂件真跑

### 过夜锻造
- apify 全站 queue --max 60 已启动（61 页 atlas，9 页已锻，约 3-4 小时）

## W16：apify 全站收官 + 重启恢复（2026-10-08）

- **apify 全站：60 页锻造完成，平均还原度 96.8%（55A/4B/1C）**，2 个失败页（jobs/integrations-n8n，均为截图超时偶发）重锻成功至 98.3% A
- 双站全站实证：apify（Next.js）60 页 96.8% + thordata（Vue）31 页 96.1%（22A/9B/0C）——**"常见项目站点群稳定复刻"达成**
- 活镜像全站转换：apify 60 页 + thordata 31 页 live/ 全量；抽样 6 页（各站 3 页）全部渲染+可交互
- 交付包重打：deliverable/apify.com-2026-10-08（60 页）
- 重启恢复 SOP 验证：engine/vite 拉起 + queue resume 对账 + 单页重试——全部按设计工作

## W17：控制台交互升级（2026-10-08，用户 UX 反馈驱动）

- **Ctrl+拖拽平移**：捕获阶段拦截（先于内部旋转控制器），沿相机右/上向量位移（距离比例系数），pointerup 恢复旋转——画布自由平移
- **交互确定性**：点星球 = 立即单页锻造（dock 出现即六阶段启动）；槽满/失败错误从底部 toast 改为 **dock 内嵌红色错误面板**（不再被忽略）
- **左侧仪表面板**（可折叠）：5 色页面类型图例 / 星图自转开关 / 引擎状态灯（在线/离线 + 锻造槽占用 + 侦察状态，15s 轮询）
- **底部快捷键条**：拖拽=旋转 · 滚轮=缩放 · Ctrl+拖拽=平移 · 点击星球=锻造（琥珀高亮）
- 「锻造内环」更名「批量锻造 10 页」并加行为说明——点星单页 / 按钮批量的语义分界明确
- 引擎状态灯数据源：/api/status（slots/recon）
