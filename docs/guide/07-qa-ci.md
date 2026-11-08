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
- `3`：浏览器或测试环境不可用、登录态失效、检查点未能核实，或页面检测器执行失败
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
- 两者都不替代人工判断；CI 通过只表示本次声明的检查通过。
