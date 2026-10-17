# Heimdall 接手入口

更新：2026-10-17。原 2734 行逐日开发记录完整保留在 [历史 HANDOFF](docs/archive/HANDOFF-through-2026-10-13.md)，其中的分数、文件行号和待办均是当时快照。

## 先看

1. [README](README.md)：项目价值、启动与文档导航。
2. [USAGE](USAGE.md)：当前控制台和 CLI 操作。
3. [2026-10-14 审查](docs/audits/2026-10-14/README.md)：第 1–6 节保留修复前证据，第 7 节记录当前复验、浏览器证据与未关闭边界；阅读缺陷清单时须同时核对第 7 节。
4. [ROADMAP](docs/ROADMAP.md)：仍需验证或建设的事项。
5. [项目验收工作台](docs/competition/acceptance-workbench.md)：比赛方向的可运行 MVP、输入 schema、门禁、AI 解读和演示命令。
6. [Spec / OpenAPI 实施记录](docs/audits/2026-10-16/acceptance-spec.md)：只读契约、批准与来源追踪、固定真值、真实控制台和证据索引。
7. [跨运行复验实施记录](docs/audits/2026-10-16/acceptance-comparison.md)：稳定检查身份、当前字节完整性、显式运行对关系、API / CLI / 控制台与固定反例。
8. [项目与版本实施记录](docs/audits/2026-10-16/acceptance-catalog.md)：项目、不可变版本、历史运行归属、双引擎所有权、目录冲突与重启证据。
9. [验收目录格式升级](docs/audits/2026-10-16/acceptance-catalog-migration.md)保留原 1→2 验收；[Schema3 分步迁移](docs/competition/acceptance-catalog-schema3.md)增加 2→3、版本独立前像、完整 Spec 历史兼容和失败续迁，详见[迁移验证](docs/audits/2026-10-17/acceptance-catalog-schema3.md)。后续[来源侧归属](docs/competition/acceptance-browser-bindings.md)为原空表增加严格实体与内部操作。
10. [Spec 需求基线](docs/competition/acceptance-baseline.md)：完整合同候选、批准历史、独立选用与取消，以及[实施验收](docs/audits/2026-10-16/acceptance-baseline.md)。
11. [托管 Spec 合同与读取](docs/competition/acceptance-managed-spec.md)：由当前选用重建完整合同、明确目标版本、不可变派发准备与物理只读同键核对；[runner 执行控制](docs/audits/2026-10-16/acceptance-spec-execution-control.md)支持内部停止信号与同步 active 断言，[来源关联与隔离](docs/audits/2026-10-17/acceptance-managed-provenance.md)核验原字节身份并阻止普通入口降级，[固定身份存储](docs/audits/2026-10-17/acceptance-managed-store.md)增加 owner 约束的报告与中断收尾。[托管读取验收](docs/audits/2026-10-17/acceptance-managed-reading.md)现覆盖状态、完成快照、证据下载、比较及安全 DTO；新增[启动恢复验收](docs/audits/2026-10-17/acceptance-owned-recovery.md)，真实 owner 在完整零写预检后中断遗留运行并保留现场；新增[托管执行验收](docs/audits/2026-10-17/acceptance-managed-execution.md)，专用 HTTP 对完整新确认启动真实 Spec 检查，统一运行槽并支持取消、超时和任务镜像；新增[执行工作台验收](docs/audits/2026-10-17/acceptance-execution-ui.md)，明确目标版本后启动，持久操作凭据只读恢复并支持请求停止；candidate / triage 继续隔离。

12. [Browser 所选侧来源核验](docs/competition/acceptance-browser-source.md)：纯投影器核对完整槽位、截图稳定性与选侧健康，[私有读取层](docs/competition/acceptance-browser-reading.md)补齐真实 owner、有界 fd、nullable 角色、全引用与 managed 隔离。[来源侧归属](docs/competition/acceptance-browser-bindings.md)提供严格 ax 实体、双向 target 归属约束和提交前完整来源重建，详见[绑定验收](docs/audits/2026-10-17/acceptance-browser-bindings.md)；新[HTTP 与工作台](docs/competition/acceptance-browser-bindings-console.md)增加显式归属、按需重核验、安全显示预览和证据校验，详见[工作台验收](docs/audits/2026-10-17/acceptance-browser-bindings-console.md)。Browser 完整批准预览、候选、批准、选用和执行继续后续接入。

13. [运行展示读取竞态](docs/audits/2026-10-17/acceptance-display-head-race.md)：正常 legacy worker 原子发布时保留本请求已稳定捕获的展示版本；来源 / 证据 / 恢复仍严格核验，原工作台 CI 失败及放弃方案均保留。

## 代码路径

- `core/src/engine-server.mjs`：引擎路由、任务编排与静态产物入口。
- `core/src/crawler/`、`core/src/queue.mjs`、`core/src/url-canon.mjs`：侦察、捕获、页面身份与队列。
- `core/src/verify/`、`core/src/differ/`：多视口和单页差异；跨评分版本不要直接比较。
- `core/src/acceptance/`：Mirror / Regression 浏览器对照、Spec 只读契约执行、OpenAPI 候选与来源快照、门禁报告、持久化、显式运行对复验与可选 AI 解读；`console/src/AcceptanceWorkbench.vue` 为入口。[Spec 指南](docs/competition/acceptance-spec.md)、[复验指南](docs/competition/acceptance-comparison.md)及[项目目录指南](docs/competition/acceptance-catalog.md)包含实际范围与反例命令。项目目录组织运行与不可变版本声明；[需求基线](docs/competition/acceptance-baseline.md)提供 Spec 候选完整预览、显式批准及独立选用，响应始终 `executionReady:false`。managed 状态、完成快照、核验下载与比较已接入；托管 executor 已接专用 HTTP，新确认当次链启动；candidate / triage 仍隔离。引擎先取得数据根所有权，再经整批零写预检收束 managed / legacy 未完成任务；恢复受阻时保留诊断读取并以 503 阻断验收写入；同一数据根只启动一个引擎，managed prepared 记录不会自动执行。Browser 内部来源侧归属、提交前完整投影重建与单条只读重核验已完成；HTTP / UI、Browser 批准选用执行与持久缺陷工单后续接入，原始门禁保留。
- `core/src/live/`：交互镜像、HAR 清洗、离线健康与导出。
- `core/src/seo/`：站内审计与回归基线。
- `console/src/Atlas.vue`：控制台站点上下文和任务入口；`PagesView.vue`、`DetailDock.vue`、`SiteBar.vue` 等为工作视图。

## 本机检查

```powershell
pnpm -C core lint
pnpm -C console build
pnpm -C core test
pnpm -C core smoke
```

控制台真浏览器回归在 `core/test/console-e2e.test.mjs`。本机调试产物位于被忽略的 `core/workspace/`，包括审查截图；不要用清理脚本直接删除。发布前重新核对 `docs/ROADMAP.md` 中的验收状态和实际交付包。
