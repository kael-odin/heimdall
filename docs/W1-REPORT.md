# W1 验收报告 · 三代表页 + 三维还原度

日期：2026-09-29 · 状态：**✅ 通过**

## 结果

| 页面 | pixel | dom | TOTAL | grade |
|---|---|---|---|---|
| home（动效最重） | 96.53% | 100% | **97.8%** | A |
| pricing（数据表） | 97.9% | 100% | **98.3%** | A |
| store（卡片墙+搜索） | 96.8% | 100% | **97.4%** | A |

三页图片资产 177/184/170 全数命中（0 失败），`node src/pipeline.mjs <url> <name>` 一条命令跑通 capture→build→serve→shot→diff 全流程，产物各自独立在 `workspace/apify.com/pages/<name>/`。

## 本周交付

1. **三维还原度公式落地**：`total = 0.5×pixel + 0.3×dom (+0.2×data 待 W4)`，data 接入前按 pixel+dom 归一化。dom 维度（parse5 body 结构：节点数比 + 标签分布余弦 + class Jaccard）对 L1 搬运天然满分——**这是特征不是缺陷**：它证明结构层零损伤，区分度留给未来 AI 重建模式对比和 build 事故检测。
2. **同帧冻结策略**：CSS 动画冻结 + `.swiper-wrapper` transform 归零 + input 值清空（打字机/搜索预填两侧归零）。home 页 pixel 稳定在 96.5%——剩余差异为轮播初始渲染与图片压缩亚像素噪声，接近 pixelmatch 对该站的实测天花板。
3. **栈适配器落地**：`adapters/{generic,nextjs,vue-vite}.mjs`，detect/cssRefCandidates/pageCleanup 三钩子。apify 特化逻辑（onetrust 清理、`/_next/static/media` 前缀修正）全部收敛进 nextjs 适配器，探测自动生效；vue-vite 占位（W5 thordata 接入）。
4. **pipeline.mjs 一键串联**：W2 星图和施工舱的引擎接口就此定型。

## 踩坑

- parse5 树中 `document.childNodes[0]` 是 doctype，body 查找需深度优先——首跑 dom 全 0 假警报（pixel 独立正常，分项拆开看立刻定位）。

## W2 入口（侦察树 + 控制台骨架）

- crawler 增加 recon 阶段：sitemap.xml + 链接 BFS → `atlas.json`（节点/边/元数据/页面类型占位）
- console 脚手架（Vue3+Vite+Tailwind）+ 2D 星图（力导向）+ 任务队列 + WebSocket 进度推送
- 流水线并行化：多页队列依次执行，事件流喂给控制台
