# 2026-10-16 项目中间产物清理记录

- 项目：Heimdall
- 日期：2026-10-16（香港时间）
- 目的：清理开发过程中的一次性日志、探针、旧运行产物和根目录冗余状态文件，同时保留可恢复证据。
- 原则：先盘点，再移出仓库；不直接删除历史证据、有效交付包、源代码或测试数据。

## 1. 本轮已完成

归档根目录：

`D:\Github-Star\heimdall-archive-20261016`

本轮追加归档清单：

`D:\Github-Star\heimdall-archive-20261016\additional-moved-manifest.json`

重复截图归档清单：

`D:\Github-Star\heimdall-archive-20261016\workspace-duplicates-manifest.json`

先前已归档清单：

- `pre-move-manifest.json`
- `moved-manifest.json`

本轮移出仓库的内容：

| 原路径 | 归档位置 | 处理原因 |
| --- | --- | --- |
| `node_modules/`（根目录，仅 pnpm 状态文件） | `additional-20261016/root/node_modules/` | 根 `package.json` 无依赖，属于冗余状态目录 |
| `core/export-*.log`、`core/queue-*.log` | `additional-20261016/core-logs/` | 一次性导出、排队和 HAR 调试日志 |
| `core/upgrade-*.log`、`core/verify-final*.log` | `additional-20261016/core-logs/` | 历史升级与验证日志，不参与运行 |
| `core/workspace/_runs/check-*.mjs` | `additional-20261016/one-off-runs/` | 一次性回放探针 |
| `core/workspace/_runs/probe-*.mjs` | `additional-20261016/one-off-runs/` | 一次性渲染/动效探针 |
| `core/workspace/_runs/clone-all.sh`、`clone-all-2.log` | `additional-20261016/one-off-runs/` | 旧批量实验脚本及其日志 |
| `core/workspace` 根目录 11 个内容级重复 PNG | `additional-20261016/workspace-root-duplicates/` | 保留每组一个代表图，重复截图可恢复归档；`_e2e-failure.*` 等最新失败证据未移动 |

移动是可逆的，清单记录了每个源路径、归档路径、文件大小和时间。归档目录不属于 Git 工作树，也未被提交。

## 2. 本轮保留

- `core/src/**`、`core/test/**`、`console/src/**`：源代码和测试。
- `core/workspace/_runs/historical-v2-batch`：历史批处理证据。
- `core/workspace/_runs/repo-audit-20261014`：仓库审计证据。
- `core/workspace/**/_variants-backup*`：可回滚的变体备份。
- 当前主要站点工作区和有效交付包：用于继续开发、复验和演示。
- `core/node_modules`、`console/node_modules`：可由各自 lockfile 重装，但当前保留以免中断本地开发。
- `docs/archive/**`、`docs/audits/**`：历史报告和审计证据。

不应直接删除 `core/workspace`、`core/assets-cas`、`core/deliverable`、`docs/archive` 或变体备份。它们可能被当前工作区、硬链接 CAS、交付包和历史报告引用。

## 3. CAS 存储预览

项目自带 CAS 扫描结果：

- CAS 文件：20,277 个。
- CAS 逻辑大小：12,330,114,536 字节。
- 孤儿文件：2,487 个。
- 可安全回收的孤儿字节：1,741,625,753 字节。
- 判据：CAS 文件 `nlink === 1`，说明只剩 CAS 自身链接，没有 workspace 副本使用。
- 状态：本轮只完成预览，尚未执行回收。

建议后续执行前重新预览，因为 workspace 和 deliverable 可能继续变化：

```powershell
Set-Location D:\Github-Star\heimdall\core
node src/cli.mjs cas-gc --json
node src/cli.mjs cas-gc --apply --json
```

执行后应重新运行 `node src/cli.mjs storage`，并把回收前后文件数、逻辑大小、实际占用和失败数写入新的审计记录。不要直接复用旧的 `deliver-prune` revision；旧 revision 对应的交付包范围已经发生变化。

## 4. 忽略规则整理

本轮会把以下本机调试目录加入 `.gitignore`：

- `.playwright-cli/`
- `.claude/`

`.playwright-mcp/` 已经被忽略。`.claude/launch.json` 仍保留在本机，不移动、不删除，只避免本机配置污染工作树。

## 5. 验证记录

本记录创建后执行：

```powershell
pnpm docs:links
git diff --check
pnpm -C core lint
```

文档/归档操作不要求全量浏览器回归；如核心代码未改变，重点验证文档链接、Markdown 格式和语法检查即可。CAS 真回收完成后再追加存储盘点结果。

## 6. 仍需人工决策的清理项

- 是否在停止所有本地服务后，清理并按 lockfile 重装 `core/node_modules` 和 `console/node_modules`。它们是依赖缓存，不属于本轮仓库沉积，暂不自动处理。
- 是否对旧交付包执行 `deliver-prune`。必须重新生成预览、核对 revision 和保留清单，再执行可恢复隔离。
- 是否对 CAS 孤儿执行真回收。必须确认没有并行克隆、导出或验收任务后再操作。
