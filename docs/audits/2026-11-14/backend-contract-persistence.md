# 观察型契约落盘与 B3 后端检查实测

日期：2026-11-14。

## 结论

在 83 页 Datasette 独立部署归档上，`probe contract` 之前只把契约打印到 stdout，后续 `site-assessment` 仍会显示 `api-contract-missing`，导致 AI 无法读取刚生成的后端证据。本轮修复了这条断链：单一站点来源的脱敏契约现在写入 `workspace/<siteId>/api-contract.json`，`site-assessment` 能读取 B0/B1 状态和证据路径。

同一案例仍被正确判为 B0：归档里没有可判定的 API 条目，因此没有捏造端点或业务规则。生成的 B3 脚手架启动后，`npm run check` 的健康、适配器覆盖和缺口账本三项均通过；这只证明本地脚手架可运行，不证明源站后端等价。

## 实际步骤

数据来自工作树外的只读归档：

```text
D:/Github-Star/heimdall-evidence-archive/2026-11-13/datasette-standalone/data
```

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-13\datasette-standalone\data'
node core/src/cli.mjs probe contract --site 127.0.0.1 --json
node core/src/cli.mjs backend scaffold 127.0.0.1 --json
```

随后在生成的 `workspace/127.0.0.1/backend-scaffold` 中先直接检查一次，得到预期的 `fetch failed`；启动 `npm start` 后再次运行 `npm run check`，得到：

| 检查 | 结果 |
| --- | --- |
| 观察型契约 | B0；0 个端点；契约已写入 `workspace/127.0.0.1/api-contract.json` |
| B3 健康检查 | passed；HTTP 200 |
| 适配器覆盖 | passed；1 条观察适配器路由，无缺失路由 |
| 缺口账本 | passed；0 个未声明缺口、0 个未覆盖查询参数、0 个未验证写入 |
| `site-assessment` | `backend-scaffold.check.status=passed`；整体仍为 `needs_human_review` |

契约采集还新增了仅限形状分析的 URL 清洗模式：经明确批准的 `page=2` 这类查询只保留参数名并清空值；带 `token` 等私密参数的请求会被拒绝，不会写入契约。静态/HAR/适配器回放仍使用原有更严格的 URL 隐私策略。

## 未完成边界

- 该归档没有足够证据生成 B1 API 端点，所以后端补全只能停在 B0/B3 起点。
- 认证、权限、状态机、业务规则、持久化和副作用仍需独立测试账号及明确授权旅程。
- `npm run check` 通过只表示脚手架在当前观察范围内能启动并完成确定性检查，不表示源站业务正确。
