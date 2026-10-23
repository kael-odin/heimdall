# D3 最小 Spec 验证器兼容补丁：独立只读审查

日期：2026-10-17（Asia/Hong_Kong）。结论：未发现阻断该最小兼容补丁的缺陷。当前新增固定 LF/CRLF 摘要与共享十文件 manifest 一致；Spec 仍在共享 Browser 执行之前委托原 Spec runner，原证据、oracle、identity 与来源资格校验没有随白名单扩展被放宽。

## 范围与证据等级

本审查只读查看以下三个文件的当前 Git diff：

- `core/src/acceptance/candidate-projection.mjs`
- `core/test/acceptance-candidate-projection.test.mjs`
- `core/test/acceptance-managed-spec-plan.test.mjs`

并读取共享 `core/test/fixtures/browser-verifier-reviewed-d3.json`、共享 runner 的 Spec 委托边界、store 的历史指纹算法和投影器完整证据/oracle 校验。独立重算当前十文件的 LF/CRLF 摘要及逐文件摘要，并与 manifest 的 reviewedParent Git 原件比较。没有修改产品源码、启动 Browser 或重复主代理正在执行的完整回归。

主代理报告的 80/80 和边界 10/10 属于主代理运行结果；本审查不将其写成自己重跑的测试。11 组最终发布门禁仍以主代理最终原件为准。

## 实际核对结果

1. **产品逻辑 diff 是固定兼容集合扩展。** `candidate-projection.mjs` 只新增说明和两条 literal hash，保留既有四条。没有改 `verifySpecBaselineMaterial` 的字段、文件、预算、摘要、source、approval、coverage、identity、oracle 或 contract 校验，也没有从当前 checkout 自动推导支持集合。
2. **指纹算法与真实 store 一致。** store 将九个 acceptance 源文件用 LF 分隔，再直接附加 compare 源文件；测试按该历史算法重算，没有偷偷改变 separator。当前原始字节 fingerprint 等于已登记的 D3 LF fingerprint，混合或未知字节不被当前字节断言接受。
3. **共享 manifest 的 20 个逐文件 LF/CRLF 摘要全部匹配。** 相对 reviewedParent `007760ed80019b4a5369ab284ea7ba734f18d0d2`，规范为 LF 后只有 `runner.mjs` 改变；其他九文件逐字一致，其中 `spec-runner.mjs`、`spec-schema.mjs`、`response-schema.mjs`、`identity.mjs` 均未变。
4. **Spec 委托仍在 Browser 执行边界之前。** `runAcceptance` 的 `plan.mode === 'spec'` 分支直接返回 `runSpecAcceptance(plan, {runId, outputDir, onEvent})`；新的 fixed bridge、Browser settings/observe、launch、固定来源 oracle 与环境降级分支不进入这个 Spec 调用路径。
5. **新增 delegation 测试比较实际结果。** 对 draft 与 approved 两类 plan，测试直接 Spec 与共享入口使用相同 runId，删除报告中时钟字段后深比较整份 report、比较 events，并逐文件比较全部 evidence 字节。approved 的 healthy/bug verdict 和 draft 的 blocked/needs_review 被明确断言；draft 请求数为 0，approved 两次执行共 4 次 HTTP 请求。chromium.launch 被替换为立即抛错并最终断言调用次数为 0。
6. **任意新版本仍失败。** 测试分别在 shared runner 与 spec-runner 的源码字节中追加未审查内容，计算所得新 fingerprint 必须不在支持集合，来源投影仍以 `SOURCE_VERIFIER_UNSUPPORTED` 拒绝。支持集合被完整 literal 数组断言为六条，未变成前缀、宽泛正则或运行时信任。
7. **来源证据与 oracle 保持独立核验。** 投影器仍核对 manifest/report 原字节摘要、规范计划、source/contract fingerprint、approval、精确 scope 与 summary；读取 evidence 时独立核对 length/SHA；重建 Spec check identity、rule 和 oracle，并核对 contract/source 原文。支持某个 verifier 摘要不会绕过这些条件。

## 本次独立重算值

| 项 | 结果 |
| --- | --- |
| 当前原始字节十文件 fingerprint | `2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337` |
| D3 LF fingerprint | `2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337` |
| D3 CRLF fingerprint，分隔符仍 LF | `270251e1ca417383ee019a456d1a103ec461c57a9a8c661fdc9ff562cac515f2` |
| runner LF SHA-256 | `c0f249bd45b1f3b5e42383297b332fa57f126605b809e09eac7b781ee058cc57` |
| runner CRLF SHA-256 | `9fe4bcbe16c216abbc51f007d15b9af0bd28f14bcfb90d1a6dba65b12cd80982` |
| manifest 逐文件重算 | 10/10 LF + 10/10 CRLF 匹配 |
| reviewedParent 除 runner 外原件比较 | 9/9 LF 规范字节未变 |
| 支持集合 | 原四条保留，新增两条，共六条 |

本次只读脚本初次将含 `../verify` 的磁盘路径直接传给 `git show`，Git 对未规范化对象路径报错；改用 posix.normalize 后重算成功。该错误是审查工具路径处理问题，不是产品缺陷，也没有触发源码修改或任何测试执行。

## 边界

- 这是明确审查过的版本映射，不是签名认证。未知历史 fingerprint、未来源码改动和混合换行组合不能因此被当成语义兼容。
- “其他九文件未变”以 manifest 的 reviewedParent 为比较基准；并未宣称 shared Browser runner 本身字节未变。
- 新的对比测试覆盖 draft/approved 与 match/bug 的委托行为；取消、超时、完整来源闭环及所有外部站点能力不能只凭这一个测试宣称通过，继续由既有专项测试和主代理最终门禁覆盖。
- 此补丁不改变 Browser 固定来源验收、全局 selection/approval、Spec 的显式批准语义或业务问题最终关闭。

Review 结论：允许保留这组最小固定指纹补丁，最终发布仍等待主代理冻结版本的完整门禁结果。
