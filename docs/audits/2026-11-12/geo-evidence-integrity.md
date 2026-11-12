# GEO v3 证据完整性与公开站点复测

日期：2026-11-12。修正共享 GEO 评分和站点评估，不新增检测器、依赖或独立测试文件。

## 本轮修正

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
