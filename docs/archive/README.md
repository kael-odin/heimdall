# docs/archive · 阶段性记录

这里的文件是**历史证据，不再更新**。保留是因为它们是过程记录
（阶段性审查与计划），但内容已不代表当前状态 ——
读之前先看 [../ROADMAP.md](../ROADMAP.md) 和 [../../README.md](../../README.md)。

2026-10-22 清理：删除了 `W0`…`W4-REPORT.md`（2026-09-29 ~ 09-30 的周度验收报告，全仓零引用）
和 `deliver-plan-2026-10-10.json`（`core/deliver-plan.json` 的旧快照，运行时副本在本机且不再由 Git 跟踪）。
都还在 git 历史里，需要时用 `git log --diff-filter=D --name-only -- docs/archive` 找到删除提交，
再 `git show <提交>^:docs/archive/W4-REPORT.md` 取回。

| 文件 | 是什么 | 日期 |
| --- | --- | --- |
| `REVIEW-2026-10-08.md` | 一次完整的项目审查（代码走查 + 本地实测 + 全新站点克隆探针） | 2026-10-08 |
| `PLAN-2026-10-09.md` | 基于上面那次审查的批次计划与路线图 | 2026-10-09 |

**为什么归档而不是删除**：审查记录里的
"当时发现了什么、为什么这么排优先级"对理解当前架构取舍仍然有用 ——
比如现在的站点配方、CSS 引用扫描器、CAS 回收判据都是那次审查的产物。

**当前状态去哪看**：
- 产品与定位 → [../../PRD.md](../../PRD.md)
- 使用与交付 → [../../USAGE.md](../../USAGE.md)，[../../README.md](../../README.md)
- 还没做的事 → [../ROADMAP.md](../ROADMAP.md)
- 每批改了什么、为什么 → [HANDOFF-through-2026-10-13.md](HANDOFF-through-2026-10-13.md)
