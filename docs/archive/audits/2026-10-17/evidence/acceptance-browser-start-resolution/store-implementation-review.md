# D4 决定记录与恢复实现核验

日期：2026-10-17。范围：`browser-operation-schema.mjs`、`browser-operation-store.mjs` 与新增离线决定测试。产品源码已经冻结，本说明仅整理本目录原始结果，不修改源码、测试、D3 原件或暂存区。

## 已实现的行为

- `inspectDecision` 只读返回 absent、recorded 或 rejected。不存在的决定不会创建 namespace；已有 prepared、running 和 rejected 事实先于新的 admission guard 返回。
- 新拒绝保留严格字段、project fingerprint 与原六字段绑定，使用 canonical JSON 加单个 LF 的精确原字节、16 KiB 上限及 SHA-256。三个独立固定 revision 向量逐字节和 hash 对齐。
- accepted 与 rejected 共享目录容量，并通过独占新目录占用、私有 claim、真实目录身份及同步 current guard 约束发布。已有 partial、mixed、unsafe 或未追踪 temporary 目录不收养、不补齐。
- 发布临时文件执行 exclusive open、fsync、字节与身份核对；最终 guard 后再次核对临时字节，再进行不可替换发布及目标回读。仅清理本次追踪且 inode 一致的 temporary。提交不明保留 `writeMayHaveCommitted`。
- 已拒绝操作不进入执行、恢复、报告或 evidence 写路径。恢复先检查整批决定再修改 running，保留原 prepared 与 rejected 事实。
- running、failed、interrupted 下合法空或半写 report/evidence 保持 opaque，不解析、不补齐，也不计为通过。原 partial-report recovery 测试未改。
- 新增离线 lineage 测试将公开 D3 first-BUG 的旧 verifier 固定为来源，即使随后连续三次实际 D4 pass，也始终 incomparable，不能自动成为 verified_passed。该项在临时 fixture 中构造合法历史绑定，不冒充真实 D3 运行。

## 最终验证

本目录 `summary.json` 为 `passed=true`、`sourcesUnchanged=true`。两组顺序执行，均 exit 0；六个受保护文件 before / after 字节一致。

| 组别 | 结果 | UTC 开始 | UTC 结束 | 原始输出 |
| --- | --- | --- | --- | --- |
| 新决定专项 | 16 tests / 16 pass / 0 fail / 0 skipped | 2026-10-17 14:46:02.254109 | 2026-10-17 14:48:27.778968 | `decision/stdout.log`、`decision/stderr.log` |
| 受影响旧测试 | 12 tests / 12 pass / 0 fail / 0 skipped | 2026-10-17 14:48:27.779968 | 2026-10-17 14:50:00.862308 | `existing-affected/stdout.log`、`existing-affected/stderr.log` |

旧测试使用精确 name pattern 运行 schema/store 中受影响的 12 项；不能将此处数字表述为整个旧套件或完整 Core 已通过。完整 Core、HTTP 慢 body、race/kill、Browser 与 Linux CI 由主代理的最终集成门禁覆盖。

## 冻结字节

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `core/src/acceptance/browser-operation-schema.mjs` | 20848 | bb088bea4986339d8bee957346a1e088ed1a6e3d159a56db98bc4fc5fccaf062 |
| `core/src/acceptance/browser-operation-store.mjs` | 45751 | dd00e2ecf730637e6243c254907c0e75d1f6c8e66265005cd6221ec089496f5a |
| `core/test/acceptance-browser-operation-decision.test.mjs` | 22326 | 20d1d5b7c6d22c5b47bdf1f31beea28efce8095d1cd4ddca1cce7d70c15cf262 |
| `core/test/acceptance-browser-operation-schema.test.mjs`（未修改） | 5910 | c59a8456ab370bfefd0fabc416d6183b05b77aa1cb29c050f3e61071adfc3542 |
| `core/test/acceptance-browser-operation-store.test.mjs`（未修改） | 23798 | 0bf03ff0c29177a7b91f564a66d8e20092be24c6e4a9d1920ae323965da355f4 |
| `core/test/fixtures/acceptance-browser-start-resolution-vectors.json`（其他代理创建，本范围未改） | 11549 | 956b1bf6143b8d15399083e94d6ac4398c5ac12c92fb3be3fee2b096d22042b7 |

## 开发失败原件与边界

- 开发期缺少 pngjs 的 import 失败没有进入业务断言，不计为实现通过证据。
- 初次旧套件曾因 hardlink 错误 reason 与旧契约不一致失败；当前实现已恢复 `FILE_UNSAFE`，本轮受影响旧测试通过。初次进程加载旧模块时的输出不作为最终冻结通过。
- sibling `d4-store-schema-20261017-d953bf1e-0c28-4d49-af6a-01efbd1b0125` 是早期新增 14 项通过的原件，不代替本轮 16 项。
- sibling `d4-store-final-20261017-575c9034-e571-4846-a0f4-8808ba304c6d` 保留 15 pass / 1 fail 的完整原件；失败为新增测试夹具清理空目录使用 `rmSync(path)` 触发 `ERR_FS_EISDIR`。获主代理授权后，仅将测试清理改为 `rmdirSync`，产品源码未变；随后才生成本目录全部通过结果。
- Windows 的 Node 不提供 portable directory fsync。本实现对文件内容执行 fsync，Linux 路径另加目录 fsync；本次不宣称整机掉电耐久性已验证。永久拒绝的保证限定为保留拒绝事实的同一真实数据根及正常进程重启。

## 独立接线复审

service / API / engine 的两处独立审查发现已由主代理修复，并使用真实临时 owner/store/runtime 复验。修后稳定证据与说明位于 sibling `d4-service-independent-recheck-20261017-a5eaa018-f8a1-4712-8278-50364f8ee86a/review.md`：foreign project 的旧 GET 为 404；真实拒绝提交后再遇 store 与 lease release 双异常，最终 503 仍保留 `writeMayHaveCommitted:true`，拒绝 proof 可读。该复核也不替代主线完整门禁。
