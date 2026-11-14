# `example.com` 静态交付包独立断网验收

日期：2026-11-14。

## 结果

对已经通过 strict 的公开单页 `example.com` 交付包执行：

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\public-handoff-example-strict-20261114'
node core/src/cli.mjs live-verify `
  'D:\Github-Star\heimdall-evidence-archive\2026-11-14\public-handoff-example-strict-20261114\deliverable\example.com-live-2026-11-14' `
  --static --site-id example.com --observe-ms 1000
```

| 检查 | 结果 |
| --- | --- |
| Docker 网络 | `network none` |
| 启动次数 | 2 次 |
| live 页面路由 | 1/1 通过 |
| 根路由与健康检查 | 通过 |
| 原工作区进入镜像 | 未发现 |
| 证据 | `workspace/example.com/deployment-verification.json` |
| 站点评估 | `independentDeployment=verified` |

报告绑定交付包的 `checksums.json`。修改包内文件后，`site-assessment` 会重新标为未知，不会复用旧的独立部署结论。

## 边界

这次只证明静态页面包能在无外联容器中启动、重启并访问已交付页面。它不证明认证、权限、API、写入、状态机、持久化或业务副作用；这些能力仍需适配器和授权旅程验收。
