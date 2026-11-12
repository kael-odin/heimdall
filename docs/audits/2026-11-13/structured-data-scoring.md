# 结构化数据评分纠偏：真实页面与同批证据对照

2026-11-13，修复通用字段表误充 Google 富结果必填表、相对图片地址误判，以及特殊类型名导致审计崩溃的问题。

## 官方机制与实现边界

- [Google Article 指南](https://developers.google.com/search/docs/appearance/structured-data/article)明确区分推荐属性与必填属性；当前 Article 没有必填属性。旧实现将 image、datePublished、author 一律作为必填，并声称缺少时通常无效，依据不足。
- [JSON-LD 1.1 的 Base IRI 说明](https://www.w3.org/TR/json-ld11/#base-iri)允许相对 IRI 按文档基址解析，也允许上下文设置基址。旧实现仅匹配 `http(s)://`，不能据此断定图片失效。
- 特定搜索功能仍可能有自己的资格要求。浅层通用表无法替代对应指南、Rich Results Test、内容真实性审核或实际展示验证。

新实现把字段表改为 `COMMON_FIELDS`，输出 `structured-common-fields` / `info`，明确为待核查且不扣分；建议仅补充与可见内容一致的真实信息。删除相对图片规则，保留 JSON 解析、上下文、字面 `@type` 和日期格式检查。未新增完整 JSON-LD 处理器，也未验证图片能否抓取。

类型表查询增加自有属性检查。`constructor`、`__proto__`、`toString` 不再被当作内置类型规则而抛出异常。

## 真实案例

两个新页面由现有 `collectPage` 真实浏览器入口采集，HTTP 均为 200；比较时固定同一份页面信号，仅替换结构化数据校验器，避免把网络或性能波动算成算法变化。

| 页面或冻结样本 | 评分口径 5 | 评分口径 6 | 解释 |
| --- | ---: | ---: | --- |
| web.dev `/articles/lcp`，页面分 | 92 | 98 | Article 有 headline、dateModified；旧实现因 image、datePublished、author 缺失扣 6 分 |
| developer.chrome.com `/blog/new-in-chrome-130`，页面分 | 98 | 98 | BreadcrumbList 对照，不受字段表调整影响 |
| IANA，两页站点分 | 69 | 69 | 复用 11 月 12 日冻结信号 |
| example.com，一页站点分 | 46 | 46 | 同批回放 |
| Vitest，两页站点分 | 84 | 84 | 同批回放 |

后三站旧口径回放与原报告分数逐一相同，原始文件 SHA-256 未变。其 GEO 方法 4 和已有结果未改变；本次没有宣称提升真实搜索排名、富结果展示或 AI 引用率。

相对图片地址仅用明确的回归样本验证，未在上述真实页面中发现并复现该项误报。Python 和 Node.js 发布页的初始 HTML 也作过候选检查，未检出 JSON-LD，不计入七页评分验收。

## 口径、回归与简化

- SEO 评分口径升至 **6**；采集信号未改，测量口径保持 **5**；GEO 保持 **4**。
- 旧评分口径 5 基线继续保留。新门禁拒绝混比或覆盖，基线文件名改用 `--score-v6--measure-v5.json`；历史走势和跨站矩阵保持版本隔离。
- 用 IANA 原基线实跑三种门禁或更新命令，均在抓取前拒绝旧口径，SHA-256 未变。真实 IANA 信号构成的 v5/v6 混合矩阵隐藏分数和每页问题数；测量仍为 5，因此类型覆盖率仍可比较。
- 删除一条错误规则，当前 **65 条规则**。CLI、MCP、控制台、手册和数字守卫同步；历史审计与存档不改写。
- 本地 SEO、GEO、基线、历史、矩阵和代理入口相关测试 **220/220** 通过，其中包含真实浏览器采集、旧基线拒绝、普通审计跳过不兼容对比、原件保护和报告口径说明。
- 代码提交 `1605901b67d77c8ff8b5c39f74f47721f1702f55` 的[完整 CI 43263634562](https://github.com/kael-odin/heimdall/actions/runs/43263634562) **8/8 成功**，包含两个完整 Core 测试分片、完整浏览器冒烟、Docker、MCP、控制台、QA Action 和依赖审计；同提交 Docs 运行 `43263634641` 成功。
- 使用现有测试文件，无新依赖、运行模块或测试文件。14 个冻结验证器文件未修改。
- 两份真实页面的重放 HTML/CSV 报告均显示新提示。375/768/1440 三视口共 6 次浏览器检查无整页横向溢出、脚本错误或运行时外联；未执行站点 sitemap 核验，报告明确保留不能建立基线的状态。

外部证据目录：`D:/Github-Star/heimdall-evidence-archive/2026-11-13/structured-data/`。关键文件为 `comparison.json`、`*-collected.json`、`structured-v5.mjs`、`compare.mjs`、`tests.log`、`migration.json`、`matrix-method-isolation.json`、`report-smoke.json`、`official-sources.json` 及保存的官方文档 HTML。原始页面与运行日志不进入 Git。

仍未核实完整上下文展开、别名、跨脚本实体引用、特定功能的全部资格要求或 Google 实际展示。另用 W3C 规范页初始 HTML 中的 JSON-LD 复现了一个待修问题：文档使用 `type` 别名，当前字面检查仍输出 `structured-type-missing` / `low`。证据在 `remaining-alias-evidence.json`，不计入上述七页验收，也不能据此否定该页的 JSON-LD。分数变化是工具纠偏，不能作为网站优化效果。
