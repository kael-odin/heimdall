# 首次公开包独立核验：失败记录

本报告对应 2026-10-18（香港时间）的首次公开包独立核验。真实进程退出码为 1，verifier summary 状态为 failed，错误为 Public binary preservation attributes differ。本报告不宣布整包通过。

严格公开包的 .gitattributes 实际为 9 字节 CRLF，hex 2a202d746578740d0a；独立 verifier 要求 8 字节 LF。采集器当时通过 write_text 写入且未指定换行参数，与 Windows 文本换行转换结果一致。这里只读确认并保存事实；本审查未改 collector、verifier、严格公开包或任何原件。

失败点之前，verifier 对归档、原件、索引、gate source manifests、direct copies 和 public 文件集合的检查未抛错。失败点之后的 Core 原生统计、既有八文件 raw Git blob 和 D5 严格 Browser 阶段没有执行，因此不能把后续阶段归为本次主核验通过。

observed-facts.json 另外保存只读补充观察。最终 Core 的唯一 Node spec 原生汇总为 tests 2661、pass 2649、fail 0、cancelled 0、skipped 12、todo 0。629 来自该 Core 原摘要完整 before 清单；621 是其中剔除 8 个 console/dist 文件后的数量，并与绑定该 Core 摘要 SHA 的 staged source review 621 行相符。八个既有 verifier 文件与基准提交 5006e16bf73e47f36877da24df4ac4a5c8207965 的原始 Git blob 逐字节相等。

D5 原摘要记录 passed=true、10 checks、0 page errors、3 console messages 和 3 个受控响应（lost-create 502、lost-close 502、stale-facts 409）；请求原件记录 Browser POST 4、actions GET 2、真实 browser-executions POST 6 和 register-result POST 6。四张 PNG 的 SHA、字节数和尺寸已只读解析；本轮没有重新启动 Browser、测试或引擎，也没有人工目视验收图片。上述 D5 数值属于额外观察，不能替代主 verifier 完整成功。

summary.json、review.md、stdout.log、stderr.log 与 execution.json 均是 ignored 独立输出目录中同名原文件的原字节副本，逐字节比较相等。publication-manifest.json 保存本次失败报告集合的明确文件名、bytes、SHA；其自身 SHA 在协调消息中提供以避免自引用。后续重新采集和独立核验应保留此失败集合，在新的子目录另存结果。
