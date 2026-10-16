# Reader Linux 专项原始证据

本目录保留 mirror_runner 产生的 `managed-readers-linux-final.sh` 与 `managed-readers-linux-final.tap` 原始字节。原件仍位于 `core/workspace/_runs/`，未移动或删除；来源与 SHA 对照见 sibling `review/archive-provenance.json`。

原始 TAP 记录 reader + dispatch-reader 专项共 60/60 pass，0 fail、0 skip、0 cancelled，duration 1983.82188 ms。

原脚本硬编码 `/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall`，从未归档的 `managed-linux-final-20261017/node-v22.23.3-linux-x64.tar.xz` 解压 runtime，将 `core/src`、`core/test` 与 `core/package.json` 复制到 `/tmp/heimdall-readers-linux.*` 后执行，并将 TAP 写回原 repo `_runs` 路径。因此它是本次环境的执行凭据，不能在任意 checkout 直接运行；复现时应复制脚本、调整源 repo 路径并提供对应 archive。

此 TAP 本身没有附加独立的环境或源码前后 SHA 清单。不要把 sibling review 的 20 文件 SHA/9p 源码位置套用为本次 mirror 专项的独立测量。测试使用合成本机 fixture；检查未发现真实凭证或会话数据。
