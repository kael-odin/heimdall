# Heimdall QA CI

`heimdall qa ci` 把现有的只读 QA 变成一个 CI 门禁。它仍然使用 `qa.json` 里的站点、登录档和约定，不新增一条测试实现。

## 最短用法

在测试工作区根目录执行：

```powershell
heimdall qa ci --site web --pages /,/pricing,/product --viewports 1440,390 --fail-on all --github
```

输出：

- `.heimdall/qa/runs/<runId>/report.md`：人看的 QA 报告
- `.heimdall/qa/runs/<runId>/bugs.md`：建议提单的问题
- `.heimdall/qa/runs/<runId>/qa-ci.json`：机器读的门禁结果
- `.heimdall/qa/runs/<runId>/qa-ci.md`：GitHub Actions 摘要
- `qa-ci.json` 里的 `annotations`：可直接写进 GitHub Actions 的注解

退出码：

- `0`：门禁通过
- `1`：达到失败门槛
- `2`：配置或参数错误
- `3`：浏览器或测试环境不可用、登录态失效、检查点未能核实、页面检测器执行失败，或要求的视觉基线比较未完成
- `7`：内部错误

## 门槛

```powershell
heimdall qa ci --site web --fail-on all
heimdall qa ci --site web --fail-on wall
heimdall qa ci --site web --fail-on degrade
heimdall qa ci --site web --fail-on none
```

- `all`：任何建议提单的问题都失败，默认值
- `wall`：只有 `wall` 级问题失败
- `degrade`：`wall` 和 `degrade` 级问题失败
- `none`：不因建议提单问题让任务失败；登录失效、检查点未能核实或检测器执行失败时仍返回退出码 `3`

`--max-findings N` 可以容忍少量问题，但建议只在有明确清理计划时使用。被容忍的问题仍会以 warning 注解显示，不会消失。

登录失效或检查点执行出错、未能核实时，`qa-ci.json` 的 `gate.status` 和信封里的 `ci.status` 都是 `incomplete`，错误码是 `qa_incomplete`；`incompleteReasons` 说明原因。恢复相应登录档或修复检查点后再重跑。工具会保留登录页截图作为环境证据，但不会把它当作业务页比较或登记视觉基线。登录识别依赖登录路径、配置的退出登录提示和密码框，不能保证识别所有身份失效场景。

页面检测器执行失败时也会标记为 `incomplete`，不能把未执行完的检测当成通过。

需要把视觉回归纳入门禁时，先登记并保留完整基线，再使用 `heimdall qa ci --site web --require-baseline`。本次每个页面和视口都必须完成比较；缺少基线文件或截图、新页面未登记、环境或来源不匹配时返回 `incomplete`。MCP 使用 `requireBaseline: true`，复合 Action 使用 `requireBaseline: "true"`。不启用时，尚未登记基线的普通 QA 可以通过，报告会说明没有进行视觉比较。

## 声明页面与接口预期

在工作区 `checks.json` 中保存业务检查，再通过 `--checks checks.json` 传给 `qa run` 或 `qa ci`。例如，已确认某个分页应显示 10 条、首条编号为 11 时：

```json
[
  {
    "id": "product-page", "title": "商品分页符合已核实预期", "path": "/",
    "basis": "promise", "loss": "用户看到商品数量减少且首条错位，无法得到声明的分页结果。",
    "steps": [
      { "action": "click", "selector": "#load" },
      { "action": "waitFor", "selector": "#ready[data-done]" }
    ],
    "expect": [{ "kind": "text", "selector": "#count", "equals": "10" }],
    "responses": [{
      "method": "GET", "origin": "https://example.org", "path": "/products",
      "query": { "limit": "10", "skip": "10" },
      "json": { "path": ["products", "0", "id"], "equals": 11 }
    }]
  }
]
```

替换站点来源、选择器和独立核实的预期值。接口观察只读取页面原有的主框架 GET/POST 响应，不主动发送请求；读取状态和可选 JSON 标量不证明整个响应正确。请求缺失、多次匹配、正文无法核实或值不符时，该检查仍为未完成，CI 返回 `3`，不会自动将接口不符判成产品缺陷。

每条声明检查点只执行一次，默认使用第一个巡检视口。要在多视口重复业务检查，为每个检查点配置不同 `id` 与明确的 `viewport: { "width": 375, "height": 812 }`；页面巡检的多个 `--viewports` 不会自动复制这些声明。

`path` 不接受查询、编码或片段。只有 GET 可以使用 `query`：1–20 个参数，键名限 40 个字母、数字、点、下划线或连字符且以字母开头，值必须是最长 200 字符的字符串；完整 URL 最长 2,048 字符。敏感字段、控制字符、嵌套 URL 和不安全编码会被拒绝。参数顺序不影响匹配；不同值、额外参数或重复参数不匹配。未提供 `query` 时只匹配裸 URL。响应摘要只输出参数名，不记录查询值或正文；输入配置仍须自行审阅。

页面业务断言失败后能否阻断，还取决于发现级别、判定记录、`--fail-on` 和容忍数量。`loss` 应写已观察的用户损失；缺少它的发现最高为 `tolerable`，不会进入建议提单及 CI 阻断列表。不要为了让流水线变红而编造损失。

## GitHub Actions 复合 Action

目标项目可以直接调用仓库里的复合 Action：

```yaml
permissions:
  contents: read
  issues: write

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: kael-odin/heimdall/actions/qa-ci@main
        with:
          site: web
          viewports: 1440,390
          failOn: all
          comment: "true"
```

它负责安装 Heimdall、运行 QA、写注解、上传证据，并可按需把最新 `qa-ci.md` 评论到 PR。完整输入见 [Action 文档](../../actions/qa-ci/README.md)。

示例使用 `@main` 便于跟进最新版；长期生产流水线应改用团队审核过的 release tag 或完整 commit SHA。该 Action 目前面向 Ubuntu runner。

## 手写模板

复制 [模板](../../examples/github-actions/heimdall-qa.yml) 到目标项目时，默认只启用手动和定时触发，适合先观察生产站点动态噪声。需要接入 PR 时，用上面的复合 Action 或仿照它增加 `pull_request` 触发、评论权限和评论步骤（fork PR 没有权限时只保留 artifact 和日志）。

建议先只在 `workflow_dispatch` 和定时任务上运行外部网站，再逐步接入 PR。生产站点会受到网络、登录态、风控和动态内容影响；外部网络失败不能被说成产品 BUG。

## 与验收的关系

- `qa ci` 适合日常巡检、发布前健康检查、跨版本截图回归和坏链 / 控制台 / 接口错误检查。
- 固定清单验收适合改版前后有明确基线、需要证据核验和人工关闭的场景。
- 两者都不替代人工判断；CI 通过表示符合本次配置的门禁政策，可能仍有可容忍、已抑制或未达到门槛的问题。

独立包的严格导出也会执行已声明的离线旅程。未捕获导航链接会继续阻断发布，但不会单独阻止已捕获页面上的旅程诊断；无效计划、隐私、资源、浏览器等其他前置阻断仍会让旅程保持未执行。应同时看旅程结果和全部发布阻断，不能将某条旅程通过当作整包通过。
