# W0 验收报告 · 地基假设验证

日期：2026-09-29 · 状态：**✅ 通过**

## 结论

**地基假设成立**：apify.com（Next.js 站）首页的渲染后 DOM + CSSOM 最终样式，脱离原站上下文本地渲染，**首屏像素相似度 96.50%（A 级）**，肉眼接近无差。L1 搬运路线对 Next.js 站完全可行，整条流水线（capture → build → serve → diff）闭环打通，全程确定性代码、零 LLM token。

产物：`core/workspace/apify.com/pages/home/`（shot-src / shot-clone / diff / score.json / clone/index.html 可独立打开）

## 踩坑记录（直接决定引擎设计）

1. **DOM 序列化的 style 标签不可靠**：styled-components 的 `<style data-styled="active">` 在 hydration 后会被清空重建，`page.content()` 抓到的是空壳（第一跑 89.2% 主因）。**正解 = 抓 CSSOM 最终状态**：遍历 `document.styleSheets`（含 adoptedStyleSheets）序列化 `rule.cssText`，275KB 全量命中。这是 L1 引擎的核心决策：**抓"渲染时真正生效的规则"，不抓"样式表的来源"**。
2. **CSSOM 序列化的 url() 会丢 `/_next/static` 前缀**（`/media/xxx.woff2`），且跨 sheet base 不一致 → 下载重试链：本地已捕获副本 → 原样 URL → `/_next/static/media/` 前缀修正。
3. **Next.js Image 的 URL pathname 全是 `/_next/image`**，按文件名命名资产会互相覆盖 → 序号命名 + Content-Type 定扩展名。
4. **HTML 内引用是根相对路径 + `&amp;` 实体编码**，绝对 URL 字符串替换匹配不上 → 通用属性替换器（src/srcset/href 解码后按绝对 URL 查表）。
5. Cookie banner（OneTrust）：点 accept 之后 DOM 残留节点仍会显示（克隆页无 JS）→ 捕获时直接 remove。
6. 剩余 3.5% 差异来源：hero 搜索框打字机动画帧不同（"Extract p" vs "Crawl websit"）+ actor 轮播卡片文案微差 —— 均为 L3 动效/动态内容范畴，W1 用"双截图同帧策略"（冻结 CSS 注入时机对齐）压低。

## 流水线（已成型，即 Core 工具链雏形）

```
capture.mjs   Playwright: networkidle → cookie accept → 懒加载扫掠 →
              DOM/CSSOM/资产清单/原站截图 落盘          （~90s）
build_clone.mjs  CSSOM 引用补抓+重写 → HTML 本地化 → clone/  （~10s）
serve.mjs     静态服务 :8940
shot_clone.mjs  同视口同冻结策略截图
diff.mjs      pixelmatch → diff.png + score.json
```

## W1 入口

- 三代表页改造为参数化流水线（home/pricing/actor 列表）
- "同帧策略"压 pixel 噪声（搜索框打字机、轮播初始帧）
- DOM 结构相似度维度接入（differ 0.3 权重项）
- 栈适配器抽象：把 apify 特化逻辑收敛为 `adapters/nextjs.ts`
