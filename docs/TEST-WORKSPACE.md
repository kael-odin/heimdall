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
      "writes": { "allow": ["/api/getList", "/api/query"] }
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
| `writes` | 只读探测的写请求策略，见下 |

**`writes`（写请求策略）**——探测默认拦下所有 POST/PUT/PATCH/DELETE，保护正式环境：

- `"block"`（默认）：全部拦下，被拦的记成「可容忍」发现；
- `"allow"`：全部放行（只建议对测试环境用）；
- `{ "allow": ["/api/getList", …] }`：**路径前缀白名单**。国内后端普遍用 POST 传查询参数（`/api/web_package/getStaticPackageList` 这类「读语义 POST」），全拦会让页面残掉、报告全是噪声——把这些前缀放进来，页面正常渲染，探测照样拦住真正的写操作。前缀按 pathname 匹配：`/api/get` 同时放行 `/api/getList` 和 `/api/get/xxx`。

### logins（登录档，只声明式，不执行任意脚本）

| kind | 用途 | 写法 |
| --- | --- | --- |
| `storageState` | 有登录页、验证码、扫码的站点 | `file` 指向 Playwright storageState 文件；用 `heimdall qa login <名字>` 人工登录一次生成 |
| `localStorage` | JWT 放 localStorage 的后台 | `origin` + `items`：值可以是字面量、`{"env": "VAR"}`、`{"fromFile": "…", "match": "jwt\|line\|all", "section": "## 段落"}`；`jwtClaims` 能从 JWT 载荷直接拼出 `_user_info` / `_permission` 这类伴生键，不用抄 |
| `headers` | 请求头带令牌的 API | `headers`：`{"Authorization": {"env": "TOKEN"}}` |

`fromFile` 的 `section` 先截取段落（到下一个 `##` 为止），再按 `match` 取值——一个凭据文件里放多套环境时用。所有值只在运行时进内存，报告落盘前会替换成 `[凭据已移除]`。

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
heimdall qa ci [站点] [--fail-on all|wall|degrade|none] [--github]
heimdall qa findings [--status fileable|all] [--run ID]
heimdall qa show <F编号>          # 一条发现的全部证据
heimdall qa similar "问题标题"    # 台账 + 以往运行里查相似
heimdall qa submit <文件.json>    # 提交自己测出的问题（{ "findings": [...] }）
heimdall qa verdict <F编号> <裁决> "理由" [--pattern] [--until YYYY-MM-DD] [--reopen-if 条件]
heimdall qa revoke <规则编号>     # 撤销一条裁决规则
heimdall qa rules                 # 列出已记的裁决规则
```

MCP / HTTP 同样可用：`heimdall_qa_status`、`heimdall_qa_run`、`heimdall_qa_findings`（一个工具七个动作：list / show / similar / submit / verdict / revoke / rules）。`qa_run` 的 `checks` 参数直接收检查点数组（steps + expect，全是真实输入事件；`prd` 字段注明出处）。

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

阈值在 `defaults.detect.thresholds` 里调整；某个站点噪声太大时，可以 `qa run --no-detect` 关闭，或像处理其它问题一样用 `qa verdict ... false-positive --pattern` 过滤一类误报。它不替代人工验收：启发式检测有误报，结论仍要结合截图和页面复核。

## 交互探索（默认关闭，需显式开启）

静态检测看不出「点了会怎样」。`qa run --explore` 会在每个页面点有限个控件，用点击前后可观察的变化判断三类问题：

- **点击无反应**：地址、标题、正文、可见元素数、页面高度、弹层与展开状态都没有变化；
- **点击触发异常**：点击后新增页面异常；
- **点击后请求失败**：点击后新增 4xx/5xx。

安全默认：只点 `button` / `a[href]` / `summary` / `role=button|tab|menuitem|switch|checkbox`；跳过删除、退出、支付等破坏性文案、表单提交、站外链接、下载、`mailto`/`tel`/`javascript:`；写请求仍按站点的 `writes` 只读策略拦截，点击不会真的下单或删除。每页默认最多 6 个控件、整轮 60 秒预算，超出会如实写进覆盖范围（`coverage.explore`）。

探索会改变页面状态，所以**默认关闭**；对正式环境建议先在测试环境跑，或把 `defaults.explore.maxPerPage` 调小。

## 跨运行视觉回归

把一次运行登记为基线，之后每次 `qa run` 都会把同一站点、同一页面、同一视口的截图与基线比对，低于阈值就生成一条 `regression` 发现，附基线截图、本次截图与差异图：

```bash
heimdall qa baseline              # 把最近一次运行登记为基线
heimdall qa baseline --run qa-20261101-101500-abcd
heimdall qa baseline --off        # 清除基线
```

只有同一站点、同一页面、同一视口才比对；新增页面不算回归。动态内容（广告、时间、随机图）会拉低相似度，报告里会给出相似度与差异图，由人裁决；`qa run --no-baseline` 可跳过比对。基线只引用运行目录里的截图，运行目录被清理后会明确报「基线截图缺失」，不会静默通过。

## CI 门禁

`heimdall qa ci` 复用同一套 QA 运行，但会额外写 `qa-ci.json` / `qa-ci.md`，输出 GitHub Actions 注解，并按 `--fail-on` 返回稳定退出码。它适合定时巡检和发布前门禁，不替代人工验收。模板见 [QA CI 指南](guide/07-qa-ci.md)。



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

要点：admin 后台 JWT 注入 localStorage 用 `jwtClaims` 从 token 拼出 `_user_info`/`_permission`，不用手抄；官网定价页配了 `writes: { "allow": ["/api/web_package/getStatic"] }`，读语义 POST 放行、写请求照拦。
