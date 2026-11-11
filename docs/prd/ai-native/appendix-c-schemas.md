# 附录 C 数据 schema

上一篇：[附录 B 技能剧本](appendix-b-playbooks.md) · 下一篇：[附录 D 参考资料与术语](appendix-d-references.md)

本附录给出 Bifröst 各种数据的**形状**：信封、证据引用、出处、简报、分段、参考包、修复包、门禁、重建工作区配置、账本、任务、旅程、行为规格、契约草案、令牌与预算、审计日志。字段表是规范；JSON 示例标「示意」，数值是虚构的。工具怎么用见 [附录 A](appendix-a-tools.md)，需求编号见 [04](04-requirements.md)。凡带【读码】的取值来自仓库现有代码；其余是设计，待 Phase 0 / Phase 1 验证。

---

## 0. 总则

| 项 | 规则 |
| --- | --- |
| schema 与版本 | 每个顶层文档带 `schema`，形如 `"heimdall.brief/1"`（末尾是整数版本）。新增可选字段不升版本；破坏性变更升版本，旧版本再保留一个阶段的读取能力。消费者**必须忽略未知字段** |
| 时间 | ISO 8601 UTC，毫秒精度：`2026-10-28T10:15:30.000Z`。时长用整数毫秒，字段以 `Ms` 结尾 |
| 数值单位 | 字段名带 `Pct` = 百分数（0 ~ 100）；不带 = 0 ~ 1 的比例（如 `pixelSimilarity`）；坐标和尺寸是 CSS 像素，原点在左上，用**整页坐标系**（每个视口各一套） |
| 网页来源字符串 | 说明里标〔网页〕的字段，内容来自被克隆的页面（DOM 文本、属性、`title`、`alt`、注释、CSS 里的字符串、路径片段等），输出时**已被围栏**并视为数据而非指令（格式与规则见 [08 §3](08-security-governance.md)） |
| 秘密 | 任何 schema 都不得出现 cookie、`Authorization`、令牌、原始 HAR 正文。旅程的原始 HAR 在 schema 里只是个**标记**，没有 URI |
| 大小 | 修复包 JSON ≤ 128 KB；单张图 ≤ 1.5 MB；普通字符串字段 ≤ 2000 字符（大纲、子树、CSS 规则除外，受 `tokenBudget` 约束）；`regions` 每个视口最多返回 50 条，其余折叠进计数；账本一行 ≤ 8 KB；契约夹具单个响应体 ≤ 1 MiB（沿用 `live/har.mjs` 的 `MAX_PUBLIC_DATA_BYTES`【读码】） |

**ID 规则**

| ID | 格式 | 稳定性 |
| --- | --- | --- |
| `jobId` | `job_` + 8 位小写 base36 | 一个任务一个；一个任务可对应多个引擎 `taskId`（`Job.engineTasks`） |
| `runId`（对比 / 门禁） | `run_<UTC 紧凑时间>_<6 位十六进制>`，如 `run_20261028T101530Z_a3f9c1` | 按时间可排序 |
| `refId` | `ref_` + sha256(`siteId`\|`page`\|`capturedAt`) 前 8 位十六进制 | 同一次捕获稳定；重新捕获得到新 `refId` |
| `sectionId` | `sec-<role>-<6 位十六进制>`，十六进制取 sha256(`siteId`\|`page`\|`domPath`\|`role`) 前 6 位 | 同一页、DOM 路径不变时跨重新生成稳定（E6-03） |
| `regionId` | `r<viewport>-<两位序号>`，如 `r1440-03` | 只在**同一次** run 内稳定；跨 run 用 `sectionId` + 边界框匹配 |
| `assetId` | `ast_` + 内容 sha256 前 8 位十六进制 | 内容寻址（CAS），内容不变则稳定 |
| `journeyId` | `jrn_<yyyymmdd>_<6 位十六进制>` | 一次录制一个 |

---

## 1. 信封与证据引用

**Envelope**（所有能力的返回；MCP 的 `structuredContent`、CLI `--json` 最后一行、HTTP 响应体）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ok` | boolean | 是 | — |
| `result` | object | `ok:true` 时 | 能力专属；`ok:false` 时可带部分结果 |
| `error` | Error | `ok:false` 时 | — |
| `summary` | string | 是 | 中文，≤ 3 行人话 |
| `nextActions` | NextAction[] | 是（可空） | 机器可读的下一步 |
| `jobId` | string | 否 | 长任务 |
| `evidence` | EvidenceRef[] | 是（可空） | 本结果依据的证据；任何「通过 / 失败 / 缺口」结论必须有（P4） |
| `warnings` | Warning[] | 否 | 非致命问题 |
| `meta` | Meta | 否 | — |
| `trust` | Trust | 否 | 响应含网页来源文本时必有：`{nonce, untrustedPaths[]}`。`nonce` 是本次响应的随机围栏标识，`untrustedPaths` 列出不可信字段的路径（[08 §3.2](08-security-governance.md)） |
| `redactions` | object | 否 | 脱敏与清理计数，如 `{url, header, key, text, blob, control, zeroWidth}`，让读者知道「这里有东西被拿掉了」（[08 §2.3](08-security-governance.md)） |

| 子类型 | 字段 |
| --- | --- |
| **Error** | `code`（附录 A §1.5 的枚举）、`message`（中文，≤ 300 字）、`hint`（可执行：一条命令或一次工具调用）、`retryable`?（boolean）、`details`?（已脱敏的对象） |
| **NextAction** | `tool`（MCP 工具名；CLI 专属步骤写 `cli:<子命令>`，如 `cli:rebuild init`）、`args`?（对象，键名同该工具 / 命令的入参）、`reason`（一句话） |
| **Warning** | `code`（如 `gate_param_ignored`、`config_modified`、`instruction_like_text`、`mask_coverage_high`）、`message`、`where`? |
| **Meta** | `requestId`、`durationMs`、`tokenEstimate`、`truncated`（boolean）、`nextCursor`? |
| **EvidenceRef** | `uri`（`heimdall://…`）、`sha256`（小写十六进制，64 位，对 `heimdall_artifact` 实际返回的字节取）、`bytes`、`mime`?、`label`? |

```json
{ "ok": false,
  "error": { "code": "reference_missing", "message": "example.org 的 home 还没有参考包。", "hint": "先运行 heimdall_clone 取得镜像。" },
  "summary": "缺少参考包，无法生成简报。",
  "nextActions": [{ "tool": "heimdall_clone", "args": { "url": "https://example.org/", "scope": "page" }, "reason": "先取得镜像" }],
  "evidence": [] }
```

产出 E1-06、E1-07、E6-08；消费：所有工具、CLI、HTTP。

---

## 2. 出处 Provenance

给简报条目、行为规格、契约端点与字段、适配器路由挂的标签（E9-05）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `origin` | `observed` / `inferred` / `invented` | 是 | — |
| `confidence` | number（0 ~ 1） | `inferred` 必填 | — |
| `evidence` | EvidenceRef[] | `observed` 必填 | — |
| `note` | string | `invented` 必填，`inferred` 建议 | 依据或占位原因 |
| `by` | `heimdall` / `agent` / `human` | 否 | 默认 `heimdall` |

| origin | 含义 | 举例 |
| --- | --- | --- |
| `observed` | 被证据直接支持 | 抓包里确实出现过的端点与响应字段；旅程里点过的按钮 |
| `inferred` | 由观察归纳而来 | 路径模板（`/items/{id}`）、分页风格、枚举取值、字段是否必填 |
| `invented` | 没有观察依据的占位 | 种子数据、从没见过的错误响应、未触发过的状态 |

汇总规则：任何覆盖率、残差、未知项的统计都把三类**分开**列；`invented` 不得计入「已验证覆盖」。产出 E9-05；消费 `BehaviorSpec`、`ContractDraft`、`Brief.interactions`、适配器报告。

---

## 3. 简报 Brief（`heimdall.brief/1`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema` | string | 是 | `"heimdall.brief/1"` |
| `siteId`、`page` | string | 是 | — |
| `target` | string | 是 | 〔网页〕原站页面 URL |
| `capturedAt`、`generatedAt` | timestamp | 是 | 镜像捕获时间 / 简报生成时间 |
| `viewports` | integer[] | 是 | 默认 `[375,768,1440]` |
| `pageType` | enum | 是 | 沿用页面分类：`pricing` `blog` `case_study` `career` `help` `doc` `tools` `product` `listing` `auth` `legal` `company`，无法判定为 `generic`【读码：`crawler/classify.mjs`】 |
| `fidelity` | enum / null | 否 | `faithful` / `balanced` / `idiomatic`，来自重建工作区配置 |
| `detail` | enum | 是 | `outline` / `sections` / `full` |
| `untrusted` | boolean | 是 | 恒为 `true`：本文档含网页来源内容 |
| `outline` | string | `outline` / `sections` | 〔网页〕结构大纲，已围栏。算法见 [01 §1.4](01-background.md)：跳过脚本与样式、保留标签 / id / 前两个类 / role / 少量属性 / 前 60 字符文本、折叠连续相同兄弟、深度上限 14 |
| `sections` | SectionSummary[] | `sections` | — |
| `slice` | Slice | `full` | 单个分段的详情 |
| `tokens` | Tokens | 否 | 设计令牌摘要 |
| `fonts` | Font[] | 否 | — |
| `assets` | Asset[] | 否 | 资产**索引**，不含内容 |
| `interactions` | Interaction[] | 否 | — |
| `motion` | Motion | 否 | — |
| `api` | ApiSummary | 否 | 来自清洗后的 HAR，**无正文** |
| `gaps` | Gap[] | 否 | 已知缺口 |
| `gateHistory` | GateHistoryEntry[] | 否 | 该页历次对比 / 门禁摘要 |
| `budget` | `{requested, returned, truncated, nextCursor?}` | 是 | `tokenBudget` 的使用情况 |
| `provenance` | Provenance | 否 | 默认 `observed` |

| 子类型 | 字段 |
| --- | --- |
| **SectionSummary** | `id`、`role`、`label`〔网页〕、`order`、`boxes`（视口 → 边界框）、`tokenEstimate`、`shared`（boolean） |
| **Tokens** | `variables`（`{name,value,count}[]`）、`colors`、`fontFamilies`、`fontSizes`、`fontWeights`、`lineHeights`、`spacings`、`radii`、`shadows`、`breakpoints`（后几项均为 `{value,count}[]`，按出现次数降序；字段与 `extract/tokens.mjs` 的 `extractTokens` / `topEntries` 一致【读码】；值〔网页〕） |
| **Font** | `family`〔网页〕、`weights`、`styles`、`files`（`{path, format, bytes, sha256}[]`，`path` 相对重建工作区的 `public/assets`） |
| **Asset** | `id`、`kind`（`image` `svg` `font` `video` `icon` `other`）、`path`、`bytes`、`sha256`、`width`?、`height`?、`usedBy`（`sectionId[]`） |
| **Interaction** | `id`、`kind`（`menu` `tabs` `accordion` `carousel` `modal` `dropdown` `form` `search` `filter` `sort` `pagination` `toggle` `other`）、`selectorHint`〔网页〕、`sectionId`?、`evidence`、`provenance` |
| **Motion** | `counts`（`time` `scrollReveal` `scrollContinuous` `stateChange` `pointerCanvas` 五类驱动的计数）、`drivers`（按驱动分组的对象，每组 `{cn, count, handling, examples[]}`）、`waapi`（脚本创建动画的关键帧与时序，数组）；取自 `motion.json`【读码，`crawler/motion.mjs`】 |
| **ApiSummary** | `endpoints`（`{method, host, pathTemplate, status, mime, count, firstParty}[]`，`pathTemplate`〔网页〕）、`excludedCount`（被隐私规则排除的条数）、`note` |
| **Gap** | `kind`（`asset` `css-ref` `html-ref` `offline` `render` `motion` `behavior` `third-party`）、`detail`〔网页〕、`severity`（`high` `medium` `low`）、`evidence` |
| **GateHistoryEntry** | `runId`、`mode`、`level`、`verdict`、`at`、`summary` |
| **Slice** | `sectionId`；`subtreeOutline`〔网页〕；`cssRules`（`{selector, media?, declarations}[]`，取自 CSSOM，含媒体查询，〔网页〕）；`styleDigest`（`signatures:[{id, props}]` + `nodes:[{ref, sig}]`，去重后的计算样式摘要）；`assetRefs`（`assetId[]`）；`boxes` |

```json
{ "schema": "heimdall.brief/1", "siteId": "example.org", "page": "home", "target": "https://example.org/",
  "capturedAt": "2026-10-24T12:00:00.000Z", "generatedAt": "2026-10-28T10:00:00.000Z",
  "viewports": [375, 768, 1440], "pageType": "generic", "detail": "outline", "untrusted": true,
  "outline": "…（已围栏的结构大纲，格式见 08 §3）…",
  "tokens": { "colors": [{ "value": "#f0f0f2", "count": 3 }], "breakpoints": [{ "value": "(max-width: 700px)", "count": 1 }] },
  "assets": [], "gaps": [], "gateHistory": [],
  "budget": { "requested": 15000, "returned": 900, "truncated": false } }
```

产出 E6-01 ~ E6-07、E6-15；消费 E4-02（重建剧本）、E7-12、E11-09。

---

## 4. 分段计划 SectionPlan（`heimdall.sections/1`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`siteId`、`page`、`viewports`、`generatedAt` | — | 是 | — |
| `sections` | Section[] | 是 | 按页面纵向顺序 |
| `dependencies` | `{id, dependsOn[], reason}[]` | 是（可空） | 共享组件先行等 |
| `sharedCandidates` | `{id, sectionIds[], similarity, kind}[]` | 是（可空） | 重复子树检测出的共享候选；`kind`：`header` `footer` `nav` `card` `other`；`similarity` 为 0 ~ 1，阈值见 [05 §2](05-frontend-rebuild.md) |
| `coverage` | `{heightPct, overlapPct, unassignedPx}` | 是 | `unassignedPx` 按视口给出；验收：`heightPct` ≥ 98，`overlapPct` ≤ 2（E6-03） |

**Section**：`id`、`role`（`header` `nav` `hero` `content` `features` `pricing` `faq` `cta` `footer` `aside` `other`）、`label`〔网页〕、`order`、`anchor`（`{selector, domPath}`，〔网页〕）、`boxes`（视口 → `{x,y,w,h}`）、`tokenEstimate`、`shared`、`refCrops`（视口 → 参考裁剪图 URI，即 `…/ref/{viewport}.png?y=&h=`）。

产出 E6-03；消费 E6-04、E7-12、`FixPacket.regions[].sectionId`。

---

## 5. 参考包 ReferencePack（`heimdall.reference/1`）

页面的冻结参考。快速与正式两个裁判都以它为基线，而不是会漂移的活站。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`refId`、`siteId`、`page`、`capturedAt` | — | 是 | — |
| `source` | object | 是 | `mirrorPath`（工作区内相对路径）、`formalBaseline`?（正式基线副本：`{path, healthProbe, changes[]}`，去掉外部请求与断链引用后的镜像拷贝，由 `Gate` 按视口封装临时回环服务供给，[05 §1.5](05-frontend-rebuild.md)）、`viewportEntries`?（视口 → 入口文件；正式门禁按配置视口分别验收，缺少实际入口时阻断，见[工作台边界](../../competition/acceptance-workbench.md)）、`originalUrl`〔网页〕 |
| `scoreVersion` | integer | 是 | 验证器评分口径版本（沿用 `verify.json` 的 `scoreVersion`【读码】） |
| `viewports` | map | 是 | 视口 → `{fullPageSize{w,h}, screenshot: EvidenceRef, frames: EvidenceRef[]}`（`frames` 是原站多帧采样，用来算动态区域） |
| `masks` | Mask[] | 是（可空） | `{viewport, bbox, kind: dynamic/declared, source: frame-diff/motion/config, areaPct}` |
| `maskCoveragePct` | map | 是 | 视口 → 遮罩占比。过大时对比结论降为 `needs_review`（E6-12） |
| `domSnapshot`、`cssom` | EvidenceRef | 是 | 即 `dom.html` 与 `cssom.css` |

约束：创建后不可变，重新捕获生成新 `refId`。截图、多帧、DOM 与 CSSOM 来自现有页面目录里的 `shot-src*.png`、`frame-N.png`、`dom.html`、`cssom.css`【读码：工作区实际文件】。

产出 E6-09、E6-12、E7-07；消费 `FixPacket.reference`、`Gate`。

---

## 6. 修复包 FixPacket 与 CompareResult（`heimdall.fixpacket/1`）

快速裁判的产物，作用是**指导修复**。它不能宣布「通过」。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`runId`、`siteId`、`page`、`generatedAt`、`elapsedMs` | — | 是 | — |
| `mode` | `fast` / `formal` | 是 | `formal` 的失败项也会转成修复包 |
| `candidate` | object | 是 | `{kind: url/dir, ref, route, configHash?}`；`ref` 是 URL 或相对路径 |
| `reference` | `{refId, capturedAt}` | 是 | — |
| `viewports` | integer[] | 是 | 本次实际度量的视口 |
| `perViewport` | map | 是 | 视口 → PerViewport |
| `regions` | Region[] | 是 | 默认每视口返回前 12 条（[05 §3.1](05-frontend-rebuild.md)），上限 50，其余折叠进 `regionsTotal` |
| `order` | `regionId[]` | 是 | 建议修复顺序（面积 × 严重度） |
| `trend` | Trend | 是 | 首次运行时 `state` 为 `same`、无 `previousRunId` |
| `verdict` | Verdict | 是 | — |
| `evidence` | EvidenceRef[] | 是 | — |

| 子类型 | 字段 |
| --- | --- |
| **PerViewport** | `pixelSimilarity`（0 ~ 1，已排除遮罩；口径同 `verify/compare.mjs`，[05 §1.2](05-frontend-rebuild.md)）、`maxBlobPct`（最大连通差异块占视口面积的百分数）、`maxRegionPct`（最大集中区域占视口面积的百分数，Ph0 新增）、`alignment`（`{equalRowsShare, bands[]}`：行对齐摘要，Ph0 新增）、`maskCoveragePct`、`diffShape`（`identical` `negligible` `concentrated` `mixed` `diffuse`，沿用 `differ/shape.mjs`【读码】）、`size`（`{ref:{w,h}, cand:{w,h}}`）、`heightDelta`（px）、`regionsTotal`、`regionsReturned` |
| **Region** | `id`、`viewport`、`sectionId`?、`bbox`（参考坐标）、`kind`（`diff` 真差异 / `insert` 候选多出的行 / `moved` 被推开的内容 / `pairshift` 成对接缝还原的平移，Ph0 新增）、`candBbox`?（候选坐标）、`areaPct`、`density`（差异像素占外接框比例）、`scattered`?（零散噪声，严重度固定 low）、`severity`（`high` `medium` `low`）、`cause`、`causeConfidence`、`heightDelta`?、`consequenceOf`?（级联的根区域 ID）、`shift`?（`{dx,dy}`）、`element`?（`{best[], container?, diffs[]}`：每个条目含 `ref`、`anchor`、`box`（参考坐标）、`style`（参考计算样式）、`cand`（候选元素 `{tag, box, style}`）、`match`（`{by: text|image|section-root|structure, confidence}`）、`styleDiff`（`{prop, ref, cand, delta?}[]`）、`boxDiff`（`{x,y,w,h}`）；`diffs` 是区域内其他有样式差的元素）、`crops`（`{ref, cand, diff}` 三个 `heimdall://run/…/crop/…` URI）、`hint`（中文，由规则生成的一句话建议）、`completeness`（`region`：只有 v1 字段；`element`：含 `element` 与 `propDiffs`，即 v2） |
| **Trend** | `previousRunId`?、`deltaPixel`?（视口 → 差值）、`state`（`better` `same` `worse` `oscillating` `stagnant`）、`note`? |
| **Verdict** | `status`（`fail` `needs-work` `near` `pass-candidate`）、`target`（目标等级 `bronze` `silver` `gold`）、`note` |

**cause 的判据**（设计，E6-10 / E6-16）

| cause | 判据 |
| --- | --- |
| `missing-content` | 差异集中，且候选侧该区域为空白或缺元素 |
| `extra-content` | 候选侧多出参考里没有的内容；多出的是一整块单色时改报 `color`（Ph0 新增） |
| `shift` | 平移 `(dx,dy)` 后差异显著下降（沿用 `probe:shift` 的思路） |
| `size` | 对应元素宽高与参考差超过阈值 |
| `color` | 区域内前景 / 背景色差（计算样式或像素均值） |
| `font` | 字体族、字号、字重、行高之一不同 |
| `spacing` | `margin` / `padding` / `gap` 不同 |
| `image-missing` | 候选侧缺图，或图像哈希不匹配 |
| `overflow` | 候选出现横向溢出或内容被裁 |
| `behavior` | 双侧流程回放的可观察结果不一致（E8-03） |
| `unknown` | 以上都不满足 |

**verdict.status 的判定**【假设】：`fail` = 任一视口低于 bronze 阈值；`needs-work` = 满足 bronze 但未达目标等级；`near` = 距目标等级阈值不超过 1 个百分点，且没有 `high` 严重度区域；`pass-candidate` = 快速度量下全部达到目标等级阈值，**仍须 formal 确认**。

**CompareResult**（`heimdall_compare` 的 `result`）：`runId`、`mode`、`fixpacketUri`、`verdict`、`trend`、`perViewport`、`regions`（前 N 条内联，N 受 `tokenBudget` 约束）、`order`、`truncated`；`formal` 另有 `gate`（完成时）或 `jobId`。

```json
{ "schema": "heimdall.fixpacket/1", "runId": "run_20261028T101530Z_a3f9c1", "siteId": "example.org", "page": "home", "mode": "fast",
  "candidate": { "kind": "url", "ref": "http://127.0.0.1:5199", "route": "/" }, "reference": { "refId": "ref_5c21e0aa", "capturedAt": "2026-10-24T12:00:00.000Z" },
  "viewports": [1440],
  "perViewport": { "1440": { "pixelSimilarity": 0.962, "maxBlobPct": 0.9, "maskCoveragePct": 0, "diffShape": "concentrated", "heightDelta": 24, "regionsTotal": 1, "regionsReturned": 1 } },
  "regions": [{ "id": "r1440-01", "viewport": 1440, "sectionId": "sec-hero-3f9a1c", "bbox": { "x": 0, "y": 0, "w": 1440, "h": 640 }, "areaPct": 3.1, "severity": "high",
                "cause": "shift", "shift": { "dx": 0, "dy": 24 }, "completeness": "region",
                "crops": { "ref": "heimdall://run/run_20261028T101530Z_a3f9c1/crop/r1440-01/ref.png", "cand": "heimdall://run/run_20261028T101530Z_a3f9c1/crop/r1440-01/cand.png", "diff": "heimdall://run/run_20261028T101530Z_a3f9c1/crop/r1440-01/diff.png" },
                "hint": "整段下移约 24px，检查上方元素的外边距。" }],
  "order": ["r1440-01"], "trend": { "state": "better" }, "verdict": { "status": "needs-work", "target": "silver" } }
```

产出 E6-09 ~ E6-13、E6-16；消费 E7-08（收敛控制）、E11-03（AI 活动）、E13-05。

---

## 7. 门禁 Gate（`heimdall.gate/1`）

**正式裁判**的产物，唯一能宣布「通过」的来源（P1）。它由两部分合成：验收 Mirror 报告（视觉、语义结构、运行健康、声明的交互点），加 Heimdall 的补充检查（计算样式、资产本地化）。合成发生在 Heimdall 侧，**不改动验收子系统的任何文件**。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`runId`、`siteId`、`page` | — | 是 | — |
| `level` | `bronze` / `silver` / `gold` | 是 | — |
| `configHash` | string | 是 | 规范化后的门禁配置（阈值、遮罩、视口、流程）的 sha256；一次运行内冻结（E7-09） |
| `frozenAt` | timestamp | 是 | — |
| `thresholds` | object | 是 | 本次实际生效的阈值（见下表） |
| `dimensions` | object | 是 | 见下 |
| `verdict` | `passed` / `failed` / `blocked` / `needs_review` | 是 | — |
| `residuals` | Residual[] | 是（可空） | `{dimension, viewport?, sectionId?, detail, evidence[]}` |
| `evidence` | EvidenceRef[] | 是 | — |
| `source` | `{acceptanceRunId, validatorFingerprint?}` | 是 | 对应的验收运行 |

**dimensions**：`visual`（`pass`，`byViewport[viewport] = {pixel, maxBlobPct, pass}`）；`structure`（`pass`，`score`，`byKind = {landmark, heading, link, imageAlt, formControl}`）；`style`（`pass`，`deviatingPct`，`sampled`，`topDeviations[]`）；`assets`（`pass`，`external[]`，`missing[]`）；`health`（`pass`，`pageErrors`，`localHttpErrors`，`horizontalOverflow`（视口列表））；`behavior`?（`pass`，`flows:[{id, status}]`，仅在声明了流程时出现）。

**默认阈值**【假设，待校准】

| 维度 | bronze | silver | gold |
| --- | --- | --- | --- |
| `visual.pixel`（每视口，排除遮罩） | ≥ 0.95 | ≥ 0.97 | ≥ 0.99 |
| `visual.maxBlobPct` | ≤ 1.5 | ≤ 0.5 | ≤ 0.2 |
| `structure` | ≥ 0.95 | ≥ 0.98 | ≥ 0.99 |
| `style`（偏差元素占比 `Pct`） | ≤ 10 | ≤ 5 | ≤ 2 |
| `assets` 零外链 | 可选 | 必须 | 必须 |
| `health` 无页面错误、无本地 4xx / 5xx、无横向溢出 | 必须 | 必须 | 必须 |
| `behavior` 声明的流程全部通过 | 如有声明则必须 | 同左 | 同左 |

**verdict 的合成规则**：各维度取合取，**没有部分得分**；任一维度 `blocked`（缺测、环境或证据失败）→ `blocked`；无失败但有维度 `needs_review`（如遮罩过大、视觉证据不可靠）→ `needs_review`；有失败 → `failed`；全部通过才是 `passed`。与验收子系统一致：视觉高分不能抵消交互失败【读码：`docs/competition/acceptance-workbench.md`】。

**与验收报告的对应**【读码】：`health` ← 导航 / HTTP、console 与脚本错误、网络失败、横向溢出；`structure` ← 标题 / 主标题 / 控件语义，另加地标、标题、链接、图片 `alt`、表单控件的清单对照；`visual` ← 视觉差异检查（验收计划里 `thresholds.visual` 取本表 `visual.pixel`）；`behavior` ← 声明的验收点（点击 / 输入 / 断言）；`style` 与 `assets` 是 Heimdall 的补充检查，不在验收报告里。验收计划受每次 8 路由、24 验收点、3 视口的上限约束，超限会被拒绝而不是抽样。

产出 E7-06、E7-07、E7-09；消费 E7-10（Floor=Mirror 交付）、E13-05、`Brief.gateHistory`。

---

## 8. 重建工作区配置（`heimdall.config/1`，文件 `heimdall.config.json`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`siteId` | — | 是 | — |
| `stack` | enum | 是 | `html-css` `vite-react-ts-tailwind` `vite-vue3-ts-tailwind` `nextjs-app-router` `astro`（后三项为后续阶段） |
| `devServer` | `{command, url, cwd?, readyTimeoutMs?}` | 是 | `command` 在 Ph1 ~ 3 只由代理或人启动；Heimdall 自己执行它要等沙箱（E10-06） |
| `pages` | `{name, route, sections, gate?}[]` | 是 | `sections` 取 `"auto"` 或 `sectionId[]`；`gate` 可按页覆盖等级 |
| `viewports` | integer[] | 是 | 默认 `[375,768,1440]` |
| `fidelity` | enum | 是 | `faithful` / `balanced` / `idiomatic` |
| `modelClass` | enum | 否 | `frontier` / `standard` / `economy`，默认 `standard`。只供技能读取以调整分段粒度和反馈细节（[附录 B §1.4](appendix-b-playbooks.md)），**不影响门禁** |
| `gate` | `{level, overrides?}` | 是 | `overrides` 允许人覆盖具体阈值 |
| `masks` | `{selector, reason}[]` | 否 | 人声明的动态区域，不计入像素分 |
| `offline` | boolean | 否 | 是否要求零外链；`silver` / `gold` 强制为 true |
| `budget` | object | 否 | `maxIterationsPerSection`（默认 4）、`maxIterationsPerPage`（默认 8）、`maxUsd`、`maxWallMinutes`、`maxToolCalls` |
| `engine` | `{url?, dataRoot?}` | 否 | 供 CLI 连接引擎并核对数据根 |
| `createdAt`、`createdBy` | — | 是 | — |

门禁相关字段（`gate`、`masks`、`viewports`、`offline`）**由人维护**。每次运行开始时规范化并取哈希写入账本；运行中被改动则本次仍用冻结值，并返回 `warnings: config_modified`（E7-04、E7-09）。

```json
{ "schema": "heimdall.config/1", "siteId": "example.org", "stack": "vite-react-ts-tailwind",
  "devServer": { "command": "pnpm dev --port 5199", "url": "http://127.0.0.1:5199" },
  "pages": [{ "name": "home", "route": "/", "sections": "auto" }],
  "viewports": [375, 768, 1440], "fidelity": "balanced", "gate": { "level": "silver" }, "offline": true,
  "budget": { "maxIterationsPerSection": 4, "maxIterationsPerPage": 8, "maxUsd": 8, "maxWallMinutes": 45 },
  "createdAt": "2026-10-28T09:00:00.000Z", "createdBy": "heimdall rebuild init" }
```

产出 E7-01；消费 E6-09（`dir` 模式）、E7-04、E7-08、E7-09、E1-13。

---

## 9. 重建运行与账本（`heimdall.ledger/1`，文件 `ledger.jsonl`）

飞行记录器：追加写，一行一条 JSON。`state.json` 是它的派生快照（`type:"state"`）。

| `type` | 出现时机 | 字段 |
| --- | --- | --- |
| `run` | 首行 | `runId`、`siteId`、`pages`、`stack`、`fidelity`、`gateLevel`、`configHash`、`budget`、`client`?、`model`?、`startedAt` |
| `iter` | 每次对比后 | `iter`、`page`、`sectionId`?、`compareRunId`、`before` / `after`（视口 → `pixelSimilarity`）、`kept`、`action`（`edit` `revert` `escalate`）、`strategy`?（`faithful` `balanced` `idiomatic`）、`tokens{in,out,cached}`?、`usd`?、`ms`、`model`?、`note`? |
| `escalation` | 触发升级 | `reason`（`stagnant` `oscillating` `worse` `budget`）、`sectionId`、`action` |
| `gate` | 正式门禁完成 | `gateRunId`、`level`、`verdict` |
| `end` | 末行 | `status`（见下）、`residuals[]`、`totals{iterations, usd, tokens, ms}`、`endedAt` |

终态 `status`：`passed` / `passed_with_residuals` / `failed_with_residuals` / `budget_exhausted` / `cancelled`。回放时每行额外带 `replayOf: <runId>`，控制台据此显著标注「回放」（E7-14）。

```json
{"schema":"heimdall.ledger/1","type":"run","runId":"run_20261028T100000Z_77aa10","siteId":"example.org","pages":["home"],"stack":"vite-react-ts-tailwind","fidelity":"balanced","gateLevel":"silver","configHash":"9d1c…","startedAt":"2026-10-28T10:00:00.000Z"}
{"schema":"heimdall.ledger/1","type":"iter","iter":1,"page":"home","sectionId":"sec-hero-3f9a1c","compareRunId":"run_20261028T101530Z_a3f9c1","before":{"1440":0.91},"after":{"1440":0.962},"kept":true,"action":"edit","ms":41200}
{"schema":"heimdall.ledger/1","type":"end","status":"passed_with_residuals","residuals":[{"dimension":"visual","viewport":375,"detail":"页脚 2px 高度差"}],"totals":{"iterations":6,"ms":611000},"endedAt":"2026-10-28T10:10:11.000Z"}
```

产出 E7-08、E7-14、E14-04；消费 E11-03、E14-02。

---

## 10. 任务 Job（`heimdall.job/1`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`jobId`、`capability`、`argsHash`、`createdAt`、`tokenId` | — | 是 | `capability` 如 `clone` |
| `idempotencyKey` | string | 否 | — |
| `status` | enum | 是 | `queued` `running` `waiting_input` `succeeded` `failed` `cancelled` `expired` |
| `startedAt`、`endedAt` | timestamp | 否 | — |
| `queue` | `{position?, etaMs?}` | 否 | `queued` 时 |
| `progress` | `{stage, pct?, message?}` | 否 | — |
| `stages` | `{name, status, startedAt?, endedAt?}[]` | 否 | 如 `forge`、`verify` |
| `engineTasks` | string[] | 否 | 底层引擎任务 ID（一个任务可跨多个） |
| `result` | object | `succeeded` 时 | 即该能力信封的 `result` |
| `error` | Error | `failed` 时 | — |
| `budget` | `{limits, used}` | 否 | — |
| `cancelRequested` | boolean | 是 | — |
| `mirrorDegraded` | boolean | 否 | 任务存储降级标记，沿用引擎现有字段【读码】 |

**状态机**：`queued → running / cancelled / expired`；`running → waiting_input / succeeded / failed / cancelled`；`waiting_input → running / cancelled / expired`（等人确认或操作，如旅程录制）。终态：`succeeded` `failed` `cancelled` `expired`。

**事件**：`{seq, ts, kind, stage?, pct?, message?, data?}`，`seq` 在任务内单调递增（供 `?after=` 续传）；`kind` 取 `queued` `started` `stage` `progress` `warning` `result` `cancel-requested` `exit`。引擎的 `@@EVENT@@` 事件映射为 `stage` / `progress`，原载荷放 `data.legacy`；逐行日志不入库。

产出 E1-08、E1-10；消费 E2-07、E5-02、E11-03。

---

## 11. 旅程 Journey（`heimdall.journey/1`）

人在**可见浏览器**里的一次操作录制。它是后端信号的主要来源，也是仅有的、会产生向源站写请求的地方（E12-10）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`journeyId`、`siteId` | — | 是 | — |
| `startUrl` | string | 是 | 〔网页〕 |
| `goal` | string | 否 | 人写的目的，如「搜索并翻页」 |
| `recordedBy` | `"human"` | 是 | 恒为 `human` |
| `consent` | `{attestedBy, at, statementId}` | 是 | `attestedBy` 恒为 `local-operator`：本机操作者声明有权操作该系统；不能由代理代为声明 |
| `sessionName` | string | 否 | 复用已保存的命名登录态；不自动登录 |
| `startedAt`、`endedAt` | timestamp | 是 | — |
| `steps` | JourneyStep[] | 是 | 上限 500 |
| `network` | object | 是 | `sanitizedHar`（EvidenceRef）、`requestCount`、`writeRequests`、`rawHar: {stored: true, secret: true}`（**没有 URI**，不经任何工具返回） |
| `artifacts` | object | 否 | `operationPlanDraft`?、`behaviorSpec`?（EvidenceRef） |

**JourneyStep**：`n`、`tMs`、`action`（`navigate` `click` `fill` `press` `select` `scroll` `submit` `wait`）、`target`（`{selector〔网页〕, role?, name?〔网页〕}`）、`value`（**已脱敏**：`{redacted: true, kind: text/email/secret/number/other, length}`）、`url`〔网页〕、`domSnapshot`?、`screenshot`?（EvidenceRef）、`requests`（清洗 HAR 里的条目下标）。人输入的值不会出现在任何返回里。

产出 E8-05；消费 E9-01、E8-01、E12-02。

---

## 12. 行为规格 BehaviorSpec（`heimdall.behavior/1`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`siteId`、`page`、`generatedAt` | — | 是 | — |
| `components` | Component[] | 是 | — |
| `flows` | Flow[] | 是 | — |
| `network` | `{flowId, endpoints:[{method, pathTemplate, kind: read/write, count}]}[]` | 否 | `write` 只可能来自人录制的旅程 |
| `unknowns` | `{kind, detail}[]` | 是（可空） | 如「未触发过表单提交」 |
| `operationPlanDraft` | EvidenceRef | 否 | 导出的 `operation-plan.json` 草案，**人审后**才执行 |

**Component**：`id`、`kind`（同 `Interaction.kind`）、`selectorHint`〔网页〕、`sectionId`?、`states`（`{id, label?, observable}[]`，`observable` 描述可见性 / ARIA / 文本 / URL 的取值）、`transitions`（`{from, event, to, effects[]}[]`；`event`：`click` `hover` `focus` `input` `submit` `scroll` `keydown`；`effects[]`：`{kind: class/aria/visibility/text/url/request, detail}`）、`provenance`。

**Flow**：`id`、`title`、`steps`、`expect`、`sessionName`?、`provenance`。与现有 `operation-plan.json` 的对应【读码：`USAGE.md`】：`steps` ↔ `actions`（`navigate` `click` `fill` `scroll` `useSession`），`expect` 取 `visible` `hidden` `text-includes` `url`；`count` `value` `attribute` `class` 是**扩展**，要等 E8-04。

产出 E8-01、E8-02、E8-06；消费 E8-03（双侧回放）、E4-03。

---

## 13. 契约草案 ContractDraft（`heimdall.contract/1`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema`、`siteId`、`generatedAt` | — | 是 | — |
| `tier` | `B0` / `B1` / `B2` / `B3` / `B4` | 是 | 当前已达到的分级（下表） |
| `sources` | `{pages, journeys[], harEntries}` | 是 | 推断依据的规模，不含内容 |
| `openapi` | OpenAPI 3.1 | 是 | 文件 `openapi.json`；索引视图里以 EvidenceRef 引用 |
| `observations` | Observation[] | 是 | — |
| `fixtures` | Fixture[] | 是 | — |
| `unknowns` | Unknown[] | 是 | 非空时必须列出（E9-03） |
| `entities` | Entity[] | 否 | 实体模型（AI 参与，标出处） |
| `split` | `{seed, heldoutRatio}` | 是 | 训练 / 留出集的确定性切分；`heldoutRatio` 默认 0.2 |
| `coverage` | object | 是 | `endpoints{observed, withErrorSample, withWriteSample}`、`fixtures{train, heldout, excluded}`、`unknowns`、`invented` |

**OpenAPI 扩展字段**：文档根 `x-heimdall-tier`；每个 operation 与每个 schema 属性带 `x-heimdall-provenance`；每个 operation 另带 `x-heimdall-observations`（形状同下面的 Observation，去掉 `op`）。`x-heimdall-provenance` 可以写成**简写字符串**（`observed` / `inferred` / `invented`，等价于只有 `origin`），也可以写成完整的 Provenance 对象；`observed` 的证据已在 `observations` / `fixtures` 里时可用简写，`inferred`（需要 `confidence`）与 `invented`（需要 `note`）建议用完整对象。

| 子类型 | 字段 |
| --- | --- |
| **Observation** | `op`（如 `"GET /api/items"`）、`samples`、`variance`（`low` `medium` `high`，响应形状在样本间的离散程度的概括）、`firstSeen`、`lastSeen`、`statusCodes`（状态 → 次数）、`paramVariance`（参数名 → 不同取值个数）、`volatileFields`（JSON 路径，重放比较时忽略，如时间戳、随机 ID）、`pagination`（`{style: page/offset/cursor/none, params[]}`）、`confidence` |
| **Fixture** | `op`、`split`（`train` / `heldout`）、`request{method, path, query, headers, body?}`、`response{status, headers, body?, bodyEncoding?}`、`sourceRef`（EvidenceRef）、`provenance`。响应头只留安全子集：`content-type` `cache-control` `etag` `last-modified` `content-language` `access-control-allow-origin`【读码：`live/har.mjs` 的 `SAFE_RESPONSE_HEADERS`】 |
| **Unknown** | `kind`（`single-sample` `unexercised-param` `unexercised-write` `auth-unknown` `error-shape-unknown` `role-unknown` `rate-limit-unknown` `background-job` `side-effect-unknown`）、`op`?、`detail`、`suggestedJourney`?（要录制什么才能消除它） |
| **Entity** | `name`、`source`（`response-schema` `path` `ai`）、`fields`（`{name, type, required?, enum?, provenance}[]`）、`keys`、`relations`（`{to, kind, via}[]`）、`provenance` |

**夹具的清洗**：夹具与「静态回放」的口径不同——后者遇到 API 响应整条排除，前者要保留结构与非敏感值，所以敏感键值替换为类型占位（如 `"<redacted:email>"`），但仍遵守同一套私有路径 / 键 / 头 / 正文规则（`live/har.mjs` 里的 `PRIVATE_*` 模式【读码】）；命中规则的条目整条排除并计入 `coverage.fixtures.excluded`。新规则落在 E9-01。

| 分级 | 含义 | 产物 |
| --- | --- | --- |
| B0 回放 | HAR 回放（现有：静态资源与许可的只读 GET） | 清洗后的 HAR 条目 |
| B1 契约 | 接口契约与类型 | `openapi.json`、`observations.json`、`fixtures/`、`unknowns.json` |
| B2 行为 mock | 有状态替身，按现有运行时适配器协议落地 | + `runtime-adapter/` |
| B3 服务脚手架 | 可部署的服务项目（含迁移与测试） | + 服务目录 |
| B4 所有者协作 | 导入所有者的规格 / 库表 / 源码，与推断结果对账 | + 对账报告 |

**B2 的适配器约束**【读码：`live/adapter-runtime.mjs`】：`runtime-adapter/` 目录只允许 `index.mjs` 与 `manifest.json` 两个文件；`manifest` 为 `{version: 1, routes: [{method, path}], sessions?: {<name>: {method: "POST", path}}}`；`routes` 1 ~ 200 条，`method` 取 `GET HEAD POST PUT PATCH DELETE OPTIONS`，`path` 以 `/` 开头且规范（无 query / hash、无 `\`、无 `%2f` / `%5c`），不得是 `/`、`/static*`、`/__heimdall*`、`/lm*`；`sessions` 至多 100 个，每个必须已在 `routes` 里声明为 `POST`；`index.mjs` 导出 `handle(request, {dataDir})` 并返回 `Response`；单请求体 ≤ 4 MiB，处理超时 15 秒，`manifest` ≤ 1 MiB、模块 ≤ 2 MiB；数据目录（`HEIMDALL_RUNTIME_DATA_DIR`）必须在包外。

产出 E9-02 ~ E9-04、E9-06、E9-08、E9-10；消费 E9-07（验证）、E4-03。

---

## 14. 令牌与预算

**Token**（存于 `agent.db`，哈希存储，**哈希不出库**）：`tokenId`、`name`、`scope`（`read` `clone` `build` `admin`）、`createdAt`、`createdBy`、`expiresAt`?、`lastUsedAt`?、`revokedAt`?、`budget`。

**Budget**：`limits`（`maxPages`?、`maxWallMs`?、`maxToolCalls`?、`maxLlmUsd`?）、`used`（`pages` `wallMs` `toolCalls` `llmUsd`）、`window`（`token` / `job`）。用尽时工具返回 `budget_exceeded`。默认值见 [08 §5](08-security-governance.md)。

```json
{ "tokenId": "tok_b81f", "name": "claude-code-local", "scope": "build", "createdAt": "2026-10-28T09:00:00.000Z",
  "budget": { "limits": { "maxPages": 200, "maxToolCalls": 5000 }, "used": { "pages": 3, "wallMs": 412000, "toolCalls": 87, "llmUsd": 0 }, "window": "token" } }
```

产出 E1-11 ~ E1-13、E12-04；消费 `Job.budget`、`heimdall_budget`、`heimdall_overview`。

---

## 15. 审计日志行

追加写 JSONL；**参数只存哈希与脱敏摘要**，不含令牌与任何秘密（E1-14、E12-03）。

| 字段 | 说明 |
| --- | --- |
| `ts`、`requestId` | 时间；与 `Meta.requestId` 一致 |
| `client` | `{name, version}`，取自 MCP `clientInfo` 或 CLI / HTTP 的 `User-Agent` |
| `tokenId` | 令牌 ID（不是令牌本身） |
| `tool`、`capability` | 如 `heimdall_compare`、`compare` |
| `argsHash`、`argsSummary` | 参数的 sha256；脱敏摘要 ≤ 200 字符 |
| `jobId`? | — |
| `durationMs`、`bytesOut` | — |
| `status` | `ok` / `error` / `queued` / `denied` |
| `errorCode`? | 附录 A §1.5 |
| `costUsd`? | 仅 Autopilot 与 Bench |
| `traceparent`? | 从 MCP `_meta` 透传的 OpenTelemetry 追踪上下文 |

产出 E1-14；消费 E11-03（AI 活动）、E12 系列、[08 §6](08-security-governance.md)。
