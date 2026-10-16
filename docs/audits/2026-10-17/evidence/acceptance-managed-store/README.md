# 受控存储证据索引

本目录记录内部存储层及现有控制台回归，没有托管 HTTP executor 或真实引擎重启验收。

- [完整索引](index.json)：每份原件及归档件的字节数、SHA-256 与文本规范化。
- [源码固定值](source-pins.json)：本轮实现和测试；当前十源 verifier 算法未改。
- [本地真实 HTTP](managed-http/summary.json)：固定身份、BUG 门禁、部分报告与中断收尾，原需求文件未改。
- [Core 全量](core-full.log)：总数以日志终态为准；平台或 Docker 跳过独立列出。
- [普通 Spec 浏览器](spec-console/browser-checks.json)与[镜像 CDP](cdp/cdp-real-forge.json)：现有入口回归。
- [准备内核](managed-preparation/checks.json)：准备与重放零执行。
- [父提交 CI](parent-ci-13128a9.json)：仅证明 13128a9 的自身 CI，不能替代本轮新提交 CI。

日志与环境文本仅规范化 BOM、CRLF 与行尾空白，index 同时保留原 bytes/SHA。业务 JSON 若原已为 LF 则字节不变。
writer-review-probes.json 中 before 是修复前真实假通过探针，after 才是新增证据交叉校验后的拒绝结果。
