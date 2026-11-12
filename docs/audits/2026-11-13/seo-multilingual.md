# 多语言正文测量与短页误报实测

2026-11-13，五页 HTTP 200 HTML 冻结后，走实际 Chromium `collectPage`，在原地址注入同一 HTML 并阻断子资源。每页新旧可见正文逐字一致。没有登录、交互或远端写入；这是受控机制对照，不是完整线上审计或合格基线。

## 已修复

- 旧正则只计基本汉字与 ASCII 单词，会漏掉韩文、假名、扩展汉字和其他文字。现复用一个 `countWords`：Node 原生 `Intl.Segmenter`，固定 `en` 分段区域，初始 HTML 与浏览器可见文本都在同一 Node/ICU 中分词。
- 保留 `wordCount` 字段，单位改为分词数；中文不再逐汉字计数，带重音字母、撇号及小数也可能改变计数。这不是模型 token 或内容质量测量。
- `content-thin` 保留规则 ID，低于 300 只给 `info`，不再按固定最低字数扣 SEO 分，也不建议填充文字。
- GEO 的初始 HTML 长度覆盖检查移除 40 词下限。短正文在服务端确实可见时不再误报；初始正文为零或低于可见正文 30% 仍失败，渲染后计数缺失则未知。比例不证明内容等价。
- GEO 120 分词单位仍为准备度启发式，文案明确不能判断答案质量或模型引用效果。
- SEO 评分 **11**、测量 **7**、GEO **6**；旧基线、历史记录保留，建立新路径前须重新采集和审核。跨测量口径矩阵同时隐藏平均字词数。

## 同一批冻结页面

| 页面 | 旧计数→分词数 | 单页 SEO 10→11 | GEO 5→6 |
|---|---:|---:|---:|
| [Mozilla 宣言·韩文](https://www.mozilla.org/ko/about/manifesto/) | 206→1,048 | 76→82 | 67.7→67.7 |
| [Mozilla 宣言·日文](https://www.mozilla.org/ja/about/manifesto/) | 1,107→1,701 | 84→84 | 71.9→71.9 |
| [Mozilla 宣言·中文](https://www.mozilla.org/zh-CN/about/manifesto/) | 2,073→1,335 | 82→82 | 67.7→67.7 |
| [Mozilla 宣言·英文](https://www.mozilla.org/en-US/about/manifesto/) | 1,289→1,275 | 84→84 | 71.9→71.9 |
| [Example Domain](https://example.org/) | 25→25 | 58→64 | 14.1→22.8 |

正式对照严格沿用生产 CLI 的 `pageCtx.host`（移除 www），只算已采集的单页规则，不是完整站点总分。最初脚本没有移除 www，Mozilla 被额外扣 12 分；错误结果保留，正式分数以 `production-results.json` 为准。

韩文与 Example Domain 的 SEO 变化来自取消固定字数扣分。Example Domain 初始 HTML 27、可见正文 25，旧 GEO 却因低于 40 判正文不可见；新逻辑保留“短正文参考”，只纠正服务端长度覆盖结论。其余四页 GEO 分数不变。

最早的独立 `setContent` 文本提取使用不同浏览上下文，韩文分词为 961。正式结果改用与 `collectPage` 同一上下文、关闭前取得的可见文本：1,048；与旧计数 206 的正文对应。最初文件保留，不混用为独立样本。

## 验证与边界

- 新逻辑前，现有四个测试文件中的新增回归断言失败；修复后相关组 63/63 通过，覆盖多文字、重音、符号、真实采集、短页观察与服务端覆盖。
- 五页实际源码在 Windows Node **26.12.1 / ICU 78.3** 与断网只读仓库挂载的 Node **22.13.1 / ICU 76.1** 容器中复算，分词数、SEO 与 GEO 分数一致。这是同一批五页，不计成十个独立案例。
- 扩大相关测试 235/235 通过；该组包含前述 63 条，不相加。五份报告展开全部证据，在 375/768/1440 宽度共 15 次检查中无整页溢出、脚本错误或运行时外部请求。修复实测发现的表格与 canonical 长文本溢出，表格局部滚动区域有可访问名称和键盘焦点。
- 不增加依赖、源码模块或测试文件；证据均在仓库外。冻结验收文件保持不变。
- 未验证排名、收录、真实 AI 问答或引用命中率。未把页面各语言分数差异归因为语言质量。短页 GEO 仍受其他准备度启发式影响。
- 分词边界可能随 ICU 版本变化；版本边界附近应固定运行时重放。原始 HTML 文本与可见文本的覆盖范围也不完全相同，长度比例不代替正文语义对比。

证据目录：`D:\Github-Star\heimdall-evidence-archive\2026-11-13\seo-multilingual\`。`sources.json` 记录时间、原始 HTML SHA-256、采集前提交；`before-results.json` / `after-results.json` 保留最初上下文误差，`production-results.json` 与 `*-production-signals.json` 是正式对照；逐字正文用于复核，`docker-node22-production.json` 记录最终隔离复算，失败与通过日志均保留。来源驱动及孤立旧规则副本只在外部证据目录，不进项目。

## 一手机制依据

同轮仓库清理：归档证据清单是只读索引，唯一引用是审计首页。将 1,614,675 字节原文无损压缩为 331,411 字节 `.gz`，解压逐字节与已提交原文及外部备份一致，8,350 条记录全部保留。审计首页更新链接、原文 SHA-256 和无需新依赖的 Node 解压命令；不改测试夹具或冻结验收文件。

- [Google SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)：内容长度没有决定排名的固定最低或最高字数；应围绕用户需要写作。
- [ECMA-402 Segmenter](https://tc39.es/ecma402/#segmenter-objects)：原生单词分段和 `isWordLike`。
- [Unicode Text Segmentation](https://www.unicode.org/reports/tr29/)：词边界与语言定制，不是答案质量标准。三份原文均 HTTP 200，HTML 与 SHA-256 留在外部证据。
