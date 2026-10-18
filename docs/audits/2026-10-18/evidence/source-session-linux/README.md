# 历史 WSL Linux source-operations 专项证据归档

本目录保存 2026-10-18 历史准备会话及单文件验证的原始记录。`original/` 内 **67 个原件、391,315 字节**均按字节复制，并逐项比较来源复制前、来源复制后和归档字节。空 stderr 也保留。新增文件只描述与核验已有证据，本次归档没有运行测试、Browser、engine 或历史准备脚本。

原始会话来自旧 D5 工作树的 `core/workspace/_runs/wsl-node22-preparation-20261018/`。其原始文件内的绝对路径和历史标志保持原样；新增 `manifest.json` 的文件索引全部使用相对路径，离线核验不依赖旧工作树。

## 结果范围

- 唯一历史测试 argv：`["/root/heimdall-node22-diagnosis-20261018/runtime/bin/node", "--test", "--test-reporter=tap", "test/source-operations.test.mjs"]`。
- 历史 cwd：`/root/heimdall-node22-diagnosis-20261018/app-core`。
- 历史执行时间 UTC：`2026-10-18T00:24:12.210308+00:00` 至 `2026-10-18T00:24:25.035622+00:00`，exit 0。
- 历史 TAP：**17 tests / 17 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo / 0 suites**，duration_ms `12801.680203`。没有增加 CPU 负载、启动并行 Browser 任务或自动重试。
- 这是一次 WSL Linux 的 `source-operations.test.mjs` 专项记录，不能替代 `41c359a62ecbb67ac15f38c51c95fa983a7492d3` 的完整 CI、20 个 smoke、D5 或 Docker 验收。该提交完整 CI 的真实终态为 **failure**，相邻 `catalog-ci-failure/` 保存其证据。

## 环境与输入身份

历史环境为 WSL Ubuntu 24.04.4 x64、Node `v22.23.3`、正式 pnpm `11.7.0`、Playwright `1.63.0`。准备阶段曾自动切换 pnpm `11.28.2`，后来按 `--frozen-lockfile --ignore-scripts --pm-on-fail=ignore` 使用正式版本安装；失败和未完成的准备记录保留。FFmpeg 静态 ELF 的 `ldd` exit 1 也保留，后续通过 `file` 正确分类。Browser 下载与系统依赖准备不表示该准备阶段启动了 Browser。

`source-copy-manifest.json`、测试前后输入快照和 `published-source-match.json` 共同记录 199 项 `core/src` 与单测试输入。离线核验检查这些记录逐项一致，并读取历史提交 `41c359...` 的 199 个 Git blob 验证字节与 SHA256。`published-source-match.json` 的 `matchesCurrentMaintenanceSource` 是原记录时间点的历史标志；本归档没有比较当前 D6 工作树，也不将该标志解释为当前维护盘仍相同。

## 文件索引与核验

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 67 原件的相对路径、字节数和 SHA256；另列两个排除大文件的身份摘要 |
| `archive-integrity.json` | 本次离线核验结果，包括原始清单、199 项输入身份与历史 Git 对象核验 |
| `verify-archive.py` | 独立标准库离线核验器，只读取归档及可选 Git 对象 |
| `original/ENVIRONMENT.md` | 原环境、安装口径、版本、二进制身份和准备限制 |
| `original/linux-preparation-evidence/` 与 `original/linux-setup-logs/` | 原准备命令、完整 stdout/stderr 与安装日志 |
| `original/source-operations-20261018T002410.230450Z/` | 原完整 TAP、空 stderr、精确 argv、退出码、输入前后 hash 和报告 |
| `original/published-source-match.json` | 原 199 项发布源码对应记录 |
| `original/prepare-*`、`run-focused-linux.py` 等 | 原脚本，仅作为历史证据保存 |

从本目录离线核验原件与内部记录：`python verify-archive.py`。同时核验历史 Git 对象：`python verify-archive.py --git-repository <仓库路径>`。核验器不会执行 `original/` 中任何脚本，也不会比较当前工作树。

原 `preparation-deliverables.json` 清单包含其自身生成前的 **68 项**，包括两个大文件，不含清单自身。本归档保留其中 66 个小文件，再加入该原清单自身，合计 67 个原件。`node-v22.23.3-linux-x64.tar.xz`（31,001,304 字节）与 `source-core-at-ci.tar`（7,618,560 字节）只保留身份摘要。旧 source tar 未参与该专项。没有复制 runtime、node_modules 或 Browser 二进制。

本目录 `.gitattributes` 的 `* -text` 防止 Git 换行转换改变证据字节；`.gitignore` 将原日志纳入归档，覆盖仓库的通用日志忽略规则。`manifest.json` 只清点 `original/`；另外六个归档控制文件不参与递归自 hash。
