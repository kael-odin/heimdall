# W2 验收报告 · 侦察引擎 + 星图控制台

日期：2026-09-29 · 状态：**✅ 骨架通过**

## 结果

- **recon.mjs**：apify.com 全站侦察 → **62 pages / 1490 edges / 62 张节点缩略图**，`atlas.json` 落盘。sitemap + 双队列 BFS（BFS 发现优先保证 pricing/store 等结构页入图，sitemap 仅补位），页面类型规则分类（pricing/listing/marketing/doc/auth/legal）。
- **console/**（Vue3 + Vite + Canvas 2D）：`Atlas.vue` 星系盘面布局（中心恒星+星环 / 内环 depth1 / 外环 depth2+）、类型色辉光节点、曲线发光边（每源采样 ≤8 条防糊）、hover 缩略图信息卡、HUD 计数器、星尘背景、整体缓慢旋转。vite publicDir 直连 `core/workspace/`，引擎产物零拷贝进控制台。
- 图标丢失诊断收口：styled-components 的哈希选择器（`.ipXzjm`）+ `mask:` 简写 + CDN 资源，W1 新版 build 已全量本地化，三页 footer 图标实测完好；用户所见为 W0 旧产物。

## 踩坑（三条都是侦察引擎的经典坑）

1. **BFS 死锁**：额度用尽后 while 停止消费队列，但退出条件还要求队列走完（sitemap 预热几百 URL），interval 死转 → 退出条件解耦。
2. **sitemap 预占 seen**：几千个 sitemap URL 预标记去重集，首页发现的 depth1 结构页（/pricing /store 全在 sitemap 里）被全数挡掉，42 页里 58 个是字母序杂页 → BFS 独立去重集，sitemap 降级为纯补位。
3. **前端布局失控**：depth=99 的补充页环半径 99×130 飞出画面 + 1490 条边糊成毛线球 → 环数 clamp 到 3 层 + 每源边采样。

## 下一步（W2.5 → W3）

- W2.5：console 输入框接引擎——极简 node server（任务队列 + SSE/WebSocket 事件流），URL 进 → recon → 星图生长动画（节点逐个点亮，分镜 L1 幕）
- W3：3D 化（Three.js）+ 施工舱四层建造动画 + diff 循环可视化
- hover 全边高亮、节点标签常显（低优先）
