# W3 验收报告 · 施工舱与星图合流

日期：2026-09-30 · 状态：**✅ 通过**

## 结果

点选星图任意节点 → 引擎真实跑该页还原流水线 → 施工舱四阶段实时可视 → 分数定格 + 活体克隆内嵌。

实测：`apify.com/clockworks/tiktok-scraper` 页面 forge 全链路 **95.9%（A 级，像素 93.5% / 结构 100%）**，四阶段（捕获骨架→注入皮肤→渲染校准→像素定谳）事件驱动状态机走通，原站/镜像双缩略对比 + clone iframe 就位。节点状态机：idle → forging（琥珀脉冲）→ done（金环恒星点亮）。

90 秒分镜的 L1 幕（星图生长）与 L2 幕（施工舱造物）骨架至此全部成立。

## 本轮改动

1. **pipeline.mjs 事件化**：四阶段 @@EVENT@@ 行 + forge-score；workspace 目录统一 stripWww（thordata recon 与 forge 落同一目录）。
2. **engine-server 重写**：tasks Map 统一管理 recon/forge 两类任务，`POST /api/forge` 并入，事件协议全量 `kind` 化，单任务队列各自独立（侦察与锻造互不阻塞）。
3. **Atlas.vue 施工舱**：右侧 30% 抽屉，四阶段 chip（running 琥珀脉冲/done 绿）、分数大字+三维拆解+评级、双联缩略、iframe 活体克隆；节点 forgeState 由真实事件驱动画布渲染。
4. **capture.mjs goto 降级**：`networkidle` → `domcontentloaded`——actor 详情页有持续轮询/长连接，networkidle 永不达成直接 60s 超时；资源加载由既有懒加载扫掠 + best-effort networkidle 兜底。

## 踩坑（本轮三连）

1. **vite proxy 前缀劫持**：proxy key `/api` 前缀匹配把 `/apify.com/...` 全部代理到 engine 返回 404 JSON——apify 的 atlas/缩略图/克隆 iframe 静默全灭（thordata.com 不以 /api 开头所以逃过）。key 改 `'/api/'` 带尾斜杠。症状是"文件明明存在却 404"，curl 响应体 `{"error":"nf"}` 是 engine 的 JSON 才识破。
2. **Vue 组件内 state 与函数重名**：`const forge = ref()` 与 `async function forge()` 编译报 Identifier already declared。
3. **诊断方法沉淀**：canvas 像素采样（getImageData 计非黑像素）判断渲染层死活；hover 卡是否出现做节点命中探测；curl 响应体看是谁的 404。

## 下一步（W4 → 中期评审）

- harvest 情报包（LLM 结构化抽取：定价表/功能矩阵 → Excel+JSON，data 维度评分接入）
- diff 修复循环接入 L3（AI 看差异改代码重跑，校准轮次动画）
- 全站批量 forge + 星图"恒星点亮"进度全景
- 视觉打磨专项（用户已定：impeccable / ui-ux-pro-max skills，重构 2D→3D 决策也放到这一步）
