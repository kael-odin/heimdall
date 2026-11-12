# 分页与分面机制实测

日期：2026-11-13。纠正分页标题与 canonical 判断，以及分面导航优化建议，继续用真实页面驱动现有规则改进。

## 机制来源

本轮取得 HTTP 200 并保存初始 HTML、最终地址与 SHA-256 的三份一手指南：

- [Google 分页与增量加载指南](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading?hl=en)：同一分页序列可共用标题与描述；不同页应有独立 URL，canonical 不应一律指向第一页。
- [Google 分面导航抓取指南](https://developers.google.com/crawling/docs/faceted-navigation?hl=en)：先区分是否希望抓取分面 URL；canonical 是声明偏好的信号，可能随时间降低重复抓取，不能仅看标签就证明效果。原 Search Central 地址跳转到 Crawling Infrastructure 的新地址，均保留。
- [Google 规范地址指南](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls?hl=en)：canonical 用于重复或高度相似内容的规范化；优化建议须结合内容和发布意图，不能只根据筛选参数名制定统一策略。

## 修复的判断

1. 分页专属规则与通用标题、描述重复规则此前独立扣分。新增同一数字分页序列判定：去掉唯一页码后，来源、栏目、分页语法与其他参数都相同才给不扣分提示；无页码首页须精确匹配序列基础地址。跨栏目、筛选条件、来源、重复或无效页码仍保留通用重复检查。页码语法只是启发式，不证明内容或所有分页形式。
2. 分页与分面 canonical 比较此前忽略协议、端口、www 和尾斜杠，可能把不同地址当成自指。将已有 hreflang 严格身份函数移到现有 `url-canon.mjs` 复用，只去片段并做 URL 标准规范化；hreflang 的语义保持不变，没有修改克隆 URL 的原有归一策略。
3. 只有一个参数页声明非自指 canonical，原规则就会让整组降为提示；无效字符串也被算作已控制。现在只有全部页面都有可解析的 HTTP(S) 非自指声明才给提示，其他情况保留提醒；措辞统一说明内容等价和抓取效果未验证，不再称“已收敛”。
4. 建议先核对哪些筛选页需要收录、哪些组合不希望抓取，以及内容是否重复或高度相似，再决定 canonical 或 robots.txt；不再仅根据筛选参数就要求归并到主列表。规则 API 中已有 `noindexIntent: true` 也贯通分页检查，不新增 CLI 参数；移除“noindex 会让全部内链一并消失”的过度断言。

## 真实页面同批对照

首批新鲜 GET 取得 Hacker News `?p=2` / `?p=3` 和 WordPress News `/page/2/` / `/page/3/` 的四份 HTTP 200 HTML。HN 两页的第一项排名分别从 31、61 开始，确为不同分页内容；标题都为 Hacker News。WordPress 已在标题区分页码，采集到的 canonical 仍指向 News 根地址，未据此宣称其规范化已正确或已修复。

复核发现无页码首页未被纳入通用重复规则的例外，随后重新抓取两站各自首页、第 2、3 页，得到另一个六页 HTTP 200 冻结批次。该批次独立对照原口径 8、中间口径 9 与最终口径 10，保留首页未覆盖时的失败记录；不会把两批不同时间和页面集合的分数直接相减。

冻结初始 HTML 后，用真实 Chromium 和 Heimdall `collectPage` 采集一次；后续规则对照使用完全相同的信号，不重新联网或改变页面。子资源请求主动阻断，无凭据、点击或远端写入。

| 冻结样本 | 口径 8 | 口径 9 | 最终口径 10 |
| --- | --- | --- | --- |
| Hacker News 第 2、3 页 | 37，两条标题规则均 medium | 43，两条均 info | 保持 43 |
| WordPress 第 2、3 页 | 68，标题已区分页码 | 68 | 保持 68 |
| Hacker News 首页、第 2、3 页 | 39.3，两条均 medium | 41.3，通用规则仍 medium | 43.3，两条均 info |
| WordPress 首页、第 2、3 页 | 68.7 | 68.7 | 保持 68.7 |

同批的所有页级分数和 GEO 输出不变：HN 为 GEO 36.5，WordPress 为 GEO 67.7。样本分按现有审计公式计算：页面平均分减站点规则惩罚除以页面数。它不是完整在线站点评分：未核对 sitemap，子资源被隔离，报告明确 `baselineEligible:false`。分数增加是工具撤销错误扣分，网站本身没有优化，不能解释为排名、索引或模型引用效果提升。

## 验证和体积控制

- 先保留失败回归，修复后相关测试 **122/122**；补充严格数字形式后，聚焦测试 **29/29**。两者有重叠，不累计成独立样本数。
- 原始信号对照确认两站的页级分数与 GEO 输出不变。受控反例覆盖跨栏目/筛选/来源、重复和无效页码、协议/端口/www/尾斜杠差异、部分及无效 canonical、已声明 noindex 意图；这些不是网站新增缺陷。
- 两批各自两份实际 SEO 报告均检查 375 / 768 / 1440 三个宽度，共 12 个视口：零横向溢出、零页面异常、零运行时外联。CSV 中两项标题提示为 info，新口径的 HTML 说明与旧规则说明同时保留。
- 最终评分口径为 **10**；测量 **6**、GEO **5**、64 条规则不变。已推送的口径 9 属于中间版本，首页补强后另升版本，避免其基线与最终结果混用。基线示例和使用手册同步，旧口径基线、历史与矩阵继续隔离；不自动覆盖旧文件。
- 未新增依赖、源模块或测试文件；仅新增本篇短实测记录。初版修复后一个旧断言仍要求“都没有收敛策略”，其失败和修正单独保留。

证据与可复跑驱动在仓库外：`D:/Github-Star/heimdall-evidence-archive/2026-11-13/seo-pagination-mechanism/`。包括原始 HTML、`*-source.json`、`before-source.json`、旧版隔离副本、冻结采集、`before-results.json`、`real-cases.json`、三份官方指南、报告与浏览器核对、回归日志。没有实测 Google 的选择、抓取预算、索引变化或真实模型引用。

精确源提交与 Hosted CI 终态在推送后补充。
