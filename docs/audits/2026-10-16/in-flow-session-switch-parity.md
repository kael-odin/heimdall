# 同一操作流内的会话切换

日期：2026-10-16

## 结论

本轮把源站操作观察从“每条 flow 只能绑定一份登录态”扩展为“同一 flow 内可显式切换会话”：

- 新增 action：`{"type":"useSession","sessionName":"admin"}`
- `sessionName: null` 表示切回匿名上下文
- 源站采集按切换点拆分段落，每段使用新的浏览器上下文，并从上一段当前 URL 继续
- `sourceOperationProbe.flows[].sessionSwitches` 记录脱敏的切换点、会话名与是否实际使用会话
- 缺失命名会话仍记录 `sessionMissing`，不会静默退化为匿名
- 离线包只支持匿名切换；命名会话记录 `sessionUnsupported` 并阻断 strict 发布

这不表示离线包已实现登录、会话延续或账号业务。命名会话切换要等本地适配器提供获授权的独立登录实现后再验收。

## 验证

定向测试：

```powershell
pnpm -C core exec node --test test/live-operation-probe.test.mjs test/source-operations.test.mjs test/live-source-operation-export.test.mjs
```

覆盖：

- `useSession` 的计划格式与非法会话名拒绝
- admin → guest 同 flow 切换后，guest 无法通过仅 admin 可见的断言
- 缺失命名切换记录 `sessionMissing`
- 离线匿名切换可通过 strict 导出
- 离线命名切换与 flow 级命名会话均以 `sessionUnsupported` 阻断
- 计划与会话文件不进入交付包

## 边界

- `useSession` 会关闭并重建浏览器上下文，不能保留内存态、Service Worker 缓存或未完成的请求
- 切换后从上一段当前 URL 重新导航，无法保留未提交的表单内存状态
- 同一 flow 内可以多次切换，但每段仍受只读采集限制
- 离线包没有源站登录态；命名会话必须 fail-closed
