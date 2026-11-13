# 留出查询缺口分级

日期：2026-11-14。

## 结论

适配器留出验证以前只把新查询参数名写入离线缺口账本。分页请求如果继续使用已知参数名，但值或组合没有被训练集观察到，验证结果会失败，账本却不能说明这是“查询变体缺口”。本轮补上这条证据链：

- `unobserved-path`：训练集没有对应路径观察。
- `unobserved-query-variant`：路径和参数名已知，但请求值或参数组合未观察。
- `uncovered-query-parameter`：出现训练集没有的参数名。

查询值不会进入报告。`site-assessment` 和 B3 脚手架会把第二类缺口交给 AI，要求先用独立留出请求验证，再补实现。

即使尚未生成 B3 脚手架，`site-assessment.deliveryPlan.backendCompletion.repairTasks` 也会从账本直接生成脱敏修复任务；生成脚手架后会按任务类型去重。

## 证据

本轮复用已有真实分页留出案例的边界：DummyJSON 商品分页和博物馆作品分页此前各有 4 次训练、1 次留出，训练回放通过，未观察查询本地返回 404。新增本地回归使用同样的脱敏形状，验证 22/22 通过：

```powershell
pnpm -C core exec node --test test/live-adapter-validation.test.mjs test/live-adapter-generator.test.mjs test/agent-backend-scaffold.test.mjs test/agent-assessment.test.mjs
```

其中新增断言确认 `page=2` 只产生 `queryParams: ["page"]` 和 `unobserved-query-variant`，报告不包含 `page=2`。

## 边界

该改动改善缺口分类和 AI 修复指令，不会根据一个或几个分页响应自动编造后端切片逻辑。未知分页仍需站点专用实现、冻结留出请求、独立部署和业务规则复验。
