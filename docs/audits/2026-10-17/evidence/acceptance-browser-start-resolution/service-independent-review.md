# D4 Service / API / Engine 独立复审

日期：2026-10-17。范围：只读检查 D4 resolution / deny-start 接线，并使用真实临时 owner、store、runtime 构造两处异常边界的离线复现。没有启动 Browser、HTTP server 或全量 Core；没有修改产品源码、旧 D3 原件或暂存区。

## 当前结论

本次审查提出的两个问题均已由主代理修复，并通过新的隔离断言复验。本范围未发现新的阻断。该结论不代替后续 HTTP 慢 body、Browser 主线、完整 Core 或平台 CI。

1. 旧执行操作入口原先直接调用 `store.read`，会在项目归属检查前对已拒绝 bo 返回 `BROWSER_START_REJECTED`。主代理改为使用 `inspect` 先验证归属，并只允许 recorded 进入旧执行接口。复验中，foreign project 查询同一实际已拒绝 bo 返回 `NOT_FOUND / 404`，原项目专用 resolution 仍读到 rejected。
2. 拒绝实际提交后 store 抛 `writeMayHaveCommitted:true`，再遇 lease release 异常时，原 `published` 标志尚未置位，finally 会丢掉未知提交标记。主代理增加 `commitMayExist` 合并异常事实。复验将拒绝真实持久化，然后精确注入两个异常；最终 `BROWSER_EXECUTION_UNAVAILABLE / 503` 保留 `writeMayHaveCommitted:true`，runtime 为 blocked、非 busy，原拒绝 proof 仍可只读获取。

## 静态核对

- 已有 recorded / rejected 在当前 catalog、readiness、busy、blocked、closing 与新的 reserve 之前读取。持槽后的再次检查仍优先返回新出现的已有事实。
- resolution 不调用 `ready` / capability、runtime 写方法、来源物化、recover 或 runner。absence / pending 只返回 unresolved。
- 新拒绝验证原六字段，允许原 generation 内 revision 变化；新 generation 未核验则拒绝。新决定使用自己的 runtime lease，不 bind run/task，不停止或释放其他执行。
- deny 的持槽发布段同步执行；owner、active lease、pending / handles 和 scope 由同步 guard 重核。store 提交或回读不明会 block，finally 保留未知事实并仅释放本次 lease。
- execute 的首读及异常 settlement 分支识别 rejected；已知拒绝不能落入新 runner 或 running settlement。
- API 对有效 action 的方法分类正确：resolution 仅 GET，deny-start 仅 POST；继续保持 fatal UTF-8、object-only、16 KiB body、精确 query 和 no-store。
- engine 的恢复门禁只为精确 POST deny-start 路径留出已有事实优先入口；owner 与鉴权仍在前，新的拒绝仍由 service 的 ready / scope / reserve 限制。
- 受控错误投影通过 own data descriptor 读取安全字段，不将私有路径、异常消息或未核验 payload 暴露为解除依据。

## 证据与冻结字节

新复验见本目录 `reproduce.mjs`、`stdout.log`、`stderr.log`、`summary.json`。结果 exit 0，四文件 source-before / after 完全相同：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| browser-execution-service.mjs | 16039 | 5089365950c3b455d9b95c54f42cf3bacfb291049ab2ea5211013fe2b57378bf |
| browser-execution-api.mjs | 7449 | 0f56f186f436cd2c17e42cfcaf8d1317e36f3829296842bc3c5e0f810aaba22f |
| engine-server.mjs | 132926 | 17b6585a407cd7686966b85a01777e7f443df36f2764ee49bba004119184e971 |
| browser-operation-store.mjs | 45751 | dd00e2ecf730637e6243c254907c0e75d1f6c8e66265005cd6221ec089496f5a |

旧缺陷复现保留在 sibling `d4-service-independent-review-20261017-b5f3041b-ac98-4f37-9e79-dc5bfeb0b4cc`。其运行期间主代理正在修 service，前后源码不同，所以仅作为旧加载模块的缺陷复现，不作为冻结通过证据。

Windows 的 Node 目录 flush 限制仍依照 store 源码明确保留：文件内容执行 fsync，不宣称已验证整机掉电耐久性。新永久拒绝保证继续限定为保留拒绝事实的同一真实数据根及正常进程重启。
