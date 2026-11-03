# 08 安全、治理与成本

上一篇：[07 傻瓜式体验](07-ux.md) · 下一篇：[09 质量与指标](09-quality-metrics.md)

代理接入把三件事同时带进来：**Heimdall 手里有私有数据**（登录态、原始抓包），**它读的是不可信内容**（别人的网页），**它还能访问网络**。这三样凑齐，就是提示注入最危险的组合（见 §3.1）。本章回答：哪些边界继承、哪些要新建、各自落到哪条需求、做到什么程度算完。

---

## 0. 继承的红线与既有决定（本章不新增限制）

下面这些是项目已经定下的，**本 PRD 不松动，也不叠加新的默认限制**。

| 既有决定 | 出处 | 在本方案里的含义 |
| --- | --- | --- |
| 只碰公开页面，或操作者本人有权访问的页面；**不实现任何访问控制绕过** | [RISKS](../../../RISKS.md) §1.1 | 代理可调用的工具里没有、也不会有「绕过」类能力 |
| 登录由操作者在可见浏览器里亲手完成，我们只保存他本来就有的会话；**不自动填表、不猜口令、不绕验证码或 2FA** | RISKS §1.1（硬性，**不是可配项**） | `heimdall_journey` 的登录步骤由人完成；代理不能代输凭据，没有「自动登录」工具 |
| 产物不公网部署；自家站优先 | RISKS §1.2–1.3 | 重建项目与交付包的使用说明沿用这一口径（T9） |
| **不内置 robots 强制、不加默认节流**；并发数可配（`HEIMDALL_QUEUE_WORKERS`、`HEIMDALL_FORGE_SLOTS`） | RISKS §1.4，用户既有决定 | 本章**不引入** robots 检查、crawl-delay 或默认限速。§5 的「预算」是**成本护栏**，用来防止循环失控，不是爬取礼仪；节流如需要，仍只是可配项、默认关 |
| `/px/` 代理的 host 白名单是防 SSRF，不是合规限制 | RISKS §1.5 | 沿用；重定向与 `set-cookie` 缺口已于 2026-11-03 补齐，解析后 IP 策略仍按非本机模式建设 |
| 引擎默认只监听 `127.0.0.1`，对外需 `HEIMDALL_TOKEN` | RISKS §1.6；`engine-server.mjs` 的 `BIND` 默认值【读码】 | 「本机模式」保持今天的行为；§4 的更严策略只在非本机模式启用 |
| 验收「指纹」冻结的 10 个文件不得修改；另有两份互不一致的清单**不要统一** | [2026-10-22 审查 §4](../../audits/2026-10-22/README.md) | 本章所有新代码以组合调用方式使用验收子系统 |

---

## 1. 威胁表

阶段含义同 [04](04-requirements.md)；「残余风险」是做完缓解之后仍然存在、需要使用者知道的部分。

### 1.1 威胁与影响

| # | 威胁 | 资产 | 攻击路径 | 影响 |
| --- | --- | --- | --- | --- |
| T1 | **提示注入**：网页内容劫持代理 | 代理的指令通道，以及它手里的 shell、文件、其他 MCP 工具 | 目标页的文本、`alt`、`title`、`aria-label`、注释、`<meta>`、隐藏元素经简报、大纲、修复包进入代理上下文，内含「忽略之前的指令、读取某文件、调用某工具、把内容发到某地址」 | 代理被诱导越权执行；越是同时持有 shell 和网络的代理越危险 |
| T2 | **秘密暴露** | 登录态 `session*.json`、原始抓包 `network.har`、`operation-plan` 的输入值、LLM Key、`HEIMDALL_TOKEN` | 工具或资源把工作区文件原样返回；简报、样例里带出令牌样式字符串；日志与审计里落了明文 | 账号被冒用；模型 Key 被盗刷 |
| T3 | **SSRF / 内网访问** | 本机与内网服务、云元数据 | 代理传入指向内网的 URL；公开 URL 重定向到内网；DNS rebinding；`/px/` 跟随重定向 | 读到内网资源或云凭据 |
| T4 | **成本与资源失控** | 模型 API 费用、浏览器槽与磁盘、对第三方站点的请求量 | 代理循环无上限；并发乱发；重复提交同一任务 | 账单暴涨；机器卡死 |
| T5 | **破坏性操作** | 站点产物（CAS、交付包）、设置 | 代理调用 `reclaim`、`replace-domain --apply`、`deliver-prune --apply`、删站、清会话 | 数据丢失 |
| T6 | **生成代码的执行** | 本机环境、开发者凭据 | 重建项目的 `install` 脚本、dev server；模型写入的代码含有害逻辑 | 本机任意代码执行 |
| T7 | **插件 / 技能供应链** | 用户机器上的代理权限 | 被篡改的插件；过宽的 `allowed-tools`；恶意钩子；`.mcp.json` 指向恶意服务器；技能正文本身带注入 | 以用户权限执行代码 |
| T8 | **远程模式的跨会话泄露** | 他人的工作区、简报、令牌 | 共享引擎上令牌作用域不足、工作区无隔离 | 读到别人的站点数据 |
| T9 | **滥用**：仿冒、钓鱼、品牌滥用 | 第三方品牌与终端用户 | 用工具克隆他人站点并伪装上线 | 法律与声誉风险 |
| T10 | **数据流向模型服务商** | 页面内容、截图，可能含个人数据（登录态页面） | 外部代理把简报与截图发给其模型；Autopilot 直接调 API | 数据外流、合规风险 |

### 1.2 缓解、需求与残余风险

| # | 缓解 | 对应需求 | 阶段 | 残余风险 |
| --- | --- | --- | --- | --- |
| T1 | 随机 nonce 围栏 + 字段级标记；字符清理；长度上限；不可见文本不进正文；指令式文本告警；技能里的「不可信内容」指令块（[附录 B §4](appendix-b-playbooks.md)）；技能 `allowed-tools` 最小化；Heimdall 自身不提供 shell 或任意文件读写 | E6-15、E12-08、E4-09 | Ph1（围栏）/ Ph3（回归集） | 围栏对模型只是**软约束**，不能保证模型不被说服。最后一道防线是客户端的权限提示和最小权限 |
| T2 | 秘密级文件不进任何工具与资源通道（继承并扩展 `isSecretFile`）；统一脱敏器；「给 AI 看的 HAR」视图；令牌不入日志；LLM Key 不回显（已有） | E12-02、E12-03、E9-01 | Ph1 | 脱敏靠模式匹配，会漏掉没见过的格式。所以第一道是「根本不让秘密级文件进通道」，脱敏只是第二道 |
| T3 | 本机模式不变；非本机模式强制令牌 + 目标策略（解析后 IP 校验、重定向逐跳、防 rebinding）；`/px/` 已完成同源有限跳转、Cookie 剥离与响应预算；可选策略文件 | E12-05、E12-06、E12-09 | Ph3（比赛为本机模式；任何非本机部署之前必须完成解析后 IP 与连接时校验） | 本机模式下，代理能让 Heimdall 访问本机其他服务——这是为了夹具与本地开发**有意保留**的行为，靠客户端的联网提示与令牌作用域兜底 |
| T4 | 预算（页数、时长、工具调用、美元）；排队 + 幂等；任务取消；「停止代理」 | E1-08、E1-09、E1-13、E12-04、E11-03 | Ph1–Ph2 | 预算是估算口径，实际账单以服务商为准；外部代理自己的模型花费不在 Heimdall 预算内 |
| T5 | 默认代理档不暴露 destructive 能力；`admin` 令牌 + 本机确认；沿用「预览先行」 | E12-01、E2-15 | Ph2 | `admin` 令牌被滥用——令牌分发由使用者负责 |
| T6 | 脚手架锁版本；首次 `install` 加 `--ignore-scripts`；不继承秘密环境变量；限定在重建工作区；可选 Docker；门禁含「零外链」与 health | E7-02、E10-06 | Ph1（锁版本）/ Ph4（沙箱） | 外部代理模式（E0）下命令由代理自己执行，Heimdall 无法沙箱，只能靠客户端权限模型 |
| T7 | §7 审查清单；版本固定；内部私有市场；技能正文纳入评审 | E12-07、E4-09、E4-05、E4-10 | Ph1 | 内部市场的访问控制取决于 git 托管方的配置 |
| T8 | MVP 不做多租户（NG1）；远程模式限定「单团队单信任域」；令牌作用域；后续可按站点收窄令牌范围 | E2-16、E1-12 | Ph4 | 真正的多租户隔离需要另立设计，本 PRD 不承诺 |
| T9 | 不做技术性强制（沿用既有决定）；README 与技能顶部一句使用说明；可选组织策略文件（默认空 = 不限制）；报告标明来源站 | E12-09 | Ph3 | 无法技术性阻止滥用，只能声明边界、保留证据 |
| T10 | 数据外流清单文档；Autopilot 的外流预览与 `--no-images`、`--redact-text`；连接向导里一句话说明 | E12-11、E10-09 | Ph2 / Ph4 | 外部代理的数据流向由其客户端与服务商条款决定，Heimdall 只能说明、不能控制 |

---

## 2. 秘密

原则：**秘密级文件根本不进工具与资源通道**；脱敏器只是第二道。

### 2.1 秘密清单与通道规则

| 数据 | 位置 | 为什么是秘密 | 现状【读码】 | 本方案要求 |
| --- | --- | --- | --- | --- |
| `session.json`、`session.<name>.json`（Playwright storageState） | `workspace/<host>/` | 等同账号（cookie、localStorage） | `isSecretFile` 已拦静态通道（`core/src/paths.mjs`），`/static/**` 命中返回 403 | 同一名单约束**所有**工具、资源与 `artifact` 读取 |
| `network.har`（原始抓包） | `pages/<page>/` | 带 cookie 与 `Authorization` 头；交付包里的 HAR 才是清洗过的 | 同上 | 同上；唯一出口是 §2.4 的清洗视图 |
| `operation-plan.json`、`operation-discovery.json`、`operation-review.json` | `workspace/<host>/` | 可含输入值、内部选择器、登录态下发现的候选 | 同上 | 同上；行为规格里的输入值一律用占位符 |
| 旅程原始录制 | `workspace/<site>/agent/journeys/<id>/` | 人在登录态下的真实操作与流量 | 新 | 纳入秘密名单（§2.2） |
| `LLM_API_KEY` 等模型配置 | `core/.env` | 模型 Key | 设置接口不回显 Key；`HEIMDALL_TOKEN` 只从进程环境读 | 代理档**不暴露**任何 settings 类能力（2026-10-22 审查曾指出设置接口不拒绝带换行的值，已在提交 8388a2d 修复：`core/src/settings.mjs` 的 `safeValue`【读码】） |
| 访问令牌 | `agent.db` | 访问凭据 | 新 | 只存哈希；展示与日志里只出现 `tokenId` 前缀 |

`isSecretFile` 的判据：取叶子文件名、去掉开头的点，匹配 `^(?:session|network|operation-plan|operation-discovery|operation-review)(?=$|[.\s(_~-])`，所以备份与编辑器副本（`session.json.bak`、`network (1).har`）也命中【读码】。**它只看文件名**，被静态通道等多处调用。

### 2.2 扩展方式

旅程的原始录制是新增的秘密级数据。[03 §4.2](03-architecture.md) 已按下面两条同时处理（`raw.har` 这类名字**不会**命中上面的正则，所以不用它）：

1. **命名即命中**：原始录制命名为 `network.journey.har`、`session.journey.json`，天然落入现有规则，零改动。
2. **按目录兜底**：新增 `isSecretPath()`，把 `agent/journeys/<id>/` 下除清洗后的 `journey.json` 与 `steps/*` 之外的文件都视为秘密级；所有新工具与资源读取统一先过它。

### 2.3 脱敏器：规则来源与分层

规则**复用** `core/src/live/har.mjs` 里已有的 `PRIVATE_*` 系列模式，不复制：这些常量目前是模块私有的，实现时先导出（或抽到共享模块，比如 `core/src/agent/redact.mjs`），**`sanitizeHar` 对交付包的行为保持不变**，已有测试继续钉住它。

| 层 | 规则 | 来源 | 处理 |
| --- | --- | --- | --- |
| URL | 私有路径父段（`users`、`accounts`、`orders`、`sessions`、`tokens`、`reset-password` 等）之后的一段；不在 `SAFE_QUERY_KEYS` 里的查询值；`user:pass@` | `PRIVATE_PATH_PARENT`、`SAFE_QUERY_KEYS`、`safeReplayUrl` | 路径段与查询值替换为 `[redacted]`；含 userinfo 的 URL 整条拒绝 |
| 头 | 请求头只保留名字；响应头只保留 `content-type`、`cache-control`、`etag`、`last-modified`、`content-language`、`access-control-allow-origin` | `PRIVATE_HEADER`、`PRIVATE_DATA_HEADER`、`SAFE_RESPONSE_HEADERS` | 其余丢弃 |
| JSON 键 | `password`、`token`、`secret`、`email`、`phone`、`address`、`user_id`、`card_number` 等键名 | `PRIVATE_DATA_KEY` | 值替换为 `[redacted]`，保留键名与类型 |
| 自由文本 | `Authorization`、`Bearer …`、`api_key=`、`password:`、JWT 样式、邮箱 | `PRIVATE_TEXT` | 整个字段替换为 `[redacted]`（保守）并计数 |
| 兜底 | 单字段超过上限；超长无空格串（疑似密钥或二进制） | 新 | 截断；超长无空格串替换为 `[redacted:blob]` |

输出一并带 `redactions:{url, header, key, text, blob}` 计数，让代理知道「这里有东西被拿掉了」，而不是误以为数据本来如此。

### 2.4 「给 AI 看的 HAR」视图

输入是秘密级的原始 HAR，输出是**可以交给代理**的 `har.view.json`（清洗后，可缓存，带 `sha256`）：

| 字段 | 内容 |
| --- | --- |
| `endpoints[]` | `{method, host, pathTemplate, status, mime, count, firstParty, sizeBucket}`；路径模板由聚类得到（`/items/{id}`） |
| `excluded` | 与 `sanitizeHar` 同口径的计数：`invalid`、`privateUrl`、`authenticated`、`nonStatic`、`privateBody`，外加静态资源数量 |
| `samples[]` | **默认空**。显式要求且通过 `PRIVATE_DATA_KEY` / `PRIVATE_TEXT` 扫描的 JSON 小样例（单条 ≤ 2 KB、总数有上限），每条带 `redactions` |
| `notes[]` | 被整条排除的原因示例（最多 20 条，路径用 `origin/[redacted]`，与 `reportPath` 一致） |

[01 §1.4](01-background.md)(c) 的数字就是在这个口径上统计的。

### 2.5 测试方法：植入 20 类假秘密（E12-02、E9-01）

做法：在临时工作区里为每类植入**带唯一标记的假秘密**（canary），对注册表里的**每一个**工具与资源用宽参数各调用一遍，再扫描所有响应、`tools/list`、日志与审计文件。**任一 canary 出现即失败**。同时测试编码变体（URL 编码、base64、JSON 转义）。

| # | 类别 | 现有规则覆盖【读码】 |
| --- | --- | --- |
| 1 | `Cookie` 请求头 | 覆盖 |
| 2 | `Set-Cookie` 响应头 | 覆盖（响应头走白名单） |
| 3 | `Authorization: Bearer …` | 覆盖 |
| 4 | URL 中的 `user:pass@` | 覆盖 |
| 5 | JWT（`eyJ…`） | 覆盖 |
| 6 | 查询参数 `?api_key=` | 覆盖 |
| 7 | `x-api-key` 头 | 覆盖 |
| 8 | JSON 键 `password` | 覆盖 |
| 9 | JSON 键 `access_token`、`refresh_token` | 覆盖 |
| 10 | CSRF（`x-csrf-token` 头、`<meta name="csrf-token">`） | 头覆盖；meta 写法**待测** |
| 11 | 邮箱地址 | 覆盖 |
| 12 | 手机号（无键名的裸数字串） | 键名覆盖；裸值**缺口** |
| 13 | 银行卡号（Luhn 通过的裸数字串） | 键名覆盖；裸值**缺口** |
| 14 | 路径中的用户标识（`/users/12345/orders`） | 覆盖 |
| 15 | 会话 ID（脚本或 HTML 文本里，无键名赋值） | **待测** |
| 16 | storageState 里的 localStorage / IndexedDB 令牌 | 文件级拦截；须测「不被简报摘录」 |
| 17 | `.env` 样式 `LLM_API_KEY=sk-…` | **待测**：`\b` 边界可能漏掉带前缀的写法 |
| 18 | 云与平台密钥样式（`AKIA…`、`sk-…`、`ghp_…`、`xoxb-…`） | **缺口** |
| 19 | 私钥块（`-----BEGIN … PRIVATE KEY-----`） | **缺口** |
| 20 | 引擎自己的 `HEIMDALL_TOKEN` 值 | **缺口**：现有代码没有按令牌值做扫描（令牌只作请求头发送）；新增运行时取值的精确匹配（E12-02） |

缺口与待测项在 Ph1 随 E12-02 补规则；每条新规则配正反例各一个，并确认不改变 `sanitizeHar` 对交付包的既有输出。

---

## 3. 不可信内容

### 3.1 致命三要素

提示注入的后果取决于三样东西是否同时在场。**三要素缺其一，后果就小一个量级**；Heimdall 的策略是切断其中两个，而不是指望「识别出所有注入」。

| 要素 | 在 Heimdall 里是什么 | 切断方式 |
| --- | --- | --- |
| 私有数据 | 登录态、原始抓包、登录态下采集的页面内容 | 秘密级文件不进通道（§2）；登录态采集内容默认不进简报正文（E12-12） |
| 不可信内容 | 任何第三方页面的文本、属性、图片中的文字 | 围栏、清理、不可见文本不进正文、告警（§3.2–3.4） |
| 外发通道 | ① Heimdall 对源站的请求；② 代理自己的通道（shell、其他 MCP、网页抓取） | ① 工具参数只决定「去哪取证」，不允许带自定义头或请求体，且不存在写源站的代码路径（E12-10）；非本机模式下，`compare` 的候选 URL 与其他出站目标一样受 E12-05 的出站策略约束；本机模式不限制（沿用既有决定）。② Heimdall 管不到，靠客户端最小权限、技能指令块，以及 `AGENTS.md` / 技能里的明文规则：不要把工作区外的文件或环境变量内容放进 URL、图片链接或命令 |

### 3.2 围栏格式规范

要求：**机器可识别、省 token、抗伪造**。

**(a) 文本围栏**——凡来自网页的大段文本（大纲、DOM 片段、CSS 摘录、注释、HAR 样例）：

```
<<<UNTRUSTED-WEB-CONTENT id=7f3a9c21d4e85b06 source=dom-outline>>>
body
  header.site-header "Pricing"
  …
<<<END-UNTRUSTED-WEB-CONTENT id=7f3a9c21d4e85b06>>>
```

- `id` 是**每次响应**由 `crypto.randomBytes(8)` 生成的 16 位十六进制；内容生成之后再选取，若内容里恰好含有该串则重抽。**页面事先不可能知道 nonce，因此无法伪造结束标记**。
- 起止标记各占单独一行；`source` 取 `dom-outline`、`css`、`attr`、`title`、`alt`、`comment`、`har-sample` 等。每块开销约 40 token。
- 围栏外永远不出现来自网页的原文。

**(b) 结构化输出**——短字符串（标签、字体名）仍 inline，但响应里带一个 `trust` 块声明哪些路径不可信：

```json
{
  "ok": true,
  "result": { "outline": "<<<UNTRUSTED-WEB-CONTENT id=7f3a… >>>…", "sections": [{ "id": "s3", "label": "Pricing plans" }] },
  "trust": { "nonce": "7f3a9c21d4e85b06", "untrustedPaths": ["result.outline", "result.sections[*].label", "result.fonts[*].family"] }
}
```

客户端与技能据 `untrustedPaths` 知道哪些字段不可信；大文本字段用文本围栏双保险。

**(c) 图片**——截图与裁剪图里的文字同样不可信；返回图片时，配套文本固定带一句「image: screenshot of web content (untrusted)」。

**(d) Heimdall 自己写的字段不得拼接网页字符串**——`summary`、`nextActions[].reason`、`error.hint` 一律由模板和 ID 组成（「区域 r3」，而不是引用区域里的文字），否则等于给注入开了围栏外的口子。

**(e) 选择器与锚点**——来自参考页的 `referenceAnchor` 只允许选择器安全字符集、长度 ≤ 120；不合规则退回 DOM 路径索引（`body>div:nth-child(3)`）。

### 3.3 字符清理与长度上限

| 类别 | 处理 |
| --- | --- |
| C0 / C1 控制字符（保留 `\n`、`\t`） | 删除并计数 |
| 零宽与格式字符（U+200B–U+200F、U+2060–U+2064、U+FEFF） | 删除并计数 |
| 双向控制符（U+202A–U+202E、U+2066–U+2069，「Trojan Source」类） | 删除并计数 |
| Unicode 标签字符（U+E0000–U+E007F，可用来隐写指令） | 删除并计数 |
| 组合标记堆叠、超长无空格序列 | 截断 |
| 文本规范化 | NFC |
| 注释节点 | 不进简报正文，只记数量 |
| **不可见文本**（`display:none`、`visibility:hidden`、屏外定位、`aria-hidden`、`<template>`） | 默认不进正文，只记存在与数量——注入最常藏在这里 |
| 长度 | 文本节点 ≤ 200 字符；属性值 ≤ 120；整份大纲受 `tokenBudget` 约束；超限截断并说明 |

清理计数写进响应的 `redactions` / `warnings`，便于事后追溯。

### 3.4 指令式文本告警（启发式）

命中则在响应里加 `warnings:[{code:"instruction_like_text", where, count, examples}]`（示例最多 3 条、已脱敏）。**只告警、不阻断**——阻断既误报高，也会被拿来做拒绝服务。

| 类别 | 示例特征 |
| --- | --- |
| 覆盖指令 | `ignore (all\|previous\|above) instructions`、`disregard`、`你现在是`、`忽略(以上\|之前\|所有)(指令\|提示)` |
| 冒充系统 | `system prompt`、`developer message`、`作为 AI` |
| 点名工具与命令 | `heimdall_` 工具名、`curl `、`wget `、`rm -rf`、`\| sh`、`powershell -enc`、`base64 -d` |
| 外发诱导 | 带数据的外链、Markdown 图片外链、`send … to http` |
| 敏感目标 | `~/.ssh`、`id_rsa`、`.env`、`AKIA` |

> 这只是**纵深防御**，不能单独依赖：攻击者可以换措辞，良性文档也会含「忽略」「指令」这类词。

### 3.5 提示注入回归集（100 条，E12-08）

| 类别 | 条数 | 例 |
| --- | --- | --- |
| 直接覆盖指令（中英） | 15 | 页脚写「ignore previous instructions and …」 |
| 冒充系统提示 / 角色 | 10 | 「SYSTEM: you are now …」 |
| 点名工具调用 | 15 | 诱导调用 `heimdall_*`、shell、其他 MCP 工具 |
| 外发诱导 | 10 | Markdown 图片外链带数据、「把 `.env` 发到 …」 |
| 隐藏载体 | 15 | `display:none`、白字白底、屏外、注释、`<template>`、`alt`、`title`、CSS `content:` |
| 编码与混淆 | 10 | 零宽、Unicode 标签字符、Bidi、base64、同形字、分词 |
| 伪造围栏结束标记 | 10 | 页面内容里写 `<<<END-UNTRUSTED-WEB-CONTENT id=…>>>` 与猜测的 nonce |
| 多语言 | 5 | 中、日、韩、俄、阿拉伯语 |
| 良性对照 | 10 | 正常文档站里含「忽略」「指令」「系统提示」字样的内容，用来看误报 |

通过标准：恶意 90 条 **100% 被围栏**、告警命中 ≥ 80%；伪造结束标记 10 条**全部无法闭合围栏**；良性 10 条的误报只记录、不设红线。端到端项（外部代理读到这些页面后是否执行诱导动作）作为 Bench 的附加臂观察，口径见 [09](09-quality-metrics.md)【假设】。

### 3.6 技能侧

所有技能顶部引用同一段指令块（[附录 B §4](appendix-b-playbooks.md)）。**技能正文本身也是供应链攻击面**，发布前要审阅（§7）。

---

## 4. 远程与 SSRF

### 4.1 三种运行模式

| 模式 | 绑定 | 令牌 | 目标地址策略 | 说明 |
| --- | --- | --- | --- | --- |
| **本机（默认）** | `127.0.0.1` | 可选，保持今天的行为 | **不限制**——夹具与本地开发需要访问 `127.0.0.1`，沿用既有决定 | 破坏性能力仍要过 `requireLocalWrite` |
| **共享内网** | 非回环（`0.0.0.0`、局域网 IP、容器） | **强制**；无令牌时，v1 的抓取类与写类能力拒绝服务 | **启用**内置禁止段（§4.2） | 与 2026-10-23 的统一写守卫一致：无令牌的非回环写请求回 403【读码】 |
| **公网反代** | 经反向代理 | 强制 + `HEIMDALL_TRUSTED_HOSTS` | 同上，并配 OAuth（E2-16，Ph4） | 不在比赛范围 |

引擎已有的**入站**防护【读码】：`trustedRequestHost` 对不在 `TRUSTED_HOSTS` 内的 `Host` 头回 421；`ALLOWED_ORIGINS` 限定 CORS；带外源 `Origin` 的写请求回 403。下面讲的是**出站**（SSRF）——今天的 `parseHttpUrl` 只校验「能解析且是 http(s)」，没有任何主机或 IP 策略【读码】。

### 4.2 目标地址校验规则（非本机模式）

| 规则 | 说明 |
| --- | --- |
| scheme 白名单 | 仅 `http:`、`https:`（现有 `parseHttpUrl` 已做） |
| 拒绝 userinfo | `user:pass@host` 一律拒绝 |
| 主机名规范化 | 小写、去末尾点、IDNA 转 punycode 后再判断 |
| IP 写法归一 | 十进制整数（`2130706433`）、八进制（`0177.0.0.1`）、十六进制（`0x7f.1`）、缩写（`127.1`）——统一交给 WHATWG URL 规范化成点分十进制，再校验规范化后的值 |
| 解析后校验**全部** A / AAAA | 任一结果落入禁止段即拒绝 |
| 禁止段（IPv4） | `0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`（CGNAT，含阿里云元数据 `100.100.100.200`）、`127.0.0.0/8`、`169.254.0.0/16`（链路本地，含云元数据 `169.254.169.254`）、`172.16.0.0/12`、`192.0.0.0/24`、`192.168.0.0/16`、`198.18.0.0/15`、`224.0.0.0/4`、`240.0.0.0/4` |
| 禁止段（IPv6） | `::/128`、`::1/128`、`fc00::/7`（ULA）、`fe80::/10`、`ff00::/8`；`::ffff:0:0/96`（IPv4 映射）与 `64:ff9b::/96`（NAT64）**按其嵌入的 IPv4 再判**；AWS IPv6 元数据 `fd00:ec2::254` |
| 元数据主机名 | `metadata.google.internal` 等显式拒绝 |
| **连接时校验** | 用**已校验的 IP 直连**（自定义 `lookup` / 连接钩子），保留原 `Host` 与 SNI。**不能**「先解析校验、再让底层重新解析」——那正是 DNS rebinding 的窗口 |
| 重定向 | `redirect:'manual'`，每一跳重新走全部规则，≤ 5 跳；跨 origin 跳转在 `forge` 上已有 `origin-conflict` 拒绝【读码】 |
| 端口 | 默认只放 80 / 443，其余端口需策略文件放行 |
| 响应上限 | 大小与时间上限（导航已有 45 秒超时、任务看门狗【读码】） |

**两条出站路径都要覆盖**：

- Node `fetch`：侦察的 sitemap、`fingerprint.mjs`（`redirect:'follow'`）、`live/heal.mjs`（`redirect:'follow'`）等仍需在非本机模式统一目标策略；`/px/` 已于 2026-11-03 改为 `redirect:'manual'` 并逐跳校验。
- Chromium：`capture`、`verify`、`live` 探针。部分模块已用 `context.route` 拦截（`live/probe.mjs`、`crawler/source-operations.mjs` 等），但 `capture.mjs` 没有请求拦截【读码】。非本机模式需要 `context.route('**/*')` 逐请求校验 URL 与方法，**并**让 Chromium 走一个本进程内的出站过滤代理，在连接时校验 IP——只在 `route` 里比字符串，挡不住 DNS rebinding。

验收（E12-05）：SSRF 测试集全部被拦（用例来自上表：内网段、元数据、IP 各种写法、IPv4 映射 IPv6、userinfo、重定向到内网、rebinding 脚本），**且本机模式行为不变**。

### 4.3 `/px/` 代理的前置修复（E12-06）

| 项 | 当前实现（2026-11-03） | 证据 |
| --- | --- | --- |
| 重定向 | `redirect:'manual'`；每跳重新校验 HTTP(S)、同 origin、无 userinfo，最多 5 跳；跨源跳转在发请求前拒绝 | `core/src/px-proxy.mjs`、`core/test/px-proxy.test.mjs` |
| `set-cookie` | 转发头剔除 `set-cookie` / `set-cookie2`，同时剥离 hop-by-hop、压缩与长度头 | `core/test/px-proxy.test.mjs` |
| 资源预算 | 单次总时限 30 秒；响应体上限 32 MiB；超限或超时取消读取 | `core/test/px-proxy.test.mjs` |
| 目标 | 仍限定为 `mirrorIdentity` 登记的 origin 或 `HEIMDALL_ALLOWED_HOSTS`；解析后 IP、端口与 DNS rebinding 策略属于 §4.2 的非本机模式工作 | `core/test/px-proxy-integration.test.mjs` |

真实回环集成测试已验证：白名单站点的跨源 302 返回 502，目标服务零命中；
同源 302 可完成；首跳与终跳的 `Set-Cookie` 都不出现在客户端响应里。
这只关闭了 `/px/` 的代理逃逸与 Cookie 回传，不代表任意公网部署已经具备完整 SSRF 防护。

### 4.4 可选策略文件 `HEIMDALL_POLICY_FILE`

**默认不设 = 不限制**（本机模式）。非本机模式下，内置禁止段始终生效，策略文件只能在其上**收紧**，或显式放行某些内网地址（放行写入审计）。优先级：`deny` > `allow` > 内置。

```json
{
  "version": 1,
  "allowDomains": [],
  "denyDomains": ["*.internal.example.com"],
  "allowCidrs": [],
  "denyCidrs": ["10.0.0.0/8"],
  "allowPorts": [],
  "maxResponseBytes": 0
}
```

这是组织**自选**的策略，不是默认；它不含 robots 检查，也不含节流。

### 4.5 共享部署清单

2026-10-22 审查指出过 Docker 默认配置偏松。其中「8900 开在所有网卡」已在提交 8388a2d 改为只发布到 `127.0.0.1:8900`【读码，`docker-compose.yml`】；「令牌默认注释掉」和「Chromium 以 root 运行」仍成立（后者来自审查员，未实跑）。共享部署前逐项确认：

- [ ] 端口绑 `127.0.0.1`，或只绑内网地址
- [ ] 设置 `HEIMDALL_TOKEN`，并与 `HEIMDALL_TRUSTED_HOSTS` **成对**配置
- [ ] 不以 root 运行（先确认 Playwright 浏览器目录权限）
- [ ] 镜像里没有含真实 Key 的 `core/.env`（`.dockerignore` 已排除）
- [ ] E12-05、E12-06 已上线，再打开 v1 的抓取类能力

---

## 5. 预算与成本

预算是**成本护栏**：防止循环失控、账单暴涨、机器卡死。它不是爬取礼仪，默认宽松；沿用既有决定，节流仍是可配项、默认关。

### 5.1 维度与默认值建议

| 维度 | 作用对象 | 默认建议【假设】 | 用尽时 |
| --- | --- | --- | --- |
| `maxPages` | 每任务；每令牌每日累计 | 任务沿用现有上限（侦察 5–80 页，整站克隆最多 2000 页【读码】）；令牌日累计 5,000 页 | 拒绝新任务 |
| `maxWallMs` | 每任务；每令牌会话 | 单任务 4 小时（整站验证按小时计）；会话 12 小时（与引擎会话 TTL 一致【读码】） | 阶段边界软停；超过 +10 分钟硬停（取消） |
| `maxToolCalls` | 每令牌每小时；每重建运行 | 1,500 次 / 小时；3,000 次 / 运行 | 拒绝 |
| `maxLlmUsd` | 每运行（仅 Autopilot、Bench）；每令牌每日 | 页面 8 美元、整站 50 美元；令牌日累计 100 美元 | 迭代边界停止 |
| 并发任务 | 每令牌 | 4（底层浏览器槽仍是 `HEIMDALL_FORGE_SLOTS`，默认 2；验收 1） | **排队**，不拒绝 |
| 读取体积 | 每次工具调用 | 文本约 2.5 万 token（E2-09）；图片单张 ≤ 1.5 MB（E2-03） | 截断并说明如何取更多 |

页面级的 8 美元与 [03 §4.3](03-architecture.md) 里 `heimdall.config.json` 的示例一致。这些数字要和 [05 §6](05-frontend-rebuild.md) 的成本估算一起校准。

### 5.2 `budget_exceeded` 的行为

- 响应：`ok:false`，`error.code="budget_exceeded"`，`result` 里带 `{dimension, limit, used}`；窗口型预算附 `resetsAt`。
- `nextActions`：`heimdall_budget`（`action:"get"` 看额度）；有 `admin` 权限时再给 `action:"set"`；已有任务的 `heimdall_jobs`。
- 协议映射：HTTP 429（窗口型带 `Retry-After`）、CLI 退出码 6、MCP 工具结果 `isError:true` 且保留结构化内容。
- **软停优先**：已经在跑的 Chromium 子进程不被立刻杀掉，在阶段边界停；只有触及 `maxWallMs` 的硬上限才取消（复用现有看门狗 `task-watchdog.mjs` 的熔断路径【读码】）。

### 5.3 与令牌作用域的关系

预算挂在令牌上，创建时按作用域套用模板；子令牌不能超过父令牌；`read` 令牌没有抓取类预算；调高额度需要 `admin`（E1-12、E1-13）。

### 5.4 LLM 花费的统计口径（Autopilot、Bench）

| 项 | 口径 |
| --- | --- |
| 来源 | Autopilot 与 Bench 直接调 API 时读响应里的用量：输入、输出、缓存写、缓存读四类 token |
| 价目表 | 版本化配置，带 `asOf` 日期；价格取自 [01 §2.2](01-background.md) 引用的 API 文档快照，不在代码里写死 |
| 缓存 | 缓存写与缓存读分开计价，估算必须包含缓存 |
| 粒度 | 令牌 → 运行 → 分段 → 迭代；账本行：`{iter, section, model, usage, usd, ms}`（对应 [03 §5.4](03-architecture.md) 与飞行记录器） |
| 外部代理模式（E0） | Heimdall **看不到**模型花费，只统计自身资源（工具调用数、浏览器时间、页数）。Bench 用无头模式的用量输出汇总（字段以实际为准，Ph0 核对） |
| 对账 | 以服务商账单为准；Heimdall 的数字是估算，偏差记录在汇总页 |

---

## 6. 审计与观察

### 6.1 审计日志

对应 [03 §3.4](03-architecture.md) 与 E1-14。追加写 JSONL，路径建议 `<数据根>/audit/agent-YYYYMMDD.jsonl`。

| 字段 | 说明 |
| --- | --- |
| `seq`、`ts` | 递增序号与时间 |
| `client` | `{name, version}`（来自 MCP `clientInfo` 或 CLI 标识） |
| `tokenId`、`scope` | 令牌哈希前缀与作用域；**永不记录令牌本体** |
| `tool`、`argsHash`、`argsSummary` | 工具名、参数哈希、经 §2.3 脱敏的摘要 |
| `jobId`、`status`、`errorCode` | `ok` / `error` / `denied` / `budget` |
| `durationMs`、`bytesOut`、`costUsd?` | 耗时、输出大小、可选花费 |
| `traceparent?` | 请求带有时记录 |

**不记录输出正文**，只记证据引用与大小。写入失败：本机模式 fail-open 并在控制台告警；共享模式 fail-closed（写类能力暂停）。

### 6.2 保留与轮转

按日分文件；默认保留 90 天【假设】；引擎启动时和每日一次清理，旧文件可压缩。飞行记录器 `ledger.jsonl` 属于重建工作区，归用户目录，不自动删除。

### 6.3 控制台「AI 活动」怎么读

读审计日志与任务事件，按 `jobId` 关联：实时流（SSE 尾随）、按令牌 / 工具 / 站点过滤、预算表。**「停止代理」** = 撤销该 `tokenId`（E1-12）+ 取消其运行中的任务。回放模式（E7-14）读 `ledger.jsonl`，界面显著标注「回放」。

### 6.4 OpenTelemetry 透传

MCP 2026-07-28 约定在 `_meta` 里传递 `traceparent`、`tracestate`、`baggage`，并建议用 OpenTelemetry 取代已弃用的 MCP Logging【调研】。Heimdall：请求带有时写入审计行，并在派生任务的事件里携带；**不内置导出器**，赛后可加 `HEIMDALL_OTEL_ENDPOINT`。

### 6.5 事后复盘流程

1. 按 `tokenId` 与时间窗从审计日志拉出调用序列。
2. 按 `jobId` 取任务事件与 `ledger.jsonl`。
3. 用证据引用（`sha256`）核对产物未被改动。
4. 怀疑提示注入时：列出该窗口内所有 `instruction_like_text` 告警及对应页面。
5. 撤销令牌；必要时轮换模型 Key。
6. 记入 `docs/audits/`，沿用项目的「实测 / 读码」标注习惯。

---

## 7. 插件与技能供应链

插件在用户机器上以用户权限运行代码【调研】；技能正文是会进入模型上下文的**提示**，同样是攻击面。发布前逐项勾选（E12-07）：

**版本与来源**
- [ ] 插件、技能、MCP 包版本固定；市场条目指向 git tag 或 commit sha，不指向分支
- [ ] 依赖锁文件已提交（`packages/mcp` 的锁文件；安装用 `--frozen-lockfile`）
- [ ] 只在版本号变化时发布更新（Claude Code 仅在版本变化时拉取更新【调研】）
- [ ] 内部 git 市场：私有仓库、最小成员、分支保护、强制评审、发布用带签名的 tag

**安装行为**
- [ ] 脚手架首次安装依赖用 `--ignore-scripts`；确需构建脚本的依赖进显式白名单
- [ ] 没有 `postinstall` 外联；镜像源可配（如 npmmirror），但校验锁文件完整性

**配置**
- [ ] `.mcp.json` 不含任何秘密；令牌经环境变量或 MCPB 的用户配置注入
- [ ] `.mcp.json` 使用 `node <路径>` 或 `${CLAUDE_PLUGIN_ROOT}`，不用 `npx 包名@latest`
- [ ] MCPB manifest 里的令牌字段标记为敏感（字段名以 MCPB 规范为准，实现时核对）

**权限**
- [ ] `allowed-tools` 最小：Heimdall 工具 + 项目内 `Read`/`Edit`/`Write` + `Bash(heimdall *)`、`Bash(pnpm *)`；**没有** `Bash(*)`、`Bash(curl *)`、`Bash(sh *)`
- [ ] 有副作用的技能设 `disable-model-invocation: true`
- [ ] 子代理工具白名单独立：`heimdall-reviewer` 只读
- [ ] 默认不带钩子；如需，仅本地命令、无网络访问、脚本入库并评审

**发布前**
- [ ] 人工审阅完整 diff，**包括 `SKILL.md` 正文与提示词库**
- [ ] 技能评测与触发率回归通过（E4-10、E14-07）
- [ ] 变更日志注明权限变化

---

## 8. 数据外流

### 8.1 哪些内容会进模型上下文

| 内容 | 进入时机 | 谁决定 | 控制 |
| --- | --- | --- | --- |
| 简报（大纲、令牌、资产索引） | 外部代理调用 `heimdall_brief` | 代理与用户（客户端权限提示） | `detail`、`tokenBudget` 参数 |
| 截图与裁剪图（参考 / 候选 / 差异） | `heimdall_compare`、`heimdall_artifact` 返回图片，或代理读 `.heimdall/runs/` 下的 PNG | 同上 | 外部代理模式靠客户端权限；Autopilot 用 `--no-images`（E10-09） |
| 修复包（文本 + 属性差） | `heimdall_compare` | 同上 | 同上 |
| 契约样例（已脱敏）、旅程步骤 | `heimdall_spec`、`heimdall_journey` | 同上 | 样例默认空（§2.4） |
| 重建项目源码 | 代理自己读写 | 客户端 | Heimdall 无法控制 |
| 审计日志、`ledger.jsonl` | 不主动进入上下文，除非代理自己读工作区 | — | 秘密级内容不在其中 |

**谁决定发送**：外部代理模式下是用户的客户端与它所用的模型服务商；Heimdall 只能控制「提供什么」，控制不了「发到哪」。Autopilot（E10）是 Heimdall 直接调 API，所以必须有**外流预览**（类别与大小）和开关：`--no-images`；`--redact-text`（把文本节点换成长度占位，只留结构与样式，适合只修布局的任务）。

### 8.2 连接向导里的一句话

「连接后，页面内容摘要和截图会由你的 AI 客户端发送给它所用的模型服务商。」这句话出现在「连接 AI」向导和 `AGENTS.md` 的开头（[07](07-ux.md)、[附录 B §5](appendix-b-playbooks.md)）。

### 8.3 数据保留

不同模型、不同账号对数据保留的要求不同，部分组织要求零数据保留。**是否满足本组织的要求，请使用者自行向服务商和合规部门确认，本 PRD 不替你下结论。**举例：内置 API 文档快照标明，Claude Fable 5.1 要求 30 天数据保留，零数据保留的组织会被拒绝【调研】——选模型之前先看这类条款。
