# 验收运行对比

此前：ac-7e7479b4-3d7c-4760-978b-54bb43318aeb · API before · 原门禁 failed
本次：ac-bd416be3-bd0e-41ca-b82c-01320dbb005c · Renamed API run · 原门禁 failed
对比状态：受阻

检查 2；仍失败 0；可靠复验通过 0；新增失败 0；本次观测失败 0；持续通过 0；本次观测通过 0；未复验 2；不可比 0。

## 证据完整性

| 运行 | 完整性 | 证据验证 | 文件数 | 字节数 |
| --- | --- | --- | ---: | ---: |
| 此前 | 通过 | 通过 | 6 | 2611 |
| 本次 | 未通过 | 未通过 | 5 | 2621 |

- 本次 EVIDENCE_DIGEST_MISMATCH（spec-2-quota-response.json）：证据字节与完成时的索引不一致。

## 检查对比

| 检查 | 路由 | 视口 | 维度 | 此前检查 | 本次检查 | 对比结果 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Renamed contract | /quota | API | contract | spec-1-quota | spec-2-quota | 未复验 | after-evidence-integrity: after 当前报告及引用证据未通过完整性验证（EVIDENCE_DIGEST_MISMATCH）。 |
| Renamed contract | /items | API | contract | spec-2-items | spec-1-items | 未复验 | after-evidence-integrity: after 当前报告及引用证据未通过完整性验证（EVIDENCE_DIGEST_MISMATCH）。 |

## 边界

- 仅对比用户明确选择的两次运行；此前/本次是选择标签，不自动批准项目基线，也不改写原门禁。
- 可靠复验通过针对整个相同合同、操作点或检查，不推断子失败根因相同，不自动关闭持久问题。
- 未测、删除、受阻、待复核及不可比均不算修复；精确参考截图哈希变化会保守停止视觉趋势比较。
- after-evidence-integrity：after 当前报告及引用证据未通过完整性验证（EVIDENCE_DIGEST_MISMATCH）。
