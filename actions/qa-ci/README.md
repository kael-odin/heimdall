# Heimdall QA CI Action

这个复合 Action 把 [Heimdall QA CI](../../docs/guide/07-qa-ci.md) 封装成一行调用。它不会替代人工验收，也不代表任意网站都能稳定运行；它只对目标项目 `.heimdall/qa.json` 中声明的页面、视口和检查负责。

## 最小用法

在目标项目里放好 `.heimdall/qa.json`，然后添加：

```yaml
name: Heimdall QA

on:
  workflow_dispatch:
  pull_request:

permissions:
  contents: read
  issues: write

jobs:
  qa:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: kael-odin/heimdall/actions/qa-ci@main
        with:
          site: web
          viewports: 1440,390
          failOn: all
          comment: "true"
```

Action 会安装 Heimdall 自己的 QA 依赖和 Chromium，运行只读巡检，上传 `.heimdall/qa/runs/**` 证据，并在 PR 上评论最新的 `qa-ci.md`。`comment: "false"` 时不发评论，只保留注解、步骤摘要和 artifact。

这个 Action 只面向 `ubuntu-latest`。示例里的 `@main` 便于跟最新版；生产项目建议换成团队审核过的 release tag 或完整 commit SHA，避免上游更新直接改变 CI 行为。

## 输入

| 输入 | 默认值 | 说明 |
| --- | --- | --- |
| `site` | `web` | `qa.json` 里的站点名 |
| `workspace` | 调用仓库根目录 | 测试工作区目录 |
| `pages` | 空 | 逗号分隔的路径，空时使用站点配置 |
| `viewports` | `1440,390` | 逗号分隔的视口宽度 |
| `checks` | 空 | 工作区相对路径的检查点 JSON |
| `failOn` | `all` | `all` / `wall` / `degrade` / `none` |
| `maxFindings` | `0` | 允许放行的问题数，默认不放行 |
| `linkCheck` | `true` | 是否检查同源坏链 |
| `baseline` | `true` | 是否与已登记基线比较 |
| `requireBaseline` | `false` | 设为 `true` 时，本次每个页面和视口都必须完成视觉基线比较；不可与 `baseline: "false"` 同用 |
| `detect` | `true` | 是否跑无参照物检测 |
| `explore` | `false` | 是否显式开启有界交互探索 |
| `comment` | `false` | 是否把 `qa-ci.md` 评论到 PR |

生产站点先建议只跑 `workflow_dispatch` 或定时任务，再逐步接入 PR。网络、登录态、风控和动态内容造成的失败，必须在报告里与环境问题分开。

如果视觉回归是门禁的一部分，设 `requireBaseline: "true"`，并在运行环境准备已审核的基线文件、原运行记录和截图。基线未提供、新页面未登记或证据不可用时，门禁返回未完成；默认不强制基线，未比较时普通 QA 仍可能通过。此选项只保证完成比较，发现的差异仍按 `failOn`、`maxFindings` 和已有裁决处理。上传的截图可能包含敏感业务内容，需按团队策略控制 artifact 访问。
