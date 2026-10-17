# Browser 私有来源读取证据

对应[实施验收记录](../../acceptance-browser-reading.md)，采集日期 2026-10-17。此目录保留首轮失败和最终成功的完整历史，已有原件不覆盖。

- `gates.initial.exitcodes.json` 与 `03-core-test.stdout.gz`：首轮 lint / Console build 成功；Core 2087 项、2076 通过、2 失败、9 跳过，exit 1。
- `gates.exitcodes.json` 与 `03-core-test-retry.stdout.gz`：最终完整 Core 2087 项、2078 通过、0 失败、9 跳过，exit 0。最终 Core smoke、CDP、Browser reading 也全部 exit 0。
- `fresh.summary.json`：最终 Browser reading 13/13，4 次 fresh Chromium 运行、81 份原件、8 次成功捕获、2 次 owner 拒绝；8 个选侧案例为 4 合格 / 4 拒绝。
- `fresh-materials.tar.gz`、`fresh.source-index.json` 与 `fresh.target-preview.json`：完整 86 文件树及所选侧预览。归档解包后已逐文件比对字节；原始失败 / blocked 门禁没有重写。
- `reader-*.stdout.gz` 与 `owner-*.gz`：独立专项的首轮与最终轮。最终 reader 236/236；owner root identity 为 9 通过、1 Windows 跳过、0 失败。旧回归与专项存在重叠，不累加。
- `root-swap-before.json`、`root-swap-after.json` 与 `probe-root-swap.mjs`：原 owner 首次读取前的目录替换窗口及加固后 503 拒绝、保留迁移锁的现场。
- `owner-perf.bench.mjs` 与 `owner-perf.result.json`：安静本地交错微基准。组合 guard 是成本模型，没有复现生产 HTTP route 或全量并发负载，不贡献测试数量。
- `owner-ancestor-junction.probe.mjs` 与 `owner-ancestor-junction.result.json`：内存变体复现，保存后未重跑。变化涉及同一物理移动目录内的原锁 inode，没有证明删除外来 inode。
- `cdp-real-forge.json` 及两张 `cdp-*.png`：真实 Console → Clone 操作，taskStatus=done、cloneStatus=200、pageErrors=[]。

recovery compatibility 的 stdout 为 37 项、35 通过、0 失败、2 跳过；没有独立退出码文件，派生观察中明确记为 `null`，通过计数不能替代进程退出码。managed executor 原 15 秒预算的独立复跑为 6/6、exit 0，前后源码 SHA 一致；它用于诊断首轮超时，最终完整 Core 重试才是本地全量门禁结果。

Core 总数只采用最终完整重试。初轮失败、最终重试、专项、诊断复跑和 Linux CI 是不同观察，不相加。`source-files.json` 记录归档工件的源路径、原始 / 存储大小、SHA-256、无损处理方式和阶段解释；gzip 已验证解压回原字节。此目录不证明外部部署、认证业务、跨文件原子快照或永久目录身份。
