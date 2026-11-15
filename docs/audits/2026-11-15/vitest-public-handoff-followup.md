# `vitest.dev` 当前三页 handoff 与页面复杂度专项复验

范围：公开、无登录、只读；只采集 `vitest.dev/`、`/blog` 和 `/api/test` 三页。证据包放在仓库外：
`D:/Github-Star/heimdall-evidence-archive/2026-11-15/handoff-vitest-followup-20261115-v1/`。

命令：

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-15\handoff-vitest-followup-20261115-v1'
node core/src/cli.mjs handoff https://vitest.dev --max-pages 3 --jobs 1 --strict
node core/src/cli.mjs site-assessment vitest.dev --json
```

| 阶段 | 结果 | 说明 |
| --- | --- | --- |
| 侦察 | 3/3 | 首页、博客、API 文档页 |
| 克隆 | 3/3 | 183 个文件，61 个唯一文件，硬链接节省约 8.2 MB |
| 多视口还原 | 3/3 | 平均 99.6%，最差首页移动视口 98.2% |
| 资产扫描 | 通过 | 259 个引用，视觉缺口 0 |
| 严格离线 | 阻断 | 外部资产 3、第三方运行时 3、未镜像链接 87、浏览器失败 3 |
| 页面复杂度任务 | 已出现 | 1/3 页观察到 2 个 Canvas，生成 `clone-page-complexity=open` |
| 动态后端缺口 | 0 条 | 没有把外链运行时误判为同源 XHR/fetch 缺口 |
| SEO/GEO | SEO 91.3、GEO 62.2 | 3 页、SEO 16 条问题、GEO 6 条 P1 行动；sitemap `not_found` |

`site-assessment` 返回 `overall=needs_human_review`，`cloneTask.status=blocked_on_visual_verification`。三页验证摘要都标记为 measured，但博客页缺少当前 measurement proof，因此评估只计入 2/3 verified；这保留了“已生成数字”和“当前可交付证据”的差异。

SEO/GEO 任务包返回 `geoStatus=complete`、GEO 置信度 `high`，但真实搜索排名、收录和模型引用仍为 `unknown`。站点级重复 description advisory 现在返回 `affectedPages=3` 和 `/`、`/api/test`、`/blog`，AI 可以定位修改范围；该修复不改变 SEO/GEO 分数。

该案例证明 `clone-page-complexity` 能在真实公开交付中进入 AI 任务包，也证明高视觉分数不能解除严格离线门禁。没有生成独立部署通过证据；本次仍未覆盖认证、权限、写入、状态机、业务规则或真实 SEO/GEO 效果。
