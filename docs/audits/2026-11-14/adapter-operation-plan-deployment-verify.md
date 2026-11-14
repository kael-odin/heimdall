# 适配器交付包操作计划复测

日期：2026-11-14。

## 结果

对一个本地受控的有状态适配器交付包执行最终包验收。Docker 镜像来自交付包本身；授权操作计划和 HTTP 检查文件均放在包外，只通过参数传入：

```powershell
node core/src/cli.mjs live-verify `
  'D:\Github-Star\heimdall-evidence-archive\2026-11-14\deployment-operation-plan-20261114\bundle' `
  --site-id adapter-operation.test `
  --report 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\deployment-operation-plan-20261114\deployment-verification.json' `
  --http-checks 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\deployment-operation-plan-20261114\plans\http-checks.json' `
  --operation-plan 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\deployment-operation-plan-20261114\plans\operation-plan.json' `
  --observe-ms 1000 --timeout-ms 180000
```

| 检查 | 结果 |
| --- | --- |
| Docker 网络 | `network none` |
| 启动与重启 | 两次通过 |
| 授权 HTTP 写入 | 1/1，HTTP 201 |
| 重启后读回 | 1/1，HTTP 200，数据一致 |
| 最终镜像 `/app` 快照 | 校验和与交付包一致 |
| 浏览器操作计划 | 1/1，0 失败，0 未测 |
| 操作范围 | 点击 `#save` 后断言结果文本；计划值不进入报告 |
| 运行时缺口账本 | 新路径 0；响应正文缺口和未验证写入仍按报告保留 |

首次运行故意使用了错误的 JSON Pointer `/items/0/name`，验收在 `afterRestart` 阶段明确失败；改为数组根路径 `/0/name` 后通过。这确认失败阶段、检查 ID 和安全断言差异仍能定位实际验收计划错误。

报告位于外部归档：

```text
D:\Github-Star\heimdall-evidence-archive\2026-11-14\deployment-operation-plan-20261114\deployment-verification.json
```

## 边界

操作计划复测的是最终镜像文件系统对应的服务代码，浏览器运行在宿主验收环境中；Docker 内部的写入和重启读回由 `--http-checks` 单独证明。该受控案例不证明生产认证、权限矩阵、完整状态机、真实副作用或所有适配器路由的等价性。
