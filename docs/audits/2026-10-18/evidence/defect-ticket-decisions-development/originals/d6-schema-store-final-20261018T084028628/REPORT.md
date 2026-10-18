# D6 schema/store 专项

2026-10-18；共享工作树，未提交。

- node --test core/test/acceptance-defect-ticket-schema.test.mjs core/test/acceptance-defect-ticket-store.test.mjs core/test/acceptance-defect-ticket-decision-crash.test.mjs
- 50 total / 50 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo；exit 0；duration_ms 50352.15。
- schema-store-crash.log 保存原始测试输出。input-sha256.json 固定本次六个维护输入，environment.json 记录 Node 环境。
- 38 个 schema/store 用例覆盖旧断言与新 confirmation/rejection/decision、33104 bytes deny envelope、同槽竞争、proof 优先 queue、accepted-only chain、actions/bytes/tickets 容量与 uncertainty 传播。
- 12 个真实子进程 SIGKILL：event/rejection 分别在 namespace-parent、namespace-version、temporary、before-link、linked、committed 中断。仅独立 fixture patch native fs，生产无 crash hook。
- 每个 crash-fixtures 子目录保留 input、reached marker、child-output、scene-before/after 与全部原始磁盘现场。partial 场景 fresh owner/store fail closed；committed 场景只精确 replay 且 prepare 不执行。
- 这不是 Browser/HTTP/完整 core 或断电耐久验证；不替代 root 的完整门禁和精确提交 SHA CI。

上一轮 schema/store 38/38 日志和现场保留在 ../d6-schema-store-20261018T083724665/。
