# 06 · 接入 AI 与 A-3 手测

> 目标：把 Heimdall 接到 Claude Code / Claude Desktop，证明「一个代理能读简报、写代码、拿修复包」这条竖线在真实客户端里成立。
>
> 这是 PRD 的 A-3 手测清单（[10 §3](../prd/ai-native/10-roadmap-risks.md)）。协议层已在 Ph0 用官方 SDK 跑通；
> 本文要确认的是**客户端界面**这一层，必须由人在界面上操作并记录。

---

## 0. 一次性准备

前提：Node 22.13+、pnpm 11.28.10、仓库已 clone。

推荐直接运行统一安装器：

```powershell
node bin/heimdall.mjs setup
```

它会按需完成依赖、Chromium、控制台、自包含 MCP、`:8900` 引擎和已检测客户端的连接，
不会重复安装已经就绪的部分。只想自己指定客户端时：

```powershell
node bin/heimdall.mjs setup --connect codex,claude-desktop
```

安装器默认打开单端口控制台 `http://127.0.0.1:8900`。`:5173` 只用于单独开发
Vite 前端，不是 MCP 入口。

需要把 `heimdall` 命令放到 PATH 时再执行：

```powershell
pnpm link --global
heimdall --version
```

如果 `heimdall` 仍找不到，运行 `pnpm bin -g` 把输出目录加进 PATH，或临时使用
`node bin/heimdall.mjs <命令>`。

---

## 1. 起靶子与引擎

```powershell
# 终端 A：F1 夹具（完全离线）
node core/test/fixtures/bench/f1/server.mjs --port 5090

# 终端 B：单端口引擎 + 控制台
node bin/heimdall.mjs setup --no-open
```

另开一个终端确认：

```powershell
node bin/heimdall.mjs doctor --json
node bin/heimdall.mjs overview --json
```

`doctor` 里不应有 `fail`；`overview` 应能看到引擎与站点清单。

---

## 2. Claude Code（必测）

### 2.1 安装插件

在 Claude Code 里：

```text
/plugin marketplace add D:/Github-Star/heimdall
/plugin install heimdall@heimdall
```

如果本地路径不被接受，改用仓库的 GitHub 地址（私有仓库需已登录）：

```text
/plugin marketplace add kael-odin/heimdall
/plugin install heimdall@heimdall
```

安装后重载/重启 Claude Code。插件会把 `plugin/` 下的技能、子代理、斜杠命令和 MCP 配置一起带上。

### 2.2 确认工具可见

在 Claude Code 里输入 `/mcp`，应看到 `heimdall` 服务及其工具。
预期工具名形如：

```text
mcp__plugin_heimdall_heimdall__heimdall_doctor
mcp__plugin_heimdall_heimdall__heimdall_overview
mcp__plugin_heimdall_heimdall__heimdall_clone
mcp__plugin_heimdall_heimdall__heimdall_brief
mcp__plugin_heimdall_heimdall__heimdall_compare
...
```

**实际名字以 `/mcp` 显示为准**，记到验收表里；如果插件形态的工具名不同，先记录，不要改代码猜。

然后说一句：

> 调用 heimdall_doctor，告诉我引擎、Chromium、数据根的状态。

看到 `engine: ok`（或等价摘要）即表示 MCP → 引擎链路通。

### 2.3 跑夹具 F1

把下面这段原样粘进 Claude Code（仓库根目录）：

> 用 Heimdall 把 `http://127.0.0.1:5090/` 重建成 `html-css` 项目，放在
> `core/workspace/_demo/f1-a3`，三个视口（375 / 768 / 1440）达到 `silver`。
> 不要外链任何资源，不要改动门禁配置。完成后告诉我：通过了没有、还有哪些残差、以及怎么运行。

如果它没有按技能走，补一句：**按 `heimdall-rebuild` 技能执行，逐段 compare，不要整页重写。**

预期过程：

1. `heimdall_doctor` → `heimdall_clone`（拿到冻结镜像）；
2. `heimdall rebuild init ...` 生成工作区（分段、参考图、原件资产、`AGENTS.md`）；
3. 逐段 `heimdall_brief` → 写代码 → `heimdall_compare --section-id`；
4. 修复包里的 `样式差`（参考 / 候选 / 差值）驱动下一轮；
5. 整页 `heimdall compare` 到 `pass-candidate`；
6. 再单独跑 `heimdall gate report` 与 `heimdall gate formal`。

### 2.4 通过标准（A-3）

- 插件安装成功，`/mcp` 能看到 Heimdall 工具；
- `heimdall_doctor` 在客户端里能返回环境状态；
- F1 从「一句话」跑到 **快速裁判 `pass-candidate`**（不要求正式门禁通过）；
- 记录：客户端版本、实际应答模型、迭代次数、墙钟时间、最终判定、失败点。

> 注意：模型别名可能被本机网关改写（PRD R17）。**以运行记录里的实际 `model` 字段为准**，
> 不要以技能或代理的自述为准。

---

## 3. Claude Desktop（必测）

### 3.1 用 connect 写入配置（推荐）

```bash
heimdall connect claude-desktop --dry-run   # 先看将写入的差异
heimdall connect claude-desktop             # 写入、备份、自测；失败会自动还原
```

- 配置位置：`%APPDATA%\Claude\claude_desktop_config.json`
- 写入后**完全退出并重启** Claude Desktop；
- 新开对话，问：「列出 heimdall 的工具，并调用 heimdall_doctor」。
- 看到工具列表与引擎状态即通过。

### 3.2 手工配置（connect 不可用时）

编辑 `%APPDATA%\Claude\claude_desktop_config.json`，加入（路径换成你的仓库绝对路径）：

```json
{
  "mcpServers": {
    "heimdall": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["D:/Github-Star/heimdall/plugin/server/heimdall-mcp.mjs"],
      "env": { "HEIMDALL_API": "http://127.0.0.1:8900" }
    }
  }
}
```

改完重启应用。JSON 不合法会导致整个 MCP 列表加载失败，改前先备份。

> Desktop 不加载 Claude Code 的插件技能；可以用 MCP 提示词（如 `heimdall:rebuild`），
> 或直接把 2.3 的提示词粘进去，并让它先读工作区的 `AGENTS.md`。

### 3.3 通过标准

- Desktop 里能看到 Heimdall 工具并调通 `heimdall_doctor`；
- 同一条 F1 提示词能跑到 `pass-candidate`（或至少完成 clone → rebuild init → compare 的竖线）；
- 记录与 Claude Code 相同的字段。

---

## 4. Cursor / VS Code（可选）

```bash
heimdall connect cursor     # 全局 %USERPROFILE%\.cursor\mcp.json
heimdall connect vscode     # 全局 %APPDATA%\Code\User\mcp.json，键名是 servers
```

也可以加 `--project` 写进当前项目（`.cursor/mcp.json` / `.vscode/mcp.json`）。
VS Code 的键名是 `servers` 且每项要 `type: "stdio"`，`connect` 已按客户端分别生成。
改完重启客户端，验证方式同上。

## 4.1 Codex App / Codex CLI

Codex 使用 TOML 配置，不需要手改。先启动引擎，再运行：

```bash
heimdall connect codex --dry-run
heimdall connect codex
```

写入位置是 `%USERPROFILE%\.codex\config.toml`，只维护
`[mcp_servers.heimdall]` 和它的 `env` 子表，不会重写其它 MCP 服务器。
重新打开 Codex 后，让它先调用 `heimdall_doctor`。

当前 MCP 能力包括：环境检查、站点总览、克隆、简报、比对、任务、QA、
SEO 审计、竞品 SEO 矩阵和站点变更监控。完整控制台能力仍然比 MCP 多，
例如交付包、人工验收和完整教学界面。

---

## 5. 验收记录

**2026-10-31 本机结果（Claude Code 插件 MCP，本会话）**

- 历史记录：插件安装后 `/mcp` 显示 `plugin:heimdall:heimdall ✔ Connected`，当时共 11 个工具；当前新增 QA CI、SEO 审计、SEO 矩阵和站点监控后为 15 个；
- F1 重建工作区 `core/workspace/_demo/f1-a3`：**6/6 分段 `pass-candidate`**，整页 375 99.89% / 768 99.91% / 1440 100.00%（达到 gold）；
- 唯一需要修的差异：窄视口 footer-bottom 多了 20px 上内边距与分隔线；修复包用 `样式差` 直接指出 `paddingTop 参考 0px / 候选 20px`，一次改完；
- 六维门禁：`passed`（gold）；正式裁判：**passed silver**，验收视觉 3/3、结构 3/3、健康 12/12；
- 交付：`core/workspace/127.0.0.1--origin-5c84d1d15de129f0/agent/deliver/home-20261030T173510Z-cbc82f/`（状态 passed，25 个项目文件 + 8 个镜像文件）；
- 记录：8 次 compare，约 3 分钟；本会话模型标识 `claude-fable-ccs-272433[1m]`（由运行环境报告）。
- **Claude Desktop**：2026-10-31 界面 `heimdall_doctor` 返回 **9/9 通过**（操作者贴回结果，总体「环境就绪」）；配置与 stdio 也已验证。当前连接支持和 Codex TOML 支持已补入 `heimdall connect`。

跑完每个客户端填一行，作为 A-3 的证据：

| 客户端 | 版本 | 实际模型 | 开始时间 | 迭代次数 | 墙钟 | 快速裁判 | 正式裁判 | 卡点 / 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.310 | `claude-fable-ccs-272433[1m]`（环境报告） | 2026-10-31 17:32Z | 8 次 compare | ~3 分钟 | pass-candidate（gold） | passed（silver） | 6/6 分段；一次 footer 窄视口间距修复 |
| Claude Desktop |  |  | 2026-10-31 | — | — | — | — | 界面 doctor 9/9 通过；未跑重建提示词 |
| Cursor（可选） |  |  |  |  |  |  |  |  |
| VS Code（可选） |  |  |  |  |  |  |  |  |

要留下的证据：

- `/mcp` 工具列表截图（证明客户端真的看到了工具）；
- 一段完整对话导出（证明「一句话 → clone → init → compare」）；
- `core/workspace/_demo/f1-a3/.heimdall/ledger.jsonl`（每轮分数）；
- `heimdall gate report` / `gate formal` 的报告路径；
- 失败的现场：错误原文 + 引擎日志，不要只写「没通」。

---

## 6. 常见问题

| 现象 | 先查什么 | 处理 |
| --- | --- | --- |
| `engine_unreachable` | 引擎端口 8900 是否在跑 | 启动 `heimdall serve` 或 `node core/src/engine-server.mjs 8900` |
| `/mcp` 里没有 heimdall | 插件是否安装/启用；MCP 进程是否能启动 | 重装插件；手工运行 `node plugin/server/heimdall-mcp.mjs` 看 stderr |
| `heimdall: command not found` | 全局链接是否成功 | `pnpm link --global`；把 `pnpm bin -g` 加进 PATH |
| Claude Code 未登录 | 交互式登录；无头模式需要 API Key | 先交互登录，或用 `ANTHROPIC_API_KEY` |
| Desktop 改完没反应 | 是否完全退出并重启 | 托盘退出后重开；确认 JSON 合法 |
| `rebuild init` 报目录非空 | 上一次运行留下的工作区 | 换新目录；评测重置才用 `--force` |
| 验收目录 `MIGRATION_REQUIRED` | Schema1/2 旧目录 | 按 [Schema4 指南](../competition/acceptance-catalog-schema4.md) 停引擎后显式迁移 |
| 引擎启动报验收锁被占用 | 是否还有另一个引擎 | 按提示确认后删除 `.acceptance-owner.json`，不要删其他验收数据 |

---

## 7. 这一步通过之后

把记录表与证据路径回写到 [PRD 10 §3](../prd/ai-native/10-roadmap-risks.md) 的 A-3 行，
并把 [DEMO-SCRIPT](../../DEMO-SCRIPT.md) 第 2 幕从「回放」改成「现场运行」。
