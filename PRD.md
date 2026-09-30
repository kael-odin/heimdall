# PRD · Heimdall 千面镜像引擎

版本 v2.0 · 2026-09-30 · 状态：**已实现（W0-W6 全部落地）** · v1 初版见 git 历史（bf0fa1a 之前）

---

## 0. 一句话

**输入一个 URL，输出三件套：一张全站星图、一座活体克隆、一份情报包。**

> 竞品分析，从一周到十分钟。—— Heimdall：一个网址，一个宇宙。

**实现状态**：✅ 全链路可跑。星图（实时生长+缩略图行星+入场运镜）、锻造（五阶段+AI 校准循环）、情报包（规则+LLM 语义 + 跨页 xlsx）。

---

## 1. 第一性原理（已验证）

四公理推导见 v1（git 历史）。关键验证结果：

- **公理一成立**：竞品分析 = 全公司重复劳动 → 项目话术定为"站点复刻引擎/竞品情报工作流"
- **公理二（网站 = 结构+表现+数据三层）→ 落地为三维还原度公式**，每维都有独立产出
- **公理三（AI 把不可拥有变可拥有）→ 落地为分层搬运**：L1 确定性脚本（零 token）+ L3 AI 校准（deepseek-flash 视觉循环）
- **公理四（信任需要证据）→ 落地为 score.json**：每页三维分数 + breakdown（动态/静态差异拆分），界面上可见

## 2. 产品形态（最终版）

**桌面 agent，双入口：**

1. **星图控制台**（`http://127.0.0.1:5173`）：贴 URL → 侦察星图逐星点亮 → 点任意星 → 施工舱实时锻造 → 分数定格 + 活体克隆内嵌 → "锻造内环"批量并行 → 右下角"克隆档案"总入口
2. **克隆档案页**（`http://127.0.0.1:8900/static/<host>/index.html`）：静态卡片墙，每页还原度/评级/语义标签，**点击直接打开镜像站**；情报 xlsx 下载链接在页头

**产出物目录**（自包含、可转发）：
```
workspace/<host>/
  index.html            ← 克隆档案（双击 or 静态服务打开）
  intel/<host>-intel.xlsx  ← 跨页情报 Excel
  recon/atlas.json      ← 全站结构星图数据
  pages/<page>/
    clone/index.html    ← 活体镜像页（可独立打开）
    score.json          ← 三维还原度
    intel/intel.json + semantic.json
    diff.png / shot-src.png / shot-clone.png
```

## 3. 还原度体系（v2 实现，比 v1 设计更强）

```
total = 0.5×pixel + 0.3×dom + 0.2×data
pixel：多帧最优匹配（3 帧采样吸收打字机/轮播噪声）
dom：parse5 结构相似度（节点比/标签分布/class Jaccard）
data：六维字段覆盖率（meta/headings/prices/cta/tables/links）
breakdown：dynamicPx/staticPx/refinable（差异可修性分类，AI 校准门控依据）
```

实测基准（2026-09-30）：apify 8 页平均 **97.3%**（A），thordata 6 页平均 **97.2%**（5A+1B）。

## 4. 技术栈差异（vs v1 设计）

| v1 设计 | 实际实现 | 原因 |
|---|---|---|
| Three.js 3D 星图 | **Canvas 2D 星系盘面**（核球光/银河带/入场运镜） | 2D 达标线优先，3D 待视觉第三轮决策 |
| MCP server 工具层 | **engine-server HTTP API**（:8900，SSE 事件流） | Web 控制台直连更直接；MCP 封装仍可后补 |
| ZCode skill 编排 | **engine-server 内置编排**（pipeline 子进程） | 流水线固化为确定性代码，agent 编排退居壳层 |
| LLM 未定 | **glm-5.3-flash 主 + deepseek-flash fast**（中转站） | 用户供 key；fixup 用 fast（10s 级） |

## 5. 非目标（不变）

登录后区域禁区 / 不复刻后端逻辑 / 不公开部署产物 / 白名单模式（严格反爬拒收）。

## 6. 成功标准达成

| # | 标准 | 状态 |
|---|---|---|
| 1 | apify 三代表页还原 | ✅ 97.2-99.5% 全 A |
| 2 | apify 全站侦察 | ✅ 61 页/1490 边 |
| 3 | 90s 剧本素材 | ✅ L1 星图生长/L2 施工舱/L3 判定全有实拍 |
| 4 | 贴 URL 十分钟出三件套 | ✅ 单页 ~3-5 分钟（含 AI 校准），全站 8 页批量 ~40 分钟 |
| 5 | thordata 第二适配器 | ✅ 6 页 5A+1B（Vue 栈适配隐式完成——CSSOM 路线天然跨栈） |

## 7. 剩余待办

- 批量 forge 全站化（当前内环 6 页；扩展到 atlas 全节点 + 队列持久化）
- AI 补丁命中率观测（style-probe 加持后 KEEP 率统计，目标 KEEP>40%）
- 视觉第三轮（可选）：星图节点 hover 相机推近、剧场模式一键播放
- 演示彩排：90s 剧本 ×3 次计时 + 录屏备份（RISKS.md checklist）
