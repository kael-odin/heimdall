# 测试工作区（Test Workspace）

用 Heimdall 测**真实项目**（有没有镜像基线都行）：带登录态巡检页面、无参照物检测（无障碍/布局/内容/安全/性能/白屏）、按 PRD 写检查点、有界交互探索、跨运行视觉回归，按以往裁决自动过滤、只出该提单的问题。

配置放在**你自己的测试工作区**（项目目录），不在 Heimdall 仓库。Heimdall 只读它，绝不改写；凭据只在运行时读进内存，报告、日志、MCP 输出里只出现登录档的名字。

## 文件：`.heimdall/qa.json`

```json
{
  "schema": "heimdall.qa/1",
  "project": "显示在报告标题里的项目名",
  "sites": {
    "web": {
      "label": "官网",
      "url": "https://www.example.com/",
      "environment": "production",
      "pages": ["/", "/product", { "path": "/pricing", "name": "定价" }],
      "login": null,
      "writes": "block"
    },
    "app": {
      "url": "https://app.example.com/",
      "pages": ["/dashboard"],
      "login": "user",
      "loginPath": "/login",
      "loggedOutText": ["请登录", "登录后"],
      "writes": { "allow": [
        { "method": "POST", "origin": "https://api.example.com", "path": "/api/getList" },
        { "method": "POST", "origin": "https://app.example.com", "path": "/api/query" }
      ] }
    }
  },
  "logins": {
    "user": { "kind": "storageState", "file": ".heimdall/logins/user.json", "origin": "https://app.example.com" },
    "admin": {
      "kind": "localStorage",
      "origin": "https://admin.example.com",
      "items": { "_token": { "fromFile": "token.txt", "match": "jwt" } },
      "jwtClaims": {
        "_user_info": { "from": "_token", "pick": ["user_id", "username"] },
        "_permission": { "from": "_token", "claim": "permissions" }
      }
    }
  },
  "conventions": [
    "【】是作者的强调写法，不算格式问题",
    { "id": "policy", "text": "政策文档整页不查", "match": { "pathPrefix": "/policy" } }
  ],
  "ledger": { "file": "09-问题台账/data/issues.json" },
  "knowledge": { "prd": ["01-PRD/总纲.md"], "notes": [] },
  "defaults": {
    "viewport": { "width": 1440, "height": 900 },
    "settleMs": 1500,
    "timeoutMs": 30000,
    "detect": { "enabled": true, "thresholds": { "lcpMs": 2500, "cls": 0.1, "maxPerDetector": 4 } },
    "explore": { "maxPerPage": 6, "budgetMs": 60000 },
    "baseline": { "threshold": 0.98 }
  }
}
```

## 字段说明

### sites

| 字段 | 说明 |
| --- | --- |
| 站点名 | 只能字母、数字、`_`、`-`（`label` 可以是中文） |
| `url` | 站点入口；http(s)，不带账号密码 |
| `environment` | 报告里标注的环境（如 `production` / `test`） |
| `pages` | 要测的路径，最多 40 个，必须以 `/` 开头 |
| `login` | 引用 `logins` 里的登录档；`null` = 不登录 |
| `loginPath` | 登录页路径；登录过期判定会排除它 |
| `loggedOutText` | 页面上出现这些文字就判「登录态失效」（默认有一组常见文案） |
| `writes` | HTTP 请求策略，见下；不保证业务只读 |

**`writes`（HTTP 请求策略）**——探测默认拦下非 GET/HEAD/OPTIONS 的 HTTP 请求：

- `"block"`（默认）：全部拦下，被拦的记成「可容忍」发现；
- `"allow"`：所有 HTTP 方法全部放行，包含真正的写操作；只在明确允许修改数据的隔离测试环境中使用；
- `{ "allow": [{ "method": "POST", "origin": "https://api.example.com", "path": "/api/getList" }] }`：只放行人工确认过的 POST 查询。来源必须写协议、主机和端口；路径逐字匹配，末尾 `/` 也有区别。只允许 `POST`，不放行同路径的 `PUT`、`PATCH`、`DELETE`，也不放行其他来源、子路径或相似路径。最多配置 40 条。路径不能含查询字符串、`%` 编码或 `..` 等特殊路径段。

**旧配置迁移：** 原先的字符串前缀（例如 `"/api/get"`）现在会使工作区配置报错，不能继续运行。逐项查明实际请求的完整来源、方法和路径，确认接口没有副作用后，分别改写成上述对象；不能把一个前缀直接猜成多个接口，也不能用 `"allow"` 绕过错误。历史配置和旧运行记录不会自动改写。

例外只校验方法、来源和路径，**不限制查询参数或请求体**，也不证明接口真的只读。GET/HEAD/OPTIONS 同样可能被业务后端设计成修改数据；WebSocket 消息和其他非 HTTP 操作不受这条策略完整约束。测试前须由业务负责人确认接口语义、账号权限和环境，并准备必要的数据保护措施。请求即使最终被重定向拦截，原始请求也已到达服务器，无法撤销服务端副作用。

### logins（登录档，只声明式，不执行任意脚本）

| kind | 用途 | 写法 |
| --- | --- | --- |
| `storageState` | 有登录页、验证码、扫码的站点 | `file` 指向 Playwright storageState 文件；用 `heimdall qa login <名字>` 人工登录一次生成 |
| `localStorage` | JWT 放 localStorage 的后台 | `origin` + `items`：值可以是字面量、`{"env": "VAR"}`、`{"fromFile": "…", "match": "jwt\|line\|all", "section": "## 段落"}`；`jwtClaims` 能从 JWT 载荷直接拼出 `_user_info` / `_permission` 这类伴生键，不用抄 |
| `headers` | 请求头带令牌的 API | `headers`：`{"Authorization": {"env": "TOKEN"}}`；可选 `origin` 指定凭据接收来源 |

`fromFile` 的 `section` 先截取段落（到下一个 `##` 为止），再按 `match` 取值——一个凭据文件里放多套环境时用。已知且长度至少为 8 的凭据原文，会从运行结果、报告和 `texts.json` 中替换为 `[凭据已移除]`。这不能识别截断、编码或变形后的凭据；截图也不会自动打码。运行目录可能包含业务数据和敏感画面，分享前须人工检查。

`headers` 登录档只向指定 `origin` 发送凭据；不填时使用站点自身的来源。来源包含协议、主机和端口，必须完全一致。跳转一旦离开站点或登录来源，即使再跳回来也不会重新附加凭据。第三方嵌入页面不能借用凭据；新弹窗和部分独立进程的嵌入页面不会自动获得登录头，需要单独配置站点检查。此模式自动启动启用站点进程隔离的 Chromium；代码调用时如自行传入浏览器，也必须同时使用 `--site-per-process` 和 `--enable-automation`，否则无法验证隔离状态。隔离机制无法启用时，本次运行直接停止，不会退回全局请求头。受限的 `writes.allow` 查询只接受 Heimdall 主动创建的测试页及其可信子框架；来自弹窗、第三方嵌入页面或返回重定向的查询将被拦截。被拦截的重定向指后续请求，不代表原请求未送达。

### conventions（团队约定）

- 字符串：只进「测试须知」，提醒 agent 别报这一类；
- 带 `match` 的对象：升级成**自动过滤规则**，命中的发现直接标「团队约定」不进提单，理由就是你写的 `text`。
- `match` 语法同裁决规则：`kind` / `site` / `path` / `pathPrefix` / `text`（子串或 `/正则/`）/ `target`，至少要有一个限定条件（只按站点匹配会吞掉整个站点的发现，会被拒绝）。

### ledger（问题台账，只读）

`file` 指向已有的问题台账 JSON。Heimdall 不改写它，只用两样：

1. **查重**：提交发现前先搜台账，相似条目带着「当时怎么判的」一起返回；
2. **教训**：台账里被关闭/暂缓的条目和理由进「测试须知」——这正是人工过滤的经验。

支持形状：顶层数组，或 `{ "issues": [...] }`（如 xspark-patrol 的 `issues.json`）。条目字段：`id`、`title`、`status`（open/fixed/closed/accepted）、`tier`、`basis`、`site`、`where`、`symptom`、`close_reason`、`accepted_reason`、`reopen_if`。缺失字段优雅降级。

### knowledge / defaults / dataDir

- `knowledge`：自由对象（PRD 路径、笔记等），随 `qa status` 透传给 agent 参考；
- `defaults`：`viewport`（默认 1440×900）、`settleMs`（渲染等待，默认 1500）、`timeoutMs`（默认 30000）；下面三项控制新增的无参照物能力：
  - `detect`：`{ enabled: true, thresholds: { lcpMs, cls, maxPerDetector, tapTargetPx, mobileTapTargetPx, oversizedImageRatio, textClippedRatio } }`，`enabled: false` 或 `qa run --no-detect` 关闭静态检测；
  - `explore`：`{ maxPerPage: 6, budgetMs: 60000 }`，只有 `qa run --explore` 或本项设为 `true` 才执行交互探索；
  - `baseline`：`{ threshold: 0.98 }`，跨运行视觉回归的相似度阈值；
- `dataDir`：运行记录目录，默认 `.heimdall/qa/`（`.heimdall/.gitignore` 已忽略 `logins/` 与 `qa/runs/`）。

## 命令

```bash
heimdall qa init [--project 名称] [--url URL]   # 在当前目录建 qa.json 模板
heimdall qa login <登录档>                       # 人工登录一次，保存 storageState（要人在场，仅 CLI）
heimdall qa status                               # 站点、登录档健康、最近运行、测试须知
heimdall qa run [站点] [--pages /a,/b] [--viewports 1440,390] [--checks 检查点.json] [--no-links] [--texts] [--explore] [--no-baseline] [--no-detect]
heimdall qa baseline [--run ID] [--off]   # 登记 / 清除跨运行视觉基线
heimdall qa ci [站点] [--fail-on all|wall|degrade|none] [--require-baseline] [--github]
heimdall qa findings [--status fileable|all] [--run ID]
heimdall qa show <F编号>          # 一条发现的全部证据
heimdall qa similar "问题标题"    # 台账 + 以往运行里查相似
heimdall qa submit <文件.json>    # 提交自己测出的问题（{ "findings": [...] }）
heimdall qa verdict <F编号> <裁决> "理由" [--pattern] [--until YYYY-MM-DD] [--reopen-if 条件]
heimdall qa revoke <规则编号>     # 撤销一条裁决规则
heimdall qa rules                 # 列出已记的裁决规则
```

MCP / HTTP 同样可用：`heimdall_qa_status`、`heimdall_qa_run`、`heimdall_qa_findings`、`heimdall_qa_ci`（`qa_findings` 一个工具七个动作：list / show / similar / submit / verdict / revoke / rules）。`qa_run` 的 `checks` 参数直接收检查点数组（steps + expect，全是真实输入事件；`prd` 字段注明出处）。

完整的直连 MCP 是由 AI 客户端启动的本机进程；它可以不依赖常驻 `:8900` 引擎直接执行 QA，但仍需要测试工作区、Chromium 和目标网络。代理式 MCP 则把调用转发给引擎，需要引擎可用。升级代码后，直连 MCP 进程不会自动重新加载，须重启该 MCP 进程或 AI 客户端；仅重启引擎不能更新仍在运行的直连 MCP。代理式接入应重启引擎，并确认客户端实际连接的是新引擎。

### 声明的范围不能省略

一次最多声明 40 个页面、3 个视口和 40 个检查点；每个检查点最多 20 个步骤、20 条断言。超过上限时，请拆成多次运行，并分别保留结果；系统不会自动分批，也不会悄悄丢掉后面的条目。工作区的登录档最多包含 40 个 localStorage 项或 20 个请求头；登录提示最多 10 条，团队约定最多 200 条。JWT 映射最多 20 项，每项最多选取 30 个字段。

`--checks` / `checksFile` 可读取数组，或包含 `checks` 数组的对象。文件里的检查点可以用 `site` 限定站点；两种文件格式都会筛选当前站点。显式提供文件时，文件必须包含至少一条适用于当前站点的检查点。内联检查点与文件合计不超过 40 个，编号不能重复。

页面和 `goto` 只能写以 `/` 开头的同源路径。未知字段、步骤不使用的字段、互相冲突的断言条件、错误正则和超限配置会返回 `invalid_args`；CLI 退出码为 2，不会启动浏览器或生成一次成功的 CI 结果。原文件不会被修改。检查错误信息、修正配置后再跑。页面中的跳转和外链另受运行时请求策略约束，上述路径校验不等于出口隔离。

### 检查列表中的每一项

文本断言默认只检查选择器的第一项。需要检查表格当前已渲染的每一行时，可对 `text` 显式设置 `scope: "all-visible"`，并且只指定一个 `equals`、`contains` 或 `matches`。例如，下列选择器和就绪标记必须按被测网站实际页面修改：

```json
{
  "title": "列表日期格式",
  "path": "/orders",
  "steps": [{ "action": "waitFor", "selector": "[data-test=orders-ready]" }],
  "expect": [{
    "kind": "text",
    "selector": "tbody tr td.date",
    "scope": "all-visible",
    "minMatches": 1,
    "matches": "^\\d{4}-\\d{2}-\\d{2}$"
  }],
  "prd": "填写日期展示要求的真实来源"
}
```

`waitFor` 默认等第一项变为可见；设置 `state: "hidden"` 时等第一项隐藏或消失，超时则标记检查未完成。就绪标记应由业务页面可靠地提供：等待一个从未出现的加载提示消失，不能证明数据加载完毕。`minMatches` 是可见匹配项的最小数量，默认为 1；没有匹配项或未达到数量时，检查未完成，CI 不会通过。单次最多检查 1000 项，每项文本最多 4000 字；超过上限也会标记未完成。所有正则断言都在独立工作线程中执行，3 秒内未结束时中止并标记未完成，不将其当成产品缺陷。

默认首项的文本或属性断言找不到目标时，也会标记未核实；不能用匹配空字符串或包含空字符串让缺失目标通过。这与显式检查元素隐藏、或明确断言数量为零不同。首项文本在 4000 字以内完整比较；超过上限标记未完成，不截断后判断。页面中的可见数据仍须结合业务接口和加载状态判断，HTTP 200 本身不证明业务成功。

显式检查 `hidden` 时，元素不存在可以视为隐藏；但选择器无效或浏览器读取出错时，检查会标记未完成，不会当成隐藏。`visible` 读取出错同样不会通过。

检查点首页或 `goto` 返回 HTTP 错误时，不会对错误页继续断言；有配置登录档且页面明确出现登录失效证据时，优先标为登录失效，否则标为检查点执行出错。这些情况都需要排查后重跑，不能当成业务检查通过。

报告记录匹配数量、不符合数量和最多三个异常示例。可见性采用 Playwright 的可见元素判定，用于排除隐藏测量行；它不代表元素一定在滚动视口内，也不能证明列表数据完整。分页、虚拟滚动中未渲染的数据以及其他页面不会自动检查；需要按业务规则确认加载完成，并对各页分别执行检查。即使本页检查通过，也不能据此断言整个列表没有问题。

## 无参照物检测（默认开启）

没有参照站也能看出的问题：页面能跑，但看起来或读起来不对。每次 `qa run` 会在每个页面、每个视口执行一组页面内检测，结果进入同一个发现流（同样的指纹、裁决、证据门槛与报告）：

| 类别 | 检测内容 |
| --- | --- |
| 无障碍 `a11y` | 图片缺少 `alt`、控件没有可访问名称、表单控件没有标签、重复 `id`、缺少或多于一个 `h1`、标题层级跳跃、缺少 `lang`、`iframe` 缺少 `title`、正向 `tabindex` |
| 布局 `layout` | 文字被裁切（省略号/容器截断且露出不足 70%）、图片被拉伸变形、点击目标小于 24px（移动端 44px） |
| 内容 `content` | `TODO`/`lorem ipsum`/`undefined`/`NaN` 等占位或调试文案、`{{变量}}` 未替换、乱码、`Invalid Date`/`NaN`/`1970-01-01` |
| 安全 `security` | https 页面加载 http 资源、`target="_blank"` 缺 `noopener`、表单提交到 http、页面 HTML 里的疑似密钥（只记录截断值） |
| 性能 `perf` | LCP > 2.5s、CLS > 0.1、图片分辨率远大于显示尺寸（≥ 2 倍） |
| 可用性 `blank` | 页面几乎没有可见内容（疑似白屏） |

每条发现都带 `target`（选择器或资源地址）、`observed`（实测值）与 `repro`（复现步骤），并按证据门槛分级：能进提单清单的（如缺少 `alt`、文字裁切）默认 `degrade` 且写明损失；只能提示的（如重复 `id`、点击目标偏小）进「可容忍」。

按钮、链接、标签页和菜单项优先用 Playwright 的无障碍名称计算，包含有名称的图标与被引用的标签；读取失败时退回原有启发式。读屏专用的隐藏文字不会按视觉裁切提单。完整文字出现在原生 `title` 提示中，或表头旁存在相应的横向滚动表格时，裁切只作为待复核提示：触屏、键盘与表头同步仍需人工确认。以上规则仍不能替代完整无障碍审计。

阈值在 `defaults.detect.thresholds` 里调整；某个站点噪声太大时，可以 `qa run --no-detect` 关闭，或像处理其它问题一样用 `qa verdict ... false-positive --pattern` 过滤一类误报。它不替代人工验收：启发式检测有误报，结论仍要结合截图和页面复核。

## 交互探索（默认关闭，需显式开启）

静态检测看不出「点了会怎样」。`qa run --explore` 会在每个页面点有限个控件，用点击前后可观察的变化判断三类问题：

- **点击无反应**：地址、标题、正文、可见元素数、页面高度、弹层与展开状态都没有变化；
- **点击触发异常**：点击后新增页面异常；
- **点击后请求失败**：点击后新增 4xx/5xx。

安全默认：只点 `button` / `a[href]` / `summary` / `role=button|tab|menuitem|switch|checkbox`；跳过删除、退出、支付等破坏性文案、表单提交、站外链接、下载、`mailto`/`tel`/`javascript:`；HTTP 请求按站点的 `writes` 策略处理。文案过滤和 HTTP 方法不能保证点击没有副作用；必须结合业务语义和账号权限判断。每页默认最多 6 个控件、整轮 60 秒预算，超出会如实写进覆盖范围（`coverage.explore`）。

探索会改变页面状态，所以**默认关闭**；对正式环境建议先在测试环境跑，或把 `defaults.explore.maxPerPage` 调小。

## 跨运行视觉回归

把一次运行登记为基线，之后每次 `qa run` 都会把同一站点、同一页面、同一视口的截图与基线比对，低于阈值就生成一条 `regression` 发现，附基线截图、本次截图与差异图：

```bash
heimdall qa baseline              # 把最近一次运行登记为基线
heimdall qa baseline --run qa-20261101-101500-abcd
heimdall qa baseline --off        # 清除基线
```

只有同一站点、同一环境、同一来源、同一页面和同一视口才比对。环境按配置中的标签核对，来源按站点配置 URL 的协议、主机和端口核对；这不证明重定向后的页面或业务数据来源相同。比对范围只包含本次请求的页面和视口；没有登记过的新页面不算回归，但报告会写明未比对。不同站点的基线不适用于当前站点；同名站点的环境或来源变更则标为未完成。动态内容（广告、时间、随机图）会拉低相似度，报告会给出相似度与差异图，须由人裁决。

没有登记基线、使用 `qa baseline --off` 清除基线、或在本次运行使用 `--no-baseline` 时，普通 QA 仍可运行，报告会明确说明没有做视觉比对。此时即使 `qa ci` 通过，也不代表视觉回归已通过。旧版 `--off` 可能留下空的 `baseline.json`；空文件也可能是损坏，因此现在标为不可用。如果确认要清除，重新执行 `qa baseline --off`；如果需要比对，重新登记完整基线。

需要视觉回归作为 CI 必过项时，用 `heimdall qa ci 站点 --require-baseline`，或调用 MCP 时传入 `requireBaseline: true`。这会要求本次每个页面和视口都有已登记基线且比较成功；基线文件被删除、新页面未登记、站点不匹配或证据缺失时均返回未完成。不能同时使用 `--no-baseline`。不启用这个选项时，文件缺失与从未登记无法区分，普通 QA 可能通过，但报告会写明未做视觉比较。

`--require-baseline` 只要求比较覆盖完整，不会修改问题裁决或失败门槛。比较发现外观差异后，是否让 CI 失败仍取决于 `--fail-on`、`--max-findings` 和已有裁决；`--fail-on none` 不会因外观差异而失败。

基线只引用运行目录里的截图。基线文件损坏、同页截图丢失或无法读取、本次截图缺失，或无法确认旧基线的原始来源时，报告会标记视觉比对未完成。`qa ci` 即使用 `--fail-on none` 也会返回 `qa_incomplete` 和退出码 3，不把证据问题当成产品缺陷。旧基线会从原运行的 `run.json` 读取来源；请保留该文件和截图，或者重新登记完整基线。

配置登录档后，若落到配置的登录路径或其下级形式（例如 `/login` 与 `/user/login`），或命中声明的退出登录提示，运行会标记登录失效。登录页截图保留供排查，但不参加业务页面回归，不执行该页的检查点或探索。只要任一页面登录失效、打不开，或截图缺失或损坏，本次运行就不能覆盖基线；原基线会保留。登录态是否仍有权限访问全部业务数据，仍需结合接口和页面内容确认。

若页面打不开或页面检测器执行失败，报告会列出对应页面和视口，而不是当成没有发现；即使使用 `--fail-on none`，`qa ci` 也返回未完成，排查后再跑。

浏览器报告资源被客户端拦截时，报告将它列为环境问题，不直接认定站点资源故障。相关坏图和重复的资源加载控制台消息不会另算产品问题；其他网络失败和脚本异常仍会保留。由于缺失资源会影响检查，即使使用 `--fail-on none`，`qa ci` 也会返回未完成；检查本机、浏览器和代理策略后重跑。

## CI 门禁

`heimdall qa ci` 复用同一套 QA 运行，但会额外写 `qa-ci.json` / `qa-ci.md`，输出 GitHub Actions 注解，并按 `--fail-on` 返回稳定退出码。它适合定时巡检和发布前门禁，不替代人工验收。模板见 [QA CI 指南](guide/07-qa-ci.md)。

检测到登录失效，或检查点执行出错、未能核实时，CI 状态为 `incomplete`，退出码为 `3`；即使指定 `--fail-on none` 也不会显示通过。这表示测试未完成，不是将登录或检查点配置问题当作产品缺陷。



分级照搬人工分诊：证据层级（basis）决定最高分级——`failed` 实测失败、`wrong` 结果错误、`promise` 与承诺/PRD 不符、`friction` 能用但费劲、`cosmetic` 措辞/视觉小瑕疵（最高只能可容忍）。撞墙/受损必须写 `loss`（谁、做什么、损失了什么）；`loss` 里出现「可能/疑似/或许」这类推测词会被拒收。agent 提交的发现必须有证据（observed / steps / screenshot 至少一项）。

每条发现带**指纹**（站点 + 路径 + 检查种类 + 定位 + 规范化文字；数字、哈希、查询参数不参与）——同一个问题下次出现指纹一样，人做过的裁决自动套上：

- `verdict F2 by-design "getStatic* 是查询接口" --pattern` → 一类问题（同 kind + 文字）以后自动过滤；
- `verdict F3 deferred "下版本修" --until 2026-12-01` → 到期自动重开；
- `--reopen-if "上线新定价页"` → 条件写明后重报；
- 报告里「按以往裁决过滤掉的」每条都能追溯到规则编号，觉得规则不对就 `revoke`。

## 报告

每次运行写在 `.heimdall/qa/runs/<runId>/`：

- `report.md`——全量：建议提单、**无参照物检测汇总**（按无障碍/布局/内容/安全/性能/可用性分组）、已知仍在、按裁决过滤的（附理由）、可容忍、环境问题（登录过期等）、交互探索覆盖、跨运行回归、检查点没对上的、覆盖范围表；
- `bugs.md`——**只含该提单的**：撞墙/受损、没被以往裁决过滤、证据是实测的。可直接贴给开发；
- `findings.json` / `run.json` / `shots/` 截图；`--texts` 时另存 `texts.json`（各页可见文字，供设计稿文案对照用）。

## 真实工作区示例（Xspark）

可公开、已脱敏的真实运行记录见 [Xspark 公开案例](cases/xspark/2026-11-04/README.md)。

```
Xspark接手测试/
├─ .heimdall/
│  ├─ qa.json              # 站点：web（官网 5 页）/ dashboard / admin
│  ├─ logins/              # storageState（dashboard-user，人工登录生成；不入库）
│  └─ qa/runs/             # 运行记录
├─ token_admin_prod.txt    # admin 登录档 fromFile 引用（仅文件名）
└─ 09-全局问题总报告/data/issues.json   # ledger.file 指向的台账（54 条，含 close/accepted 理由）
```

要点：admin 后台 JWT 注入 localStorage 用 `jwtClaims` 从 token 拼出 `_user_info`/`_permission`，不用手抄；读语义 POST 必须逐条配置准确的 `method`、`origin` 和 `path`，并先确认业务语义。
