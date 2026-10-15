# 操作依赖的 frame 归属与延迟请求门禁

日期：2026-10-16

## 结论

本次把操作依赖对照从“只看请求身份”扩展到“同时看请求来自哪个 frame”，并给最后一个状态之后增加一个显式观察窗口：

- 请求记录新增 `frame: main | subframe | unknown`
- iframe 内发起的请求会归为 `subframe`
- Shadow DOM 内发起的请求仍按网络层归为 `main`
- 最后一个状态捕获之后才出现的请求会计入 `lateRequests` 和 `lateRequestCategories`
- 源站采集与离线探针都会把 `lateRequests > 0` 判为失败
- 依赖等价比较把 frame 维度纳入精确请求身份；同一个 URL 从主 frame 和 iframe 发起不再被误判为等价

这不表示业务结果已经等价，只表示依赖观察范围比之前更完整。

## 验证

定向测试：

```powershell
pnpm -C core exec node --test test/state-graph.test.mjs test/source-operations.test.mjs test/operation-dependency-parity.test.mjs
```

结果：

- 30 个测试全部通过
- 真实浏览器用例确认 iframe 请求归为 `subframe`
- 真实浏览器用例确认 Shadow DOM 请求归为 `main`
- 延迟请求不会并入前一个状态，且会让源站采集失败

受影响链路复验：

```powershell
pnpm -C core exec node --test test/live-operation-probe.test.mjs test/live-source-operation-export.test.mjs test/reviewed-operation-states.test.mjs
pnpm lint
```

结果：

- 6 个导出/探针/审查测试全部通过
- 语法检查 283 个文件全部通过

## 边界

- 多会话状态仍未覆盖；当前每个 flow 仍是独立浏览器上下文，但没有跨会话状态维度
- `lateRequests` 只统计最后一个状态之后、观察窗口之内的请求；窗口之外仍无法保证
- frame 归属只区分主 frame 与 subframe，不记录完整 frame URL，避免泄露私有路径
- 请求等价仍不比较静态资源正文，也不证明业务结果一致
