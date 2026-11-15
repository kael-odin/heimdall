# `site-assessment` 公开案例复核

日期：2026-11-15  
范围：本机已保存的公开只读证据；没有登录、写入或业务副作用。

## 复现性说明

上面的 RFC Editor 数值来自当天的公开现场复核，属于历史记录。继续复验时，当前外部归档 `public-seo-rfc-editor-20261114` 只有 `seo/` 报告，没有 `pages/`、`live-export.json` 或视觉验证目录；从该归档重新运行 `site-assessment` 得到 `cloneTask=blocked_on_capture`、SEO 84、GEO 68.4。因此 6/6 镜像和 6 页视觉验证不能在当前归档上再次声称已复现，详细的多案例当前结果见 [`cloneTask 多案例复验`](site-assessment-clone-task-cases.md)。

## RFC Editor

命令：

```powershell
node core/src/cli.mjs site-assessment rfc-editor.org --json
```

当前摘要：

| 项目 | 结果 |
| --- | --- |
| 站点评估 | `overall=needs_human_review`，`stage=human_review` |
| 镜像与视觉 | 6/6 页有镜像，6 页多视口验证 |
| 离线交付 | `blocked` |
| 浏览器失败 | 12 条候选失败摘要 |
| 二进制缺口 | 2 个 PDF 下载链接，需要人工授权审核 |
| SEO/GEO | SEO 90（评分 v13、测量 v8），GEO 71（方法 v8），sitemap `partial` |
| 后端与 QA | API `missing`；QA `ready`（12 次页面/视口、0 条可提单、61 条可容忍） |

随后在仓库外的临时 QA 工作区补跑了同一站点的公开只读巡检：

```powershell
node core/src/cli.mjs qa run web --workspace D:\Github-Star\heimdall-qa-rfc-editor-20261115 --viewports 1440,390 --no-links --no-baseline --json
node core/src/cli.mjs site-assessment rfc-editor.org --qa-workspace D:\Github-Star\heimdall-qa-rfc-editor-20261115 --json
```

运行 `qa-20261115-140620-39f2` 打开 6 个公开页面的 12 个页面/视口组合，导航和检测器全部完成；报告有 61 条可容忍观察、0 条可提单问题、0 个业务检查点。无参照物检测报告为 47 条，CLI 和 `run.json` 现在使用同一个去重后计数。该结果证明页面层巡检链路可供 AI 读取，但不证明后端、认证、权限、业务状态或未声明流程没有缺陷。

同日用统一 CLI 复验候选包的 `live-verify --static`，在最终镜像浏览器阶段因 `externalRequest@analytics.ietf.org×6` 失败。失败摘要已写入 `workspace/rfc-editor.org/deployment-verification-attempt.json`；`site-assessment` 将它投影为独立部署阻断任务，仍保持 `independentDeployment=needs_verification`。

这次复核证明 `site-assessment` 能把视觉、离线交付、SEO/GEO 范围、二进制分发、API 和 QA 缺口放在同一份交付计划中。它没有把 6 页视觉验证解释成后端完成，也没有把页面级 GEO 证据解释成完整站点覆盖。

本轮公开 SEO/GEO 复验还把 RFC Editor 的受限 sitemap 摘要直接投影到 `deliveryPlan.seoGeoTask.coverage.sitemap`：`coverage=partial`、`reasons=[budget-exhausted]`、`truncated=[url-limit]`，并保留 10,000 URL 上限和文件计数。AI 读取任务包即可知道站点范围为何受限，仍需回到完整报告读取页面证据和行动详情。

## Xspark 公开案例

命令：

```powershell
node core/src/cli.mjs public-case-summary --case-path docs/cases/xspark/2026-11-04 --json
```

当前公开摘要显示 5 页、10 次页面/视口检查、QA 门禁通过、可提单 0 条、视觉回归 0 条、SEO 90.8；真实用户 PageSpeed 数据不可用，GEO 仍为 `unknown`，没有认证后台、写入流程、结账、支付或账户变更证据。

## Vite 公开案例

命令：

```powershell
pnpm -C core run audit -- https://vite.dev/ --max 3
node core/src/cli.mjs site-assessment vite.dev --json
```

本次只做公开 GET，使用临时数据目录，审计后清理原始工作区。侦察和 sitemap/BFS 选出 `/blog`、`/acknowledgements`、`/blog/announcing-vite2` 三页。

| 项目 | 结果 |
| --- | --- |
| SEO/GEO | 首次 SEO 90；复跑 SEO 88；GEO 68.4 |
| 页面完整性 | 3 页；失败页 0；初始 HTML 未核查 0 |
| sitemap | `complete`；无受限原因和截断原因 |
| observed 行动 | 5 条 GEO P1；返回 5 条；`truncated=false` |
| advisory | 最新复跑 4 条 medium；description 重复、图片 alt、CLS 等 |
| SEO/GEO 账本 | `4 verified / 1 open / 0 unknown`；open 为待处理优化行动 |
| 任务状态 | `ready_for_ai_review`；真实排名、收录和模型引用仍未知 |

该案例验证了任务包可以同时给出 GEO 维度、优先级、受影响页和中等严重度提示。两次同范围复跑的 SEO 90→88 说明分数必须绑定采集证据，不能直接比较裸数字。它仍只证明三页公开样本，不证明整站业务或真实搜索效果。

## 结论与边界

- 公开案例已经能区分“页面与 SEO 证据充分”和“后端、认证、权限、业务 QA 未知”。
- RFC Editor 仍被动态请求、外链运行时、未镜像链接和二进制审核阻断，不能作为独立离线交付通过案例。
- 同一 RFC Editor 报告已复核 `deliveryPlan.seoGeoTask`：SEO 90、GEO 71，评分和测量口径均为 `current`，sitemap 为 `partial`，任务状态为 `ready_for_ai_review`，返回 6 个脱敏 observed 行动项，`provenance.invented=0`，输出未命中 Bearer、private-value 或 super-secret。它给 AI 提供了当前优化上下文，但 sitemap 范围和真实搜索/模型引用效果仍未被证明。
- 同一评估在补充匹配 QA 工作区后，`deliveryPlan.qaTask` 为 `ready_for_ai_review`：前端 6 页、12 个页面/视口组合、覆盖完整、finding 详情可读，后端契约仍为 `missing`、`invented=0`；它把页面层 QA 与后端缺口分开交给 AI。
- 同一 RFC Editor 公开 QA 运行的 `qaTask.closure` 为 `4 verified / 1 open / 1 unknown`，且 `readiness.qa.closure` 与它一致：运行、页面覆盖、finding 证据和人工裁决已具证据，业务检查点缺失为 `open`，后端闭环因无 API 观察为 `unknown`。页面 QA 的 `ready_for_ai_review` 不再被解释成前后端缺陷检测已经完成。
- 当前后端闭环账本在 RFC Editor 和 `example.com` 的公开摘要中都显示 `required=8`、`verified=0`、`open=0`、`unknown=8`、`notApplicable=1`；`qaTask.scope.backend.completion.closure` 与 `deliveryPlan.backendCompletion.closure` 完全一致。缺少 API 观察证据保持未知，不被包装成失败或通过。
- 该 QA 运行没有业务检查点，也没有登录态；`fileable=0` 只表示当前声明范围没有达到提单门槛，不能解释成零 bug 或整站 QA 通过。
- Xspark 的 QA 通过只适用于其 5 页、10 次检查和声明范围，不能外推为任意站点检测准确率。
- 下一步需要获授权真实站点的登录、权限、写入、状态机和完整 QA 旅程；公开只读复核不能替代这些证据。
