# 使用指南 · Heimdall 最终形态

> 你（用户）如何启动、如何克隆、如何查看成果。三分钟上手。

---

## 1. 启动（每次开机后一次）

两个终端窗口（或用 `start` 后台化）：

```cmd
:: 终端 1 —— 引擎（必须先起）
cd /d D:\Github-Star\heimdall\core
node src\engine-server.mjs 8900

:: 终端 2 —— 星图控制台
cd /d D:\Github-Star\heimdall\console
pnpm exec vite --port 5173 --host 127.0.0.1
```

起好后浏览器打开 **http://127.0.0.1:5173** —— 这就是星图控制台。

## 2. 克隆一个新站（全流程）

1. 顶部输入框输入域名（如 `stripe.com`）→ 点「侦察」
2. 星图入场动画 → 爬虫光点逐星点亮（全站结构 1-3 分钟）
3. **点任意一颗星** → 右侧施工舱自动锻造该页：
   - 01 捕获骨架 → 02 注入皮肤 → 03 渲染校准 → 04 AI 校准（AI 看图改 CSS，改坏自动回滚）→ 05 像素定谳 → 06 情报入库
4. 完成 → 判定区大分数（如 96.3% A）→ 下方直接内嵌活体镜像页
5. 点「锻造内环」→ 批量并行锻造 6 个主要页面

## 3. 查看克隆成果（你问的"到底行不行"）

**方式 A —— 克隆档案页（推荐，最直观）：**

- apify.com（8 页，平均 97.3%）：http://127.0.0.1:8900/static/apify.com/index.html
- thordata.com（6 页，5A+1B，平均 97.2%）：http://127.0.0.1:8900/static/thordata.com/index.html

每个卡片显示：该页截图缩略、还原度/评级、语义标签（产品数/套餐数/价格数）。
**点卡片 = 直接打开该页的活体镜像站**，可以随便点、随便滚——导航和文案是原站的，行为是静态的（无登录/无后端交互）。

**方式 B —— 直接打开单个镜像文件（无需任何服务）：**

```
D:\Github-Star\heimdall\core\workspace\apify.com\pages\home\clone\index.html
```
双击即可（资源全是相对路径）。每页还有 `shot-src.png`（原站截图）和 `shot-clone.png`（镜像截图）可肉眼对比，`diff.png` 是差异热图。

**方式 C —— 情报包：**

```
D:\Github-Star\heimdall\core\workspace\apify.com\intel\apify.com-intel.xlsx
```
三个 sheet：概览（每页还原度）/ 语义情报（价值主张/产品/套餐/官方宣称）/ 定价与CTA 全量。

## 4. 同屏同步滚动对比（原站 vs 镜像）

克隆档案页每张卡片上点「⇔ 同步对比」，或直接开：
- http://127.0.0.1:8900/static/thordata.com/compare.html?p=pricing
- http://127.0.0.1:8900/static/apify.com/compare.html?p=home

左侧是捕获时的**原站全页快照**，右侧是**活体镜像**（可交互）。任意一侧滚动，另一侧按比例同步——逐屏目检还原质量。
（旧版产物没有原站全页图会提示"重新锻造此页"；新锻造的页自动带。）

## 5. 镜像站内导航（点击跳转）

已克隆页面之间的链接**在镜像内互相跳转**（linker 自动接线 + 幂等自愈：thordata 178 处 / apify 82 处累计改写）；
未克隆的同源页会**新标签打开原站**（诚实降级，永不 404）。
favicon/图标等全站小件自动补齐（跨页借用 + 坏链修复，余 10 项为无害的 .well-known 探测路径）。
已实测：镜像内点击 logo/导航可真实跳转到对应克隆页。

## 6. 还原度怎么读

- **total**：0.5×像素 + 0.3×结构 + 0.2×数据，≥95 为 A
- **像素**：多帧最优匹配后的首屏像素相似度（打字机/轮播噪声已排除）
- **可修性**：剩余差异里"静态可修"的占比——低于 30% 说明分数损失主要是动画噪声，不是克隆质量差
- 动效重的页（如 thordata home 94.4% B）低于静态页（98%+ A）是**正常且诚实**的——损失来自 JS 动效（W4 情报包范畴），不是布局抄错

## 7. 已知边界（诚实清单）

- 克隆页是**静态镜像**：无登录、无搜索交互、无后端请求（这些属于 L3 AI 重写范畴，比赛未承诺）
- 部分页首屏有打字机/轮播动画，镜像页该区域静止（评分已排除此类噪声）
- 白名单模式：严格反爬的站会侦察失败（明说拒收）

## 8. 命令速查

```cmd
:: 单页完整锻造（等价于点星）
cd /d D:\Github-Star\heimdall\core
node src\pipeline.mjs https://apify.com/pricing pricing

:: 全站侦察
node src\crawler\recon.mjs https://example.com 40 2

:: 刷新某站克隆档案页
node src\crawler\index-page.mjs apify.com

:: 刷新情报 xlsx
node src\harvest\xlsx.mjs apify.com
```
