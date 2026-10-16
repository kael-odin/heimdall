# 首次夹具缺少凭据 seed 的失败

原件目录：`core/workspace/_runs/execution-ui-9c53b5b5-9d8d-48a1-b9c2-c39167944332`。`failure.json` 为逐字节副本，状态为 failed，不能计为功能通过。

late-cancel 场景创建新 browser context 后，没有先 seed 要选择的旧完成 operation receipt，随后 selectOption 在原有 15000ms 时限内找不到该操作选项。修正夹具 seed 后重跑；业务断言和超时时限没有放宽。此处保留该失败，不将其改写为产品缺陷或合并到最终 16 项通过。原目录中的截图、DOM、日志与 JSON 均未删除。

证据限制：失败轮没有独立冻结当时 smoke 源文件。缺 seed 的分类结合 failure／原 failure DOM、当前修正的 `seedReceipt(firstReceipt)` 路径及主代理提供的测试过程；不能从最终源码单独还原该次失败全部执行字节。
