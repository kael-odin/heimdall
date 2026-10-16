# Owned recovery 独立审查与 WSL 固定输入验证

审查时间：2026-10-17（Asia/Hong_Kong）。工作区：`C:\Users\44548\.codex\worktrees\managed-spec-provenance\heimdall`。

## 结论

本轮确认 1 项真实缺陷：已拥有的 root 在 recovery 首次目录检查时消失，会被原实现解释为空根而返回成功。父代理已窄修 owned 分支为阻断，root-only 旧入口仍允许缺失根返回 0。本代理仅在 `core/test/acceptance-owned-recovery.test.mjs:198` 增加该项回归，没有修改生产实现。

修复后的独立审查未发现新的实际实现缺陷。第一次正式发布前的全批预检、首个当前 token 消费后的排除、合法自写后的 scope 生命周期、终态 expected bytes、root-only managed 隔离、legacy witnesses 更新与不确定提交计数，均与设计相符。matching managed report/evidence 保持 opaque，未通过这些材料推导 completed。

## 已修问题的复现与验证

`review-owned-root-loss-probe.mjs` 在真实 owner 已获取后，于首次 `lstat(root)` 时真实 `rename(root, root+'.moved')`。修复前返回全零成功，但随后 `owner.assertOwned()` 返回 `ACCEPTANCE_OWNER_LOST`。

新增测试对同样真实 rename 注入验证 `ACCEPTANCE_RECOVERY_BLOCKED`、preflight 阶段、零计数和 `writeMayHaveCommitted=false`；拦截 mkdir/write/fsync/link/rename/unlink 确认恢复零写，移走目录内原 legacy manifest 字节保留。同项验证 root-only 缺失根仍返回 0 且不创建目录。Windows 定向测试 1/1 通过；该项同时在 Linux focused 运行中通过。

## 固定输入

`review-freeze-inputs.mjs` 先捕获并哈希源码、测试、脚本、包元信息和两份历史 JSON，再只使用已捕获 bytes 写 `review-frozen/payload`。写后检查源文件清单、全部源 SHA256 和全部副本 SHA256，一致后才生成 verified 标记。

- 固定输入：386 文件，4,045,295 bytes。
- WSL：Ubuntu-24.04，`/tmp` ext4，Node v22.23.3。
- Node tar SHA256：`df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`。
- recovery.mjs：`17e10b958373c1da554f9c690b8a5d4717361a7e92ada9062190ef9c31200539`。
- managed-run-store.mjs：`24928620ae3d55f94a6f3cdb3671efd68afe49adef5126a1ee72747aaf86de33`。
- engine-server.mjs：`893296a1276a96bb6f398d6486d998df33be8657d97ed25c2d472dc9b24a84fd`。
- acceptance-owned-recovery.test.mjs：`11e280b6d96452f4d6bebf8683ba218099217cd8845aab8b319a35f14a853b0d`。
- acceptance-owned-recovery-engine.test.mjs：`c2fb0270dfef7d634d3c355ffbf884b29ad1e4d6c6e4801d2ec5e2823c78fa60`。

完整 pins 见 `review-frozen/pins.json` 与 `review-frozen/pins.sha256`。WSL 运行前对 ext4 副本逐项校验。

## 执行结果与环境纠正

一次运行 14 suites：owned recovery、真实 engine、writer 主/边界、quarantine、consumers、model、run reader、dispatch reader、batch edges、snapshot schema、owner、owner capability、file publisher。

首轮 `review-focused-linux.tap`：230 tests，222 pass、7 fail、1 skip。7 个失败均在 engine 模块加载阶段，统一为缺少 `parse5` 的 `ERR_MODULE_NOT_FOUND`；所有 recovery、writer 与真实 FIFO 用例通过。skip 是仅适用于 Windows 的真实 non-share-delete reader 测试。

只为纠正该运行环境，固定本机现有 parse5 8.0.1 与 entities 8.1.0，86 文件、667,290 bytes，源/冻结副本/WSL SHA256 一致。保持同一份源码/测试快照，仅重跑先前失败的 7 个 engine 用例，`review-engine-linux-retry.tap` 为 7 pass、0 fail、0 skip。补跑前后源码与依赖 pins 均通过。

去重后的覆盖为 230 tests：229 项通过，1 项 Windows-only skip；没有剩余代码失败。没有扩大测试范围，也没有重跑首轮已通过项。

## 最终当前目录比较

`review-current-vs-frozen.json` 显示 386 个原 pins 中，仅 `core/scripts/smoke-acceptance-console.mjs` 在冻结后变化；该文件不被本轮 suites 消费。恢复、writer、engine、全部本轮测试与夹具仍等于固定验证输入。此结果没有声明验证后来修改的 console smoke。

## 证据文件

- `review-freeze-inputs.mjs`、`review-frozen/pins.json`、`review-frozen/pins.sha256`、`review-frozen/verified.json`。
- `review-focused-linux.sh`、`review-focused-linux-environment.txt`、`review-focused-linux.tap`。
- `review-freeze-dependencies.mjs`、`review-frozen-dependencies/pins.json`、`review-frozen-dependencies/pins.sha256`。
- `review-engine-linux-retry.sh`、`review-engine-linux-retry-environment.txt`、`review-engine-linux-retry.tap`。
- `review-owned-root-loss-probe.mjs`、`review-verify-current.mjs`、`review-current-vs-frozen.json`。

本轮不作跨多文件事务或恶意 OS ABA 原子性的承诺。确认提交在中途故障后保留，未确认但可能已提交的事实通过 `writeMayHaveCommitted` 表达。
