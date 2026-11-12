# GEO 证据完整性、Google 摘要指令与公开站点复测

日期：2026-11-12。修正共享 GEO 评分和站点评估，不新增检测器、依赖或独立测试文件。

## 前轮修正：GEO v3

- 采集失败或 HTTP 错误页返回 `score: null`、`status: unavailable`；占位字段不再生成内容整改，完整检查列表也不保留内容建议。
- 只有 `raw.source: navigation` 的成功初始响应能核实服务端正文；缺失来源、后续重新请求均为 `unknown`。
- 页面与站点使用同一适用权重分母：`na` 不扣覆盖率，`unknown` 保留缺口；覆盖率保留三位小数，避免 95.8% 被展示成完整。
- 页、维度、站点均保留完整性。混合站点只给成功页面评分，同时显示不可用页数与被排除的权重。
- JSON、HTML 和 AI 站点评估贯通完整性；缺失、旧版或不完整 GEO 不能因为待办为空就显示就绪。
- 方法升级为 `GEO_METHOD_VERSION = 3`；SEO 评分、采集版本及正式视觉门禁不变。旧报告保留，重新审计后才能取得当前 GEO 结论。

## 真实样本

本次使用隔离的数据目录，实际访问三个公开站点，共五页。下面是样本结果，不是整站覆盖或真实搜索表现评价。

| 目标 | 页面 | SEO | GEO v3 | 已观察权重 / 适用权重 | GEO 完整性 |
| --- | ---: | ---: | ---: | ---: | --- |
| IANA 首页与 about | 2 | 69 | 54.2 | 188 / 192 | partial |
| example.com 首页 | 1 | 46 | 25 | 92 / 96 | partial |
| Vitest 首页与 guide | 2 | 84 | 59.8 | 184 / 192 | partial |

五页 HTTP 均为 200，初始导航响应均已取得。四页的 `geo-citation-discoverable` 缺少该启发式所需的规范地址证据，因此保留未知，不生成这条检查的整改项。这里不据此声称页面不能被搜索引擎收录。

对相同采集结果分别运行修改前和当前函数：三个站点数值分数均未变化，但旧实现将引用维度全部标成 `complete`，新版全部准确标成 `partial`。IANA 首页本身的检查完整，未知项位于 about 页，站点汇总仍必须保留这个缺口。

Vitest 的真实报告进一步经 CLI `site-assessment` 读取，得到 `seo.geo.status: partial`、覆盖率 `0.958`、`readiness.geo.status: needs_follow_up`，证明证据状态能够交给 AI。

## 可复核命令与证据

以下命令均在隔离的 `HEIMDALL_DATA_DIR` 中执行，未使用登录档或真实用户数据：

```text
node core/src/seo/audit.mjs https://www.iana.org --max 2
node core/src/seo/audit.mjs https://example.com --max 1
node core/src/seo/audit.mjs https://vitest.dev --max 2
node bin/heimdall.mjs site-assessment vitest.dev --json
```

证据保存在仓库外：`D:/Github-Star/heimdall-evidence-archive/2026-11-12/geo-evidence-integrity/`。

- `live/workspace/<site>/seo/seo.json`、`seo.html`：原始审计结果与报告。
- `live-summary.json`：三站采集范围、分数、未知项和待办摘要。
- `before-after.json`：相同采集数据的修改前后对照。
- `vitest-assessment.json`：真实报告的 CLI 站点评估。
- `pnpm-check.log`、`seo-browser-regression.log`：项目检查与真实本地 HTTP 浏览器回归日志。

## 验证与保留边界

- `pnpm check`：通过，含 1,329 项 Core fast 测试、7 项 MCP 测试、构建、语法、文档、公开案例、冻结验证器、技能同步、依赖审计和控制台完整演示。演示最终 `accepted: true`。
- `node --test core/test/seo-gate-collection.test.mjs`：9/9 通过；覆盖 HTTP 503 不评分、重新请求不能证明初始 HTML、基线保护与报告文字。
- `node --test core/test/seo-geo.test.mjs core/test/agent-assessment.test.mjs`：13/13 通过；覆盖混合成功/失败页面、空站点、不适用项、部分未知、旧版与缺失 GEO。
- 一次性 `.tmp/` 产物纳入忽略规则，现有证据保留，不提交站点快照。状态页移除了“行为与契约只做赛后”的过时主线说明。

GEO 分数仍是结构信号准备度，不是排名或模型引用概率。正文质量、实体关系真实性、不同语言长度阈值及真实模型引用仍需专门案例校准；本轮未调用模型评审，也未验证登录后的业务流程或全站后端等价。

## 后续修正：GEO v4 与 Google 页面级限制

核对 Google Search Central 的 AI 搜索功能、robots 元指令和 canonical 文档后，修正原“公开内容可发现”检查。现在它明确只检查 Google 页面级索引与全量摘要限制，不把 canonical 当作前置证据，也不推断其他 AI 引擎或爬虫的状态。

采集器在保留原有爬虫作用域和初始 HTML 证据的基础上，增加 `robotsEvidence.nosnippet[]` 与 `meta.nosnippet`：识别 `nosnippet`、`max-snippet:0`，区分正数与 `-1`，并正确处理逗号或空格分隔的规则。摘要限制不会变成 `noindex`；其他爬虫专属指令、数字前缀或空值冒号语法也不会误套到 Google。JavaScript 移除初始限制时仍保留初始证据。

缺少新的摘要采集字段或未核实初始响应时，该检查保留 `unknown`。检查通过只说明本次没有发现所检查的页面级限制，不代表 robots.txt 放行、页面实际收录或模型会引用。报告明确保留未检查的 `data-nosnippet`、单独授权例外与其他 AI 爬虫策略。canonical 建议也改为先核对重复页面和索引意图，避免一律要求本域自指。

共享解析器同时修复了“值指令后以空格连接 noindex”被忽略的情形，因此 SEO 评分口径、采集口径均升级为 **5**，GEO 方法升级为 **4**；扣分权重没有增加。这样沿用既有门禁和趋势分组，就能隔离旧采集与新解释结果。HTML 报告同步识别版本 5，继续显示资源分类、字节数和结构化数据的边界说明。

## v4 同批真实页面对照

在独立数据目录重新访问三个公开站点、共五页，HTTP 均为 200，首次导航 HTML 均已核实；再对同一批新数据运行真实旧版 `1fe9d802` 的 GEO v3 和当前 GEO v4。没有把站点内容变化与算法变化混在一起。

| 站点 | 页面 | SEO v5 | 同批 GEO v3 → v4 | v4 声明检查覆盖 |
| --- | ---: | ---: | ---: | --- |
| IANA 首页与 about | 2 | 69 | 54.2 → 55.2 | complete，192/192 |
| example.com 首页 | 1 | 46 | 25 → 28.1 | complete，96/96 |
| Vitest 首页与 guide | 2 | 84 | 59.8 → 61.5 | complete，192/192 |

四页没有 canonical，但当前已完整采集其 Google 页面级索引和摘要指令，所以这条检查由旧口径的 `unknown` 变为有证据的 `pass`；canonical 的结构线索检查仍独立保留。分数变化来自方法调整，不表示真实排名或引用表现上升。`complete` 仅指本模型声明检查的证据覆盖。

另复制 IANA 首页的实际采集信号，仅在本地注入 `nosnippet`：旧版仍 `pass`，新版为 `fail`；恢复原信号后重新 `pass`。源站和原始采集对象未修改。这是本地故障注入，不是发现 IANA 存在摘要限制。实际 HTML 报告已显示新边界说明，Vitest 经 `site-assessment` 返回方法 4、六项 P1 待办和 `needs_follow_up`，不会因为证据完整就宣称整改完成。

版本迁移另用真实旧版 SEO 基线验证：当前严格基线门禁退出码为 1，明确拒绝旧口径，原文件 SHA-256 不变；新旧评分版本的历史记录不会被连成同一条趋势。旧基线须保留，改用新路径重新采集并审阅，不能自动覆盖或把方法变化算作站点回归。

## v4 验证与证据

- 核心快速集 1,333/1,333 通过；最终 SEO、robots、基线、历史和站点评估定向测试 95/95 通过。
- Linux Node 22 的 GEO、基线、历史与站点评估测试 55/55 通过；矩阵 9/9、版本调用方和监控相关测试 17/17 通过。
- 版本迁移测试曾抓到 HTML 报告写死版本 4、导致新报告漏显示说明的问题，已在现有渲染器修复。没有新增依赖、测试文件或运行时模块。

证据目录：`D:/Github-Star/heimdall-evidence-archive/2026-11-12/geo-snippet-controls/`。`live-final/` 保存评分 5、采集 5、GEO 4 的实际报告和新基线；`summary.json`、`comparison.log` 保存同批前后对照、本地注入和基线隔离；`vitest-assessment.json` 保存 AI 站点评估；各测试日志和早期失败记录继续保留。门禁脚本曾误把拒绝旧基线的退出码预期为 2，现已按既有协议校正为 1，错误日志为 `harness-exit-code-mismatch.log`。

机制依据（核对日期：2026-11-12）：[Google AI 搜索功能](https://developers.google.com/search/docs/appearance/ai-features)、[robots 元指令与 X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)、[重复页面与 canonical](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)。真实模型引用、robots.txt 与各 AI 爬虫的实际访问策略、跨语言内容质量和授权业务旅程继续保留为未完成范围。

提交 `08aaa850` 的远端 Docs `43231037070` 抓到使用手册和基线示例仍写旧版本，原始失败日志保存在同一证据目录的 `docs-guide-version-failure.log`。后续同步两份指南的口径、文件名和 JSON 示例，并扩展原有版本守卫核对所有示例；不把本地早期通过结果代替最终版本检查。
