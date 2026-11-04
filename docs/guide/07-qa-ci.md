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
- `3`：浏览器 / 环境不可用
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
- `none`：只生成报告，不让任务失败

`--max-findings N` 可以容忍少量问题，但建议只在有明确清理计划时使用。被容忍的问题仍会以 warning 注解显示，不会消失。

## GitHub Actions

复制 [模板](../../examples/github-actions/heimdall-qa.yml) 到目标项目。模板不假设 Heimdall 已经安装，可以从公开仓库拉取工具后运行；它支持手动、定时和 `pull_request` 三种触发，PR 运行后会把最新 `qa-ci.md` 作为评论贴回（fork PR 没有评论权限时只保留 artifact 和日志）。

建议先只在 `workflow_dispatch` 和定时任务上运行外部网站，再逐步接入 PR。生产站点会受到网络、登录态、风控和动态内容影响；外部网络失败不能被说成产品 BUG。

## 与验收的关系

- `qa ci` 适合日常巡检、发布前健康检查、跨版本截图回归和坏链 / 控制台 / 接口错误检查。
- 固定清单验收适合改版前后有明确基线、需要证据核验和人工关闭的场景。
- 两者都不替代人工判断；CI 通过只表示本次声明的检查通过。
