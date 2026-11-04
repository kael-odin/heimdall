# 09 · 小白一站式启动、演示与 AI 接入

> 更新：2026-11-04。目标不是把所有内部术语背下来，而是用最短路径看见 Heimdall 到底能做什么，并让 Codex / Claude 真正调用它。

## 先回答三个最容易混的问题

### 1. 本机已经有依赖时，启动是不是只要双击 `clone-heimdall.cmd`？

是。这个脚本会同时启动：

- 引擎：`http://127.0.0.1:8900`
- 控制台：`http://127.0.0.1:5173`
- 健康检查通过后，自动打开浏览器

所以“看界面 + 手动点击演示 + 同时给 Claude Code 当本地引擎”这一套，双击它就够了。

### 2. 不打开 `:5173`，能不能只用 MCP？

能，但分客户端：

| 入口 | 本机现状 | 不打开控制台时怎么工作 |
| --- | --- | --- |
| Codex App | 已配置完整 MCP，15 个工具 | 读类和 QA/SEO 类工具可直接用；克隆类任务可在需要时启动临时引擎 |
| Claude Desktop | 已配置完整 MCP，15 个工具 | 同上 |
| Claude Code | 已安装 `heimdall@heimdall` 0.2.2 插件 | 插件是轻量代理，除 `doctor/overview` 外依赖 `:8900` 引擎 |

最稳的演示方式仍是先双击 `clone-heimdall.cmd`。MCP 服务由客户端自己拉起，不需要再手工启动一个 MCP 进程。

### 3. “MCP 已安装”是否等于“完全不用本地服务”？

不等于。MCP 是 AI 和应用说话的插头；Heimdall 的浏览器采集、克隆和大多数 QA 仍要本机执行器。Claude Code 插件尤其明确依赖 `:8900`。看到 `engine_unreachable` 时，先启动引擎，不要怀疑模型。

## 五分钟验收本机

### 第一步：看 UI

1. 双击根目录 `clone-heimdall.cmd`。
2. 等浏览器自动打开 `http://127.0.0.1:5173`。
3. 页面正常出现星图、页面、项目验收、任务、报告、设置，就说明引擎和控制台都起来了。

### 第二步：让 AI 自报环境

在 Codex 或 Claude 里说：

```text
调用 heimdall_doctor，告诉我引擎、Chromium、数据目录现在是否可用。
只报实测结果，不要猜。
```

再让它列工具：

```text
列出你当前能看到的 Heimdall 工具数量，并确认有没有 heimdall_qa_ci。
```

当前应为 **15 个工具**，其中 QA 工具 4 个：

- `heimdall_qa_status`
- `heimdall_qa_run`
- `heimdall_qa_findings`
- `heimdall_qa_ci`

## 安全演示路线

不要第一次就拿正式生产后台做全流程。按下面顺序演示，风险最小、可重复性最好。

### 演示 A：克隆、量差异、看报告

先开一个完全本地的靶子页面，另开 PowerShell：

```powershell
node core/test/fixtures/bench/f1/server.mjs --port 5090
```

然后在控制台 `http://127.0.0.1:5173`：

1. 在顶部输入 `http://127.0.0.1:5090/`。
2. 先“侦察”，再“只克隆此页”。
3. 去“页面”看镜像、分数和资产缺口。
4. 去“报告”打开克隆档案、截图对比和验证结果。
5. 在“项目验收”里理解 Mirror / Regression 的证据链。

这一条演示的是：**资产是真抓的，差异是真量出来的，报告不是模型编的。**

### 演示 B：无参照物 QA

项目里需要一个 `.heimdall/qa.json`。最保险是先用本地 F1 或公开授权页面建一个测试工作区：

```powershell
node core/src/cli.mjs qa init --url http://127.0.0.1:5090/
node core/src/cli.mjs qa run web --viewports 1440,390
```

看 `.heimdall/qa/runs/<runId>/` 里的：

- `report.md`：全部发现、环境问题和被过滤项
- `bugs.md`：只列建议提单的问题
- `shots/`：逐页逐视口截图

再加 CI 门禁：

```powershell
node core/src/cli.mjs qa ci web --viewports 1440,390 --fail-on all --github
```

它会额外生成 `qa-ci.json`、`qa-ci.md` 和 GitHub Actions 注解。这里的“通过”只代表本次声明页面、视口和门槛通过。

### 演示 C：SEO 和站点变化

只用公开或授权页面：

```powershell
node core/src/cli.mjs seo-audit https://example.org/ --max-pages 5
node core/src/cli.mjs seo-matrix https://example.org/ https://www.iana.org/
node core/src/cli.mjs site-watch https://example.org/
```

它们分别回答：

- 这个站点自身有哪些 SEO 问题
- 两个站点哪些指标能横向比较
- 站点这次和上次相比哪里变了

### 演示 D：让 AI 真正干活

让代理克隆和解释：

```text
调用 heimdall_clone，把 http://127.0.0.1:5090/ 克隆成单页镜像。
完成后调用 heimdall_brief，detail=sections，按首屏、内容区、页脚列出重建计划。
不要外链，不要修改门禁。
```

让代理跑 QA：

```text
先调用 heimdall_qa_status，读测试须知和团队约定。
再调用 heimdall_qa_run，站点 web，视口 1440 和 390。
只把达到提单门槛的问题列出来，环境问题单列，不要猜产品 BUG。
```

让代理跑 CI 门禁：

```text
调用 heimdall_qa_ci，站点 web，视口 1440 和 390，failOn=all。
汇报 qa-ci.json、qa-ci.md、达到门槛的发现和所有未测范围。
```

## 全部能力怎么分

Heimdall 现在不是一个按钮，而是四条使用路径：

| 路径 | 适合谁 | 入口 |
| --- | --- | --- |
| 控制台 | 想看星图、进度、截图和报告的人 | 双击 `clone-heimdall.cmd` |
| CLI | 想一条命令跑完整流程或接脚本的人 | `node core/src/cli.mjs ...` |
| MCP | 想让 Codex / Claude 调用取证、QA、SEO 的人 | 客户端里的 `heimdall_*` 工具 |
| GitHub Action | 想给别的项目加自动 QA 门禁的人 | `actions/qa-ci` |

完整参数不用背，先看：

```powershell
node core/src/cli.mjs --help
node core/src/cli.mjs --help --json
```

## 最容易踩的坑

- **只看到离线 doctor**：引擎没起，或者客户端用的还是 Claude Code 轻量插件。
- **浏览器能开但 MCP 调不动**：检查 `:8900/api/status`，不是检查 `:5173`。
- **QA 显示“检查点待修”**：通常是选择器写错，不是产品 BUG。先改检查点。
- **生产页面偶发网络失败**：单独标成环境问题，不要混进产品缺陷。
- **演示前临时 `pnpm install`**：最不该做的事。提前装好、构建好，现场只跑已经彩排过的路径。
- **把 `pass-candidate` 说成正式通过**：快速对比只是候选，正式结论只由正式门禁给出。

## 最短结论

你现在的本机环境已经可以：

1. 双击 `clone-heimdall.cmd` 进入完整控制台。
2. 在 Codex / Claude Desktop / Claude Code 里看到 15 个 Heimdall MCP 工具。
3. 用一份本地 F1 夹具演示克隆、QA、CI 和 AI 调用。
4. 用 Xspark 公开案例演示真实授权站点的 QA + SEO 证据。

这只是“能演示、能认真试用”的成熟度，不是“任意网站开箱即用”的成熟度。下一步最值钱的是真实授权项目泛化、统一安装体验和减少工具/文档维护面。
