# Heimdall 使用指南

本指南说明当前控制台与命令行的操作。旧版逐日说明已移至
[历史使用手册](docs/archive/USAGE-through-2026-10-13.md)，其中的示例分数与页面数量不能当成当前验收结果。

## 准备

- Node.js 20.19+、pnpm 11.7+；抓取与测试需要 Playwright Chromium。
- 仅处理自有站点或取得明确授权的内容。登录会话、导出包和代理访问分别按授权范围控制。
- 新机要分别安装两个子包。根目录没有 pnpm workspace 配置。

```powershell
pnpm -C core install --frozen-lockfile
pnpm -C console install --frozen-lockfile
pnpm -C core exec playwright install chromium
```

## 启动

开发时开两个终端：

```powershell
pnpm -C core dev
pnpm -C console dev
```

控制台为 `http://127.0.0.1:5173`，引擎为 `http://127.0.0.1:8900`。
Windows 也可运行根目录的 `clone-heimdall.cmd`，脚本会检查两个服务均返回成功后再打开控制台。

单端口运行：

```powershell
pnpm -C console build
$env:HEIMDALL_CONSOLE_DIR = (Resolve-Path console/dist).Path
pnpm -C core dev
```

此时打开 `http://127.0.0.1:8900`。若引擎设置了 `HEIMDALL_TOKEN`，先在控制台「设置 → 引擎 Token」保存同一口令；工作区产物与 API 都由引擎校验。控制台开发服务器不直接发布 `core/workspace/`。

## 克隆与验收

1. 在顶部输入完整 URL 或域名，点「侦察」生成站内页面星图。点星球只打开详情，不自动克隆。
2. 在详情里点「克隆」，或去「页面」清单勾选并批量克隆。只要一页时，直接在顶部输入完整页面 URL，点「只克隆此页」。
3. 在「任务」看运行状态；在「页面」核对每页的产物与分数。切站后等待页面状态加载完，再执行删除或批量操作。
4. 去「报告」打开克隆档案、同步对比、SEO 报告和情报包；首行快捷入口只显示已存在的产物。未出现的报告要先运行对应任务。
5. 交付前运行全站多视口验证和离线健康检查，查看未测页面、缺失资源及失败项。历史分数可能由旧算法生成，需要重算后才能比较。

命令行入口及完整参数：`node core/src/cli.mjs --help`。

```powershell
node core/src/cli.mjs forge https://example.org/
node core/src/cli.mjs recon https://example.org 30
node core/src/cli.mjs queue example.org
node core/src/cli.mjs verify example.org --all
node core/src/cli.mjs assets example.org
node core/src/cli.mjs deliver example.org
```

`verify --all` 遍历全部目标页；有意抽样时显式传 `--max N`。结果里核对目标数、实测数、未测数及失败原因，不能只看平均分。页面结构、文字覆盖与像素是不同维度，分数不能替代断网浏览和人工检查。

## 交互镜像

交互镜像适合有明确授权、需要分析前端行为的场景，不能等同于任意站点的完整离线副本。

```powershell
node core/src/cli.mjs live example.org --offline --heal --strict
```

导出前核对授权和敏感数据。认证站点默认不应把 API 正文或带凭证的 URL 纳入可分发 HAR；具体准入和清洗结果以本次导出报告为准。独立包应再验证登录、表单/API、重定向、登出及断网资源。`--strict` 失败时先修缺口，不要把包标成离线完成。

## SEO 回归

SEO 审计本身可独立运行：

```powershell
node core/src/cli.mjs audit example.org --max 30
```

仓库的 SEO 回归工作流当前仅手动触发，`config/seo-targets.txt` 没有已授权目标或受版本控制的基线。正式启用门禁前，先录入目标并审核基线；损坏或缺失的基线不能当成回归通过。

## 产物与排障

- 工作区：`core/workspace/<host>/`；交付包：`core/deliverable/`。默认均不进 Git，可通过 `HEIMDALL_DATA_DIR` 改数据根目录。
- 页面目录名由引擎的 URL 映射决定。不要根据路径手写目录名；从「页面」清单、报告索引或 `manifest.json` 查实际路径。
- 打不开控制台时检查 `:8900/api/status` 与 `:5173/`；有 Token 时在设置中保存后刷新。启动脚本超时会报错，不代表服务已就绪。
- 未生成的可选产物不会在报告里显示链接。已有产物打不开时先检查引擎鉴权，再看引擎日志与浏览器网络请求。
- 测试入口：`pnpm -C core lint`、`pnpm -C core test`、`pnpm -C core smoke`、`pnpm -C console build`。

架构、产品边界和当前待办分别见 [ARCHITECTURE.md](ARCHITECTURE.md)、[PRD.md](PRD.md) 与 [ROADMAP](docs/ROADMAP.md)。
