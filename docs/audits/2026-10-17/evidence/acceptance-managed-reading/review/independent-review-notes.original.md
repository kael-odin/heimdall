# Managed reader 独立审查与最终 WSL 回归

日期：2026-10-17（Asia/Hong_Kong）。本目录保留受控本机流程与源码复核证据，不代表外部真实站点验收。

## 最终冻结后的 WSL 回归

- Node v22.23.3 / Linux，退出码 0。
- 9 个测试文件，116 个顶层 subtest，合计 189 个测试；189 pass / 0 fail / 0 skip / 0 cancelled。
- TAP duration：78126.442098 ms。
- Linux 专属 FIFO 边界实际执行通过。
- 源码 cwd 位于 `/mnt/c/.../heimdall/core`，Windows C: 的 9p 挂载（stat 为 v9fs）。
- 测试临时目录 `TMPDIR=/tmp` 位于 WSL ext4 `/dev/sdd`（stat 的 ext-family magic 显示 ext2/ext3）。不能把此次源码位置表述为 ext4。
- 20 份相关源码与测试在执行前后 SHA 完全一致；reader SHA 与 root 的冻结值一致。
- Node archive 先按持久化 SHA 校验，再在同一个 WSL 进程解压和执行，不依赖旧 `/tmp` 缓存。

证据：`linux-final-focused-tests.tap`、`linux-final-environment.txt`、`linux-final-exit-code.txt`、`linux-final-sha-before.txt`、`linux-final-sha-after.txt`、`linux-final-windows-context.json`、`linux-final-summary.json`。可复现脚本：`run-linux-final-focused.sh`。脚本引用 sibling ignored 目录中的 Node 官方 archive；archive 未复制进本目录。

测试范围：snapshot schema、managed run reader、legacy batch evidence edges、store/CLI/HTTP consumers、managed quarantine、public run view、managed catalog、catalog、managed Spec plan golden。未启动额外独立 engine 或浏览器；消费者/隔离测试按套件内部流程启动受控本机 HTTP fixture 与 engine 子进程。

## 独立发现与关闭情况

1. Legacy 证据缺少 batch 最终 fence：故障注入发生在读取后一笔 run 的 manifest 时，改坏前一笔已验证证据。修复前 batch 返回 valid/evidenceVerified，但立即 fresh 单读失败。已通过 scope narrow capture 接入整批最终 fence 关闭。`batch-edges-tests-before.tap` 保留 2 fail，`batch-edges-tests.tap` 保留修复后 2 pass；最终 WSL 两条回归也通过。损坏 bytes 保留，无修复性重写或额外目标请求。独立探针见 `legacy-batch-evidence.probe.mjs` 与 before/after JSON。
2. Managed settlement 的原始 error 泄漏公共 DTO：真实 prepare + writer settle 写入含私有路径与 SECRET_TOKEN 的错误，实际 route 使用的投影函数原样返回。`run-view.mjs` 改为受控固定诊断后复验关闭；原始 manifest 与错误仍保留。该独立探针是 route 投影函数调用，并非真实 HTTP 请求；最终消费者回归另有真实 engine HTTP 覆盖。探针见 `managed-error-dto.probe.mjs` 与 before/after JSON。

本代理当前没有其它必须修复项。Managed executor、recovery、catalog binding/candidate/readRunReference metadata 与 triage writer 的后续能力仍不在本切片开放范围。
