# B3 业务规则响应头断言实测

日期：2026-11-16。范围：现有受控本地 B3 夹具；没有读取或写入生产认证材料。

## 结果

| 检查 | 结果 |
| --- | --- |
| `expect.headers[].equals` 核对 `X-Content-Type-Options: nosniff` | 通过 |
| `expect.headers[].exists=false` 核对缺失 `X-Powered-By` | 通过 |
| 错误响应头值转成 `unexpected_header` | 通过 |
| 响应头实际值进入 `backend-check.json` | 未发现 |

实现复用了现有 `state-rules.json`、业务规则执行器和脱敏报告格式，没有新增依赖。每项断言只允许 `exists`、`equals` 或 `contains` 一种模式；`Authorization`、`Cookie`、`Set-Cookie` 等敏感头不能写入断言，失败结果只保留头名称。

验证命令：

```powershell
pnpm -C core exec node --test test/agent-backend-scaffold.test.mjs
```

结果：6/6 通过。

该案例只证明受控 HTTP 响应头可以进入业务规则复测；它不证明真实 CDN、反向代理、浏览器缓存、安全策略或跨节点响应头等价。
