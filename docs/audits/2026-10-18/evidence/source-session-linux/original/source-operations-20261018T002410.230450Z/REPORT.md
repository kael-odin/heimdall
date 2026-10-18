# Linux 针对性整文件复验

本次只在独立 WSL Ubuntu 24.04.4 x64 环境，使用 Node22.23.3 / pnpm11.7.0 / Playwright1.63.0，对冻结副本 `test/source-operations.test.mjs` 进行一次完整文件复验。此结果不能替代完整 CI。

- startedAt UTC：2026-10-18T00:24:12.210308+00:00
- completedAt UTC：2026-10-18T00:24:25.035622+00:00
- durationSeconds：12.82531658
- 实际退出码：0
- argv：`["/root/heimdall-node22-diagnosis-20261018/runtime/bin/node", "--test", "--test-reporter=tap", "test/source-operations.test.mjs"]`
- cwd：`/root/heimdall-node22-diagnosis-20261018/app-core`
- Node test 的唯一原生统计：`{"tests": {"count": 1, "value": 17}, "suites": {"count": 1, "value": 0}, "pass": {"count": 1, "value": 17}, "fail": {"count": 1, "value": 0}, "cancelled": {"count": 1, "value": 0}, "skipped": {"count": 1, "value": 0}, "todo": {"count": 1, "value": 0}, "duration_ms": {"count": 1, "value": 12801.680203}}`
- 原 not ok：`[]`
- 通过该针对性要求：true
- 不增加 CPU 负载；不启动并行 Browser 任务；不自动重试。
- 源和隔离副本共 199 项，运行前后 SHA256 与字节全一致。
- 测试文件 SHA256：`183d749cddcdb34432a1abc48ffb8c11b780a48577b262f2a970d4e0dc03d0dc`。
- stdout 原字节 SHA256：`dcbe2995d8e11334146e1c9d084e15501d2c0c6939053241e7aeec72f45370cf`；stderr 原字节 SHA256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

完整 stdout、stderr、版本、精确 argv/时间/退出码和前后输入清单均与本报告同目录。若有失败，原输出完整保留，未修改期望、timeout 或核验口径。
