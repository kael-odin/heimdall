# 验收运行对比固定反例基准

运行：comparison-benchmark-2026-10-18T03-34-56-780Z-d412eaa7
生成时间：2026-10-18T03:35:37.864Z

**离线复现：本机固定版本、缺陷和假关闭反例，通过真实 browser/Spec runner、store 落盘与当前证据校验完成；只证明本组声明范围，不代表真实项目检出率、根因识别或持久缺陷自动关闭。**

基准门禁：通过；固定反例 12/12；真实运行 12；耗时 41084 ms。

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

- [browser-before](runs/ac-c4972769-8b5b-46d5-9724-724c6ed9bd55/report.md)：原门禁 failed，检查 28。
- [browser-after-reordered](runs/ac-f832354d-9f0f-4a50-a44c-b3d900b05367/report.md)：原门禁 failed，检查 28。
- [browser-desktop-only](runs/ac-1f6dd565-d172-4e26-9f27-5ca1bf953019/report.md)：原门禁 failed，检查 14。
- [browser-deleted-route](runs/ac-6081a04b-aa0b-48ad-bda0-8108922405f4/report.md)：原门禁 failed，检查 14。
- [browser-same-url-reference-drift](runs/ac-e28da32d-9aa6-4c33-9a18-6e410a5d8211/report.md)：原门禁 failed，检查 7。
- [api-before](runs/ac-259bca6b-c730-4668-87f6-a9a7322f10dc/report.md)：原门禁 failed，检查 2。
- [api-after-reordered](runs/ac-7bc5f804-f95d-430c-aab3-d17e8ab7eb82/report.md)：原门禁 failed，检查 2。
- [api-still-failed](runs/ac-51b1abe7-9794-4e64-8fb5-3171db361ad8/report.md)：原门禁 failed，检查 2。
- [api-weaker-contract](runs/ac-f990ddf6-6192-4261-8e57-e90171559c86/report.md)：原门禁 passed，检查 2。
- [api-source-revision-changed](runs/ac-34960a55-bb24-49fe-8d90-9c6bd3a994c5/report.md)：原门禁 failed，检查 2。
- [api-deleted-contract](runs/ac-e67167d4-0771-4fe0-8c83-936eb03201a0/report.md)：原门禁 failed，检查 1。
- [api-response-budget-blocked](runs/ac-9ade5f6c-564e-4c06-9352-bd05094fb7d6/report.md)：原门禁 blocked，检查 2。

## 边界

仅访问本机临时夹具，退出时关闭服务器。报告和证据保留；历史端口不可继续访问。对比结果只引用检查状态和原因，不改写原报告、门禁或批准状态。部分视口复验只对其自身成立；旧尺寸或缺失检查不能继承通过。

证据篡改反例只修改本次基准自己的响应证据，保存当前完整性校验结果后恢复原字节；不触碰其他历史运行。
