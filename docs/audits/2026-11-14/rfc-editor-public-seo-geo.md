# RFC Editor 公开 SEO/GEO 实测

日期：2026-11-14  
目标：`https://www.rfc-editor.org/`  
范围：公开、只读、最多 6 页；未使用登录态、Cookie 或写请求。

## 运行

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\public-seo-rfc-editor-20261114'
node core/src/seo/audit.mjs https://www.rfc-editor.org/ --max 6
node core/src/cli.mjs site-assessment rfc-editor.org --json
```

原始报告和运行输出保存在仓库外的 `D:\Github-Star\heimdall-evidence-archive\2026-11-14\public-seo-rfc-editor-20261114\`。

## 结果

| 维度 | 结果 | 证据边界 |
| --- | --- | --- |
| SEO | 84，B | 6 页，49 个问题：critical 0、high 4、medium 4、low 12、info 29 |
| GEO | 68.4，C | 6/6 页完成页面级启发式测量，覆盖率 1，高置信度 |
| sitemap | partial | 3 个 sitemap 文件成功读取；URL 上限 10,000 触顶，未代表全站 |
| 现场数据 | unavailable | 未配置 PSI key，匿名配额返回 429；没有把实验室数据当成真实用户数据 |
| 实际模型引用 | 未测 | 没有执行真实模型问答、引用命中率或跨模型对照 |

SEO 分类分数为：index 98.7、content 91、structured 100、performance 97、links 99.3、security 98。

## 主要优化任务

1. RFC 搜索页的核心正文主要在渲染后出现。它进入 GEO 可回答性 P0，复测条件是初始 HTML 能提供核心答案。
2. 6 页都缺少可验证的实体类型和结构化实体线索。它们进入 GEO 实体与抽取能力 P1。
3. 6 页缺少清晰的来源归属线索。它进入 GEO 实体归属与引用准备度 P1。
4. 3 页缺少 `meta description`。建议按页面用途补充独立摘要，并重新运行 GEO 检查。

## 交付判断

`site-assessment` 返回 `overall=needs_capture`：克隆为 `0/0`，API 契约缺失，QA 未配置，后端仍为 B0 或更低。SEO/GEO 报告只支持优化建议，不支持离线交付、后端等价或业务 QA 结论。

本案例验证了三点：页面级 GEO 可以在 sitemap 部分未知时保持自身测量完整；站点级范围限制会独立保留；AI 交付计划会把 SEO/GEO、克隆、API 和 QA 缺口分开呈现。
