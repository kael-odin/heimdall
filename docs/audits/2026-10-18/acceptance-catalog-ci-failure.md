# Catalog 写后刷新失败的精确 CI 记录

日期：2026-10-18。诊断补全提交 `41c359a62ecbb67ac15f38c51c95fa983a7492d3` 的 run `39082419484`、attempt 1 为 **completed / failure**。本记录保留原终态，与前一提交的来源会话断言失败分开。

| 范围 | 原始结果 |
| --- | --- |
| 完整 Core | 2661 tests / 2657 pass / 0 fail / 0 cancelled / 4 skipped / 0 todo |
| Core 原生 duration | 1665894.745146 ms |
| 前轮 named-session 用例 | 本轮 `ok 1975`；不构成间歇问题已修复的证明 |
| acceptance smoke 1–3 | success |
| 第 4 项 Catalog smoke | failure；UTC 2026-10-18 00:50:48–00:51:23；`Catalog smoke timeout: state not reached` |
| 失败位置 | 精确提交 `smoke-acceptance-catalog-console.mjs:312`，等待延迟版本提交后的 notice |
| 后续 16 项 acceptance smoke 与 Docker | skipped；D5 没有终态摘要 |
| 另两个 job | console build、独立 e2e smoke 均 success |

[失败原件与只读诊断](evidence/catalog-ci-failure/README.md)保存全部 99 项原件，共 5,361,160 bytes。原采集 exit 0 只说明采集完成；原独立 verifier exit 1，263 checks 中 45 false，包括 execution 28 与 capture 17。`identityMatches:true`、`captureComplete:false`、`executionAccepted:false`、`passed:false` 继续保留。17 项 capture false 都对应跳过的步骤，没有独立 step log；不能将其直接解释为下载损坏。

唯一失败 artifact `12120555294 / acceptance-catalog-failure-1` 的 ZIP 长度 149,526 bytes，SHA-256 为 `7c02655c6ce6c013ea99c55eed28963fb448316bbe86624264c47b5718ae4ab9`，与 GitHub API 及 upload 日志一致。CRC、解压路径和符号链接检查通过，7 项内容完整保留。

原 POST 已收到 201，测试已经完成 `route.fulfill`。失败快照中服务端提交后的目录刷新尚未终结，`writing='release'`、`listLoading=true`、notice/error 为空，当前项目及未提交草稿仍在。精确 Vue 代码在刷新结束后才写 notice 和清除 writing。

旧 transport 的 fetch 与 `response.json()` 没有自身完成期限，因此不结算的读取能够阻塞 busy 状态。这是可独立验证的产品缺口。原 CI 没有保存请求开始、requestfinished 和正文解析阶段，不能据此认定原 CI 就是某一类 fetch 或正文挂起；也不能认定服务端死锁、草稿丢失、runner 过慢或与前轮来源会话同根因。

后续修复必须保留原 smoke 的 25 秒等待、全部断言、原 CI verifier 和原始失败材料。新的本机通过只证明新版本在该次受控环境通过，发布后仍需独立核验新提交自身的完整 Linux CI。
