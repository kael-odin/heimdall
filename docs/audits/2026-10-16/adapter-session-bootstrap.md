# 适配器会话引导

日期：2026-10-16

## 结论

离线操作探针现在可以通过逐站适配器显式初始化命名会话：

- `runtime-adapter/manifest.json` 新增可选 `sessions` 字段
- 每个会话名映射到一条已声明的 `POST` 路由
- 命名会话开始前，探针先请求该本地路由
- 适配器返回 2xx 和 `Set-Cookie` 时，cookie 注入新的离线浏览器上下文
- `sessionName: null` 仍表示匿名上下文

会话引导失败时，探针记录 `sessionUnsupported`，strict 导出保留候选包并阻断发布。`health.adapter.sessionRoutes` 报告 declared / initialized / failed，`strictBlockers.adapterSessionRoutesFailed` 单独计数。

## 边界

- 这只是本地会话引导，不是通用登录服务
- 适配器必须由操作者为授权站点编写并审核
- 会话 cookie 只存在于探针上下文，不写入 `health.json` 或交付包
- 本地引导请求不参与 `--compare-source` 的源站/离线依赖等价
- 独立登录、会话延续、写入业务和真实账号等价仍需逐站适配器与授权验收

## 验证

定向测试：

```powershell
pnpm -C core exec node --test test/live-adapter-session-bootstrap.test.mjs test/live-runtime-adapter-export.test.mjs test/live-operation-probe.test.mjs test/live-source-operation-export.test.mjs
```

覆盖：

- manifest 合法 / 非法会话路由
- 命名会话初始化成功
- `useSession:null` 与 `useSession:"admin"` 的同 flow 切换
- 缺失会话路由时 `sessionUnsupported`
- 适配器无 `Set-Cookie` 时 `sessionUnsupported`
- `--compare-source` 不把本地会话引导算进依赖等价
