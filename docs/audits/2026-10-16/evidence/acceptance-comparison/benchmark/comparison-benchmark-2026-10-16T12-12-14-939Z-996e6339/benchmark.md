# 验收运行对比固定反例基准

运行：comparison-benchmark-2026-10-16T12-12-14-939Z-996e6339
生成时间：2026-10-16T12:12:39.988Z

**离线复现：本机固定版本、缺陷和假关闭反例，通过真实 browser/Spec runner、store 落盘与当前证据校验完成；只证明本组声明范围，不代表真实项目检出率、根因识别或持久缺陷自动关闭。**

基准门禁：通过；固定反例 12/12；真实运行 12；耗时 25049 ms。

统计单位是固定比较反例；修复、新增、缺测、不可比和篡改分别有明确真值，不把检查数转换成真实项目检出率。

| 反例 | 校验 | 真值与边界 | 问题 |
| --- | --- | --- | --- |
| browser-reordered-fixed-and-new | 通过 | 真实浏览器：计划重排仍配对，原视觉和按钮问题复验通过，另一操作点出现新增失败。 |  |
| partial-viewports-do-not-close-phone | 通过 | 仅桌面通过不能关闭旧手机视口问题；每个视口独立保留复验事实。 |  |
| deleted-route-is-unverified | 通过 | 删除原失败路由不算修复。 |  |
| same-url-reference-drift-incomparable | 通过 | 相同参考 URL 被改成目标外观后视觉通过，也不能证明旧视觉问题已修复。 |  |
| api-reordered-fixed-and-new | 通过 | 真实 Spec：合同重排、目标版本和来源标题变化不破坏身份；一个合同修复，另一合同新增失败。 |  |
| same-contract-still-failed | 通过 | 同一合同仍违反断言，保持仍失败。 |  |
| weaker-criteria-incomparable | 通过 | 删除 JSON 业务成功断言后通过属于判据变化，不属于修复。 |  |
| changed-source-incomparable | 通过 | 同合同的来源版本变化，必须保留不可比原因。 |  |
| deleted-contract-is-unverified | 通过 | 删除旧失败合同不能算修复，也不能由健康 HTTP 状态替代业务断言。 |  |
| execution-limit-is-not-fixed | 通过 | 同规则下的响应预算阻塞不能关闭此前 BUG。 |  |
| tampered-evidence-blocks-retest | 通过 | 完成后响应证据被修改，即使历史 gate 仍在，也必须阻止复验修复声明。 |  |
| original-gates-and-reports-unchanged | 通过 | 比较和证据验证不改写原报告或原门禁；篡改反例恢复原证据后仍能通过完整性校验。 |  |

## 比较报告

- [browser-reordered-fixed-and-new](comparisons/browser-reordered-fixed-and-new.md)：JSON 同目录保存。
- [partial-viewports-do-not-close-phone](comparisons/partial-viewports-do-not-close-phone.md)：JSON 同目录保存。
- [deleted-route-is-unverified](comparisons/deleted-route-is-unverified.md)：JSON 同目录保存。
- [same-url-reference-drift-incomparable](comparisons/same-url-reference-drift-incomparable.md)：JSON 同目录保存。
- [api-reordered-fixed-and-new](comparisons/api-reordered-fixed-and-new.md)：JSON 同目录保存。
- [same-contract-still-failed](comparisons/same-contract-still-failed.md)：JSON 同目录保存。
- [weaker-criteria-incomparable](comparisons/weaker-criteria-incomparable.md)：JSON 同目录保存。
- [changed-source-incomparable](comparisons/changed-source-incomparable.md)：JSON 同目录保存。
- [deleted-contract-is-unverified](comparisons/deleted-contract-is-unverified.md)：JSON 同目录保存。
- [execution-limit-is-not-fixed](comparisons/execution-limit-is-not-fixed.md)：JSON 同目录保存。
- [tampered-evidence-blocks-retest](comparisons/tampered-evidence-blocks-retest.md)：JSON 同目录保存。

## 原始运行

- [browser-before](runs/ac-3ea01809-fd5c-4dc5-baa1-ba3ebec70512/report.md)：原门禁 failed，检查 28。
- [browser-after-reordered](runs/ac-62a23a6e-7182-4d2a-b6e6-9b56ccac6836/report.md)：原门禁 failed，检查 28。
- [browser-desktop-only](runs/ac-fa633d4a-5ed1-487a-92e3-fa82697ed20e/report.md)：原门禁 failed，检查 14。
- [browser-deleted-route](runs/ac-299d0b09-3b50-472b-9fc8-c2434f408de5/report.md)：原门禁 failed，检查 14。
- [browser-same-url-reference-drift](runs/ac-a39b2f30-8bd8-4543-815a-97bdb05313e5/report.md)：原门禁 failed，检查 7。
- [api-before](runs/ac-7e7479b4-3d7c-4760-978b-54bb43318aeb/report.md)：原门禁 failed，检查 2。
- [api-after-reordered](runs/ac-bd416be3-bd0e-41ca-b82c-01320dbb005c/report.md)：原门禁 failed，检查 2。
- [api-still-failed](runs/ac-1de9b23c-14dd-4e31-b914-27d2248bfc54/report.md)：原门禁 failed，检查 2。
- [api-weaker-contract](runs/ac-25515d44-458f-424d-b7f0-79593f50eccb/report.md)：原门禁 passed，检查 2。
- [api-source-revision-changed](runs/ac-cce9e13d-5836-4e07-92f7-5ec55795cd20/report.md)：原门禁 failed，检查 2。
- [api-deleted-contract](runs/ac-b9453ee8-eccd-444f-b546-95be95a464f5/report.md)：原门禁 failed，检查 1。
- [api-response-budget-blocked](runs/ac-3b4042fc-2c9d-4cd8-bc1d-9aefe3ad4d7b/report.md)：原门禁 blocked，检查 2。

## 边界

仅访问本机临时夹具，退出时关闭服务器。报告和证据保留；历史端口不可继续访问。对比结果只引用检查状态和原因，不改写原报告、门禁或批准状态。部分视口复验只对其自身成立；旧尺寸或缺失检查不能继承通过。

证据篡改反例只修改本次基准自己的响应证据，保存当前完整性校验结果后恢复原字节；不触碰其他历史运行。
