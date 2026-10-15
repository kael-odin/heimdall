# 命名登录态的操作依赖对照

日期：2026-10-16

## 结论

本次把操作流程从“整站共用一份登录态”扩展为“每条 flow 可声明一份命名登录态”：

- `sessionPath(host, name)` 默认仍指向 `session.json`
- 命名会话保存为 `session.<name>.json`
- `login` 支持 `--session <name>`
- `operation-plan` 的 `flows[].sessionName` 可声明该 flow 使用哪份登录态
- 源站采集按 flow 取对应登录态
- 缺失的命名会话会作为 `sessionMissing` 显式失败，不会静默退化成匿名访问
- `sourceOperationProbe` 的每条 flow 会记录 `sessionName` 和 `sessionUsed`

这不表示离线包已经复刻登录业务；它只表示源站依赖观察现在能区分不同会话状态。

## 验证

定向测试：

```powershell
pnpm -C core exec node --test test/session-store.test.mjs test/source-operations.test.mjs test/live-operation-probe.test.mjs test/live-source-operation-export.test.mjs
```

结果：

- 命名会话与默认会话互不覆盖
- 非法 session 名直接拒绝
- `admin` / `guest` / `missing` 三个 flow 分别按各自登录态执行
- 缺失命名会话被记为 `sessionMissing`
- 严格导出能从 `session.admin.json` 加载命名会话并在 `sourceOperationProbe` 里回显 `sessionName`

## 边界

- 目前只支持“每条 flow 使用一份已保存登录态”
- 不支持在同一条 flow 内切换会话
- 不保存 Service Worker 缓存或浏览器内存态
- 离线包没有源站登录态；认证业务仍需本地适配器或获授权的登录实现单独验收
