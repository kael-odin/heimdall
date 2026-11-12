# JSON-LD 标准语义：W3C 真实别名误报修复

2026-11-13，修复上一轮记录的 `type` 别名误报，并将正确的类型与字段证据贯通 SEO、GEO、基线和代理结果。

## 根因与实现

旧采集器在解析上下文之前裁剪字段，会丢掉 `type`、`id` 和自定义别名。校验器再把缺少字面 `@type` / `@context` 当作缺陷；GEO 也无法正确识别类型。

新采集器先用 `jsonld@9.0.0` 标准处理器展开上下文，再生成受限的 Schema.org 字段投影。支持已解析上下文中的关键字别名、前缀、完整类型 IRI、上下文重置和作用域，保留其他命名空间的完整 IRI，不把其他词汇的 `Article` 当作 Schema.org 类型。类型统计仍限顶层和 `@graph`；字段投影不等于原始 JSON-LD，也不是富结果资格或业务真实性判定。

只内置固定的 [Schema.org 官方上下文](https://schema.org/docs/jsonldcontext.jsonld)，不自动请求其他远程上下文。每页最多 16 段脚本，每段最多 1,048,576 个 UTF-16 代码单元；超限或上下文无法核实时保留未知。JSON 语法错误及处理器确认的 JSON-LD 语义格式错误仍报缺陷，未知上下文不伪装为格式错误。

删除两个没有语义依据的字面必填检查，增加一条不扣分的语义未核实提示，当前 **64 条规则**。GEO 对未展开的数据和受限字段保留未知，不生成“补造缺失字段”的整改任务；已观察到的正面证据仍可使用。无法核实的类型覆盖率为空，不能解释为 0%。此类页面不能成为 SEO 基线，CLI 与代理均报告部分完成。

## 真实页面对照

复用上一轮保存的三份真实初始 HTML，外部子资源全部阻断。先固定新采集的非 JSON-LD 信号，再分别代入旧、新 JSON-LD 结果及对应规则，隔离性能和网络波动。这是冻结页面重放，不是线上全站评分；不能与上一轮联网浏览器的分数直接比较。

| 页面 | SEO 6 → 7 | GEO 4 → 5 | 证据变化 |
| --- | ---: | ---: | --- |
| W3C JSON-LD 1.1 规范 | 66 → 68 | 71.9 → 91 | 识别 TechArticle，消除字面类型误报，发布时间纳入检查 |
| web.dev LCP 文章 | 84 → 84 | 91 → 91 | Article 与 BreadcrumbList 对照不变 |
| Chrome 130 博客 | 84 → 84 | 71.9 → 71.9 | BreadcrumbList 对照不变 |

W3C 类型从空集合变为 `TechArticle` 和其完整的 W3C REC 类型 IRI。GEO 的结构线索与实体类型检查通过，时间检查由不适用变为通过；缺少作者归属的提示仍保留。三个原始 HTML 的 SHA-256 未变。

本轮另一次直接浏览器访问 W3C 返回 **403**，已保存 `w3c-live.json`，不计为在线验收通过，也不把错误页用于上述对照。

## 核验、版本与体积

- 本地 SEO/GEO、采集、基线、历史、矩阵及代理相关回归 **223/223** 通过；后续针对代理摘要、规则数字和字段缺口的 **40/40** 检查通过。
- 真实浏览器与 CLI 回归确认：未配置上下文的请求计数为 **0**，旧基线不覆盖，JSON-LD 未核实会阻断基线更新，GEO 不生成对应缺陷任务，HTML/CSV/代理保留缺口。
- SEO 评分口径 **7**、测量口径 **6**、GEO 方法 **5**；旧报告和基线保留，必须选新路径重新采集和审核。
- 新增一个解析模块、一份约 153 KB 的官方上下文及其归属说明；增加一个直接依赖以替代自制上下文解析器。复用现有测试文件，无新测试文件；14 个冻结验证器未修改。
- `pnpm install --frozen-lockfile`、生产依赖审计、插件生成检查和技能同步通过。运行日志、原始页面和对照脚本留在仓库外。

外部证据：`D:/Github-Star/heimdall-evidence-archive/2026-11-13/jsonld-semantics/`，包括 `real-cases.json`、`*-before.json`、`*-after.json`、`w3c-live.json`、`tests.log`、`targeted-tests.log` 和可重跑脚本。

## 上下文来源与边界

官方原件 SHA-256：`65d0c5d17def9b171b7697bb0929eed17aa32f19af539e15302b6c20479b8930`；压缩空白后的项目文件 SHA-256：`83bf7671ae77e28322c6ef4006f0109ecd2ec41db76879fe3860ab043b9b966f`。仅调整 JSON 空白，映射未改。归属和许可见 [`schemaorg-context.NOTICE`](../../../core/src/seo/schemaorg-context.NOTICE) 及 [Schema.org 使用条款](https://schema.org/docs/terms.html)；上下文更新需要重新审核口径。

语义依据为 [W3C JSON-LD 1.1 关键字别名](https://www.w3.org/TR/json-ld11/#aliasing-keywords)、官方上下文和 [jsonld.js](https://github.com/digitalbazaar/jsonld.js)。仍未覆盖 RDFa、跨脚本实体合并、其他远程上下文的获取、Google 实际展示或真实模型引用率。分数变化反映工具纠偏，不代表搜索效果改善。
