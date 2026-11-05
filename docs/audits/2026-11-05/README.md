# 2026-11-05 · 一键安装、doctor 与 AI 接入收口

> 大白话结论：双击启动现在真的是“第一次装、以后复用”，不再要求小白先分别安装
> `core` / `console` / MCP 依赖。日常入口统一为 `http://127.0.0.1:8900`；
> `:5173` 只保留给前端开发。MCP 已安装仍不等于不用本机引擎。

## 本轮解决的问题

### 1. 全新机器无法先跑安装器

原 CLI 在分派命令前会加载完整能力注册表，其中 `compare` / QA 的静态依赖会导入
Playwright 等第三方包。`node_modules` 不存在时，连 `setup` 和 `doctor` 都起不来。

处理：

- 参数解析拆为 `core/src/agent/parse-args.mjs`，仅依赖 Node 内建；
- `core/src/cli.mjs` 在导入能力注册表之前分派 `setup` 和轻量 `doctor`；
- `doctor` 改为动态加载 Playwright，依赖缺失时返回可执行诊断，不使 CLI 崩溃。

### 2. 没有统一安装与启动入口

新增 `heimdall setup`：

- 检查 Node `>= 22.13` 与 pnpm；
- 只安装缺失的 `core` / `console` / `packages/mcp` 依赖；
- 缺 Chromium 才安装；
- 控制台源码变化才重建；
- 构建自包含 MCP 插件入口；
- 复用或启动 `:8900` 单端口引擎；
- 打开浏览器；
- 配置并自测 Claude Code 插件 / Claude Desktop / Codex，Cursor / VS Code 显式选择。

`clone-heimdall.cmd` 改为调用同一个安装器，但固定传 `--no-connect`，避免每次打开 UI
都改客户端配置。启动器保持纯 ASCII，并在失败时停住窗口让用户读到错误。

### 3. `doctor` 看不到安装问题

原有 9 项检查只有 Chromium 和引擎，依赖、控制台、MCP、客户端都不在体检范围。

现在 13 项，新增：

- `dependencies`
- `console`
- `mcp`
- `clients`

`doctor --fix` 和 `setup --no-connect --no-open` 共用同一安全修复实现。修复后会重新
执行真实检查，不用安装命令的退出码冒充结果。

### 4. `connect` 写入与自测不是同一份环境

原测试进程继承当前 shell 的 `HEIMDALL_API`，但配置文件里写的可能是另一个值。

处理：

- 新增 `serverLaunch()` / `selfTestEnv()`，配置和自测从同一份 API / command / args 派生；
- JSON 客户端、VS Code 与 Codex TOML 都写入明确 `HEIMDALL_API`；
- 已有配置改前仍备份，写入后自测失败会还原；
- `--dry-run` 不启动 MCP；
- 能识别 Claude Code 版本化插件，不额外写一份重复直连配置。

## 本机真实结果

2026-11-05 Windows 本机：

```text
setup --json
  stdout_lines = 1
  baseUrl = http://127.0.0.1:8900
  engine = reused（第二次运行）
  steps = 9

launcher
  clone-heimdall.cmd exit 0
  http://127.0.0.1:8900/ = HTTP 200
  http://127.0.0.1:8900/api/status = HTTP 200
  console route guard = 37 / 37 API paths served

doctor
  Node 26.12.1
  pnpm 11.28.10
  core / console / MCP 的 13 个直接依赖可解析
  Playwright Chromium 已安装
  控制台 dist 已就绪
  MCP 源入口与插件单文件都在
  引擎在 http://127.0.0.1:8900
  Claude Code 插件 0.2.2、Claude Desktop、Codex 已配置

connect
  Claude Desktop：15 个工具，engine ok
  Codex：15 个工具，engine ok
```

## 本地门禁

`pnpm check` 全部通过：

```text
core fast: 1,210 / 1,210 passed
MCP: 3 / 3 passed
lint: 718 files OK
Markdown links: 701 targets / 141 files OK
frozen verifier: 14 files OK
dependency audit: no known vulnerabilities
D7 real browser acceptance: accepted:true
```

新增专项：

- setup 依赖缺失只安装对应目录；
- setup 全组件健康时幂等复用；
- console stale / missing 判定；
- MCP artifact 缺失判定；
- 占用端口不是 Heimdall 时拒绝；
- Claude Code 插件优先于重复直连；
- `setup --json` 只输出一个最终信封；
- connect 配置与自测使用同一个 `HEIMDALL_API`；
- doctor 轻量入口在注册表之前可运行。

## 仍未解决

1. 还没有在真正空的 Windows 机器和空 Linux runner 上跑“从零安装”；
   本轮验证的是当前机器上的缺失模拟与完整幂等路径。
2. 已有同数据根引擎若没加载控制台，`setup` 会拒绝让用户先停旧引擎，不会擅自杀进程。
3. npm 镜像可配；Playwright 浏览器镜像仍沿用官方
   `PLAYWRIGHT_DOWNLOAD_HOST`，尚未做独立参数与 UI 提示。
4. 客户端配置仍指向当前工作树绝对路径。发布不可变版本 / MCPB 后，才适合长期分发。
5. Xspark 的真实价值仍在授权测试环境和只读登录页回放，不在继续增加 MCP 工具。
