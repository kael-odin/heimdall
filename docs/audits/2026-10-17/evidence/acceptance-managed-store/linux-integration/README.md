# Managed Spec Linux 定向回归（2026-10-17）

真实 WSL Linux Node v22.23.3 进程执行七个测试文件，58 tests / 58 pass / 0 fail / 0 skip，exit code 0。包含真实本机 HTTP fixture；本轮没有启动浏览器。

- 源码 cwd：`/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall/core`。`stat -f` 为 `v9fs`，`findmnt` 为 `9p C:\`，源码树不是 ext4。
- fixture 和 Node runtime 的临时根：`/tmp`。`stat -f` 为 `ext2/ext3`；`findmnt` 确认为 `/dev/sdd` 上的 `ext4`。测试通过 `tmpdir()` 创建 acceptance 临时目录。
- `focused-tests.tap` 是完整原始 TAP；`summary.json` 包含命令、counts、环境及 SHA；`sha256-before.txt` 与 `sha256-after.txt` 完全一致。
- 四个冻结 execution/evidence schema 源码与测试文件 SHA 全部匹配交付值。
- `environment.txt` 保留首次环境记录。WSL git 无法解析 managed worktree 内 Windows 风格 gitdir，git-head 字段未成功生成；`summary.json` 的 Windows HEAD 是补充信息，实际执行源码以 SHA 快照为准。
- Node 官方 archive 的 observed SHA 与 SHASUMS256 一致。默认 WSL 无 Node、WSL 直连下载超时后，通过 Windows 网络下载并在 WSL 临时目录解压执行。

证据按父代理归档约定复制到本目录，Linux Node archive 二进制未复制。本目录 run script 仍保留实际运行时的原始路径。
