# 测试工作区（Test Workspace）

用 Heimdall 测**真实项目**（有没有镜像基线都行）：带登录态巡检页面、按 PRD 写检查点、按以往裁决自动过滤、只出该提单的问题。

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
  "defaults": { "viewport": { "width": 1440, "height": 900 }, "settleMs": 1500, "timeoutMs": 30000 }
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
- `defaults`：`viewport`（默认 1440×900）、`settleMs`（渲染等待，默认 1500）、`timeoutMs`（默认 30000）；
- `dataDir`：运行记录目录，默认 `.heimdall/qa/`（`.heimdall/.gitignore` 已忽略 `logins/` 与 `qa/runs/`）。

## 命令

```bash
heimdall qa init [--project 名称] [--url URL]   # 在当前目录建 qa.json 模板
heimdall qa login <登录档>                       # 人工登录一次，保存 storageState（要人在场，仅 CLI）
heimdall qa status                               # 站点、登录档健康、最近运行、测试须知
heimdall qa run [站点] [--pages /a,/b] [--viewports 1440,390] [--checks 检查点.json] [--no-links] [--texts]
heimdall qa findings [--status fileable|all] [--run ID]
heimdall qa show <F编号>          # 一条发现的全部证据
heimdall qa similar "问题标题"    # 台账 + 以往运行里查相似
heimdall qa submit <文件.json>    # 提交自己测出的问题（{ "findings": [...] }）
heimdall qa verdict <F编号> <裁决> "理由" [--pattern] [--until YYYY-MM-DD] [--reopen-if 条件]
heimdall qa revoke <规则编号>     # 撤销一条裁决规则
heimdall qa rules                 # 列出已记的裁决规则
```

MCP / HTTP 同样可用：`heimdall_qa_status`、`heimdall_qa_run`、`heimdall_qa_findings`（一个工具七个动作：list / show / similar / submit / verdict / revoke / rules）。`qa_run` 的 `checks` 参数直接收检查点数组（steps + expect，全是真实输入事件；`prd` 字段注明出处）。

## 证据门槛与裁决记忆

分级照搬人工分诊：证据层级（basis）决定最高分级——`failed` 实测失败、`wrong` 结果错误、`promise` 与承诺/PRD 不符、`friction` 能用但费劲、`cosmetic` 措辞/视觉小瑕疵（最高只能可容忍）。撞墙/受损必须写 `loss`（谁、做什么、损失了什么）；`loss` 里出现「可能/疑似/或许」这类推测词会被拒收。agent 提交的发现必须有证据（observed / steps / screenshot 至少一项）。

每条发现带**指纹**（站点 + 路径 + 检查种类 + 定位 + 规范化文字；数字、哈希、查询参数不参与）——同一个问题下次出现指纹一样，人做过的裁决自动套上：

- `verdict F2 by-design "getStatic* 是查询接口" --pattern` → 一类问题（同 kind + 文字）以后自动过滤；
- `verdict F3 deferred "下版本修" --until 2026-12-01` → 到期自动重开；
- `--reopen-if "上线新定价页"` → 条件写明后重报；
- 报告里「按以往裁决过滤掉的」每条都能追溯到规则编号，觉得规则不对就 `revoke`。

## 报告

每次运行写在 `.heimdall/qa/runs/<runId>/`：

- `report.md`——全量：建议提单、已知仍在、按裁决过滤的（附理由）、可容忍、环境问题（登录过期等）、检查点没对上的、覆盖范围表；
- `bugs.md`——**只含该提单的**：撞墙/受损、没被以往裁决过滤、证据是实测的。可直接贴给开发；
- `findings.json` / `run.json` / `shots/` 截图；`--texts` 时另存 `texts.json`（各页可见文字，供设计稿文案对照用）。

## 真实工作区示例（Xspark）

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
