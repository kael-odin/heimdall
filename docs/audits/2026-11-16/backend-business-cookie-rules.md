# B3 业务规则 Cookie 会话实测

2026-11-16。为补齐生成 `checks.mjs` 对授权业务旅程的复测能力，在现有 B3 脚手架夹具中加入登录、读取、Cookie 轮换、退出和 3xx 重定向流程。

## 结果

| 场景 | 结果 |
| --- | --- |
| 登录响应设置 Cookie，后续读取自动带 Cookie | 通过 |
| 同名 Cookie 轮换后继续读取 | 通过 |
| `Max-Age=0` 退出后再次读取 | 通过，返回 401 |
| `redirect: "manual"` 保留 302、核对 `Location` 并继续使用响应 Cookie | 通过 |
| Cookie 值进入 `backend-check.json` | 未发现 |
| 每条规则之间共享会话 | 不共享 |

实现复用了现有 `state-rules.json` 和业务规则报告格式，没有新增依赖或独立执行器。Cookie 只在单条规则的内存 jar 中流转，按路径和 Secure 属性筛选；报告只保留规则 ID、身份标签、步骤、状态和断言位置。

本次受控夹具的 9 条业务规则全部通过 `business-rules-only` 复测，原有写入后读回和匿名/所有者/非所有者/无效凭据规则继续通过。该证据覆盖会话传递和确定性 HTTP 行为，不证明生产密码认证、OAuth/MFA、服务端撤销、并发竞争、跨域会话或完整权限矩阵。

验证命令：

```powershell
pnpm -C core exec node --test test/agent-backend-scaffold.test.mjs
```
