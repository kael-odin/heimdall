# Catalog 状态恢复的离线证据归档

本目录按原字节保存 `catalog-state-diagnosis-20261018` 的全部 **33 个原件、138,651 字节**：轻量复现脚本、修复前后 Vue/helper 源码、完整测试 stdout/stderr、结果与时间、最终四文件 SHA、旧 Catalog smoke 未改记录及原说明。复制前后逐项读取来源与归档字节比较，原件不改动。本次归档只进行离线读回，没有执行原复现脚本、测试、Browser 或 engine。

## 证据结论与范围

- 修复前离线场景：版本 POST 已得到 201 实体，后续 list GET 永不结算，实际 Vue 状态持续 busy，ACK 文案为空；正常对照与手动释放 gate 后恢复均保留。
- 修复后：产品每个请求的统一 60,000ms 预算覆盖 fetch 与完整 JSON body。原离线复现以 35ms 注入预算分别覆盖 fetch/body stall：ACK 刷新中即可见、超时退出 busy、保留已提交事实与草稿，明确 GET 核对后恢复，全程一次 POST。
- 原最终 helper **24/24**、实际 Vue 状态 **16/16**，均 exit0、无 fail/skipped；属于专项结果。UI detector 为 **exit2、一条既有 warning**，before/after 均有相同 CSS 声明，原输出保留。
- 该证据确认独立产品韧性缺口，**没有证明 CI run 39082419484 的具体停点或同一根因**。原 Catalog Browser smoke 的断言与等待未改，本归档不宣称该 smoke、Core 全量或新 CI 已通过。历史完整 CI failure 见相邻 `catalog-ci-failure/`。

## 文件与核验

`original/README.md` 保存详细原结论、覆盖范围与限制；`before-results.json`、`after-results.json` 及同名 stdout 保存真实 Vue refs/computed/watchers 的离线状态。`AcceptanceCatalog.before.vue` / `acceptance-catalog.before.js` 与历史提交 `41c359...` 相同；两个 after 副本对应 `after-results.json` 的输入摘要。`frontend-final-sha256.txt` 另外记录两份专项测试源码的当时 SHA；测试源码由仓库版本管理，本原始目录没有其额外副本。

原 `.mjs` 复现脚本按原路径保存，其 import 仍指向原工作树依赖；归档不改写它们，也不把移动后的历史脚本宣称为独立可运行复现环境。

`manifest.json` 只用相对路径列全部 33 原件的 bytes/SHA256，六个控制文件不递归自 hash。`archive-integrity.json` 保存归档读回、原输入身份、历史测试统计及基线 Git 字节核验结果。

在本目录运行 `python verify-archive.py` 可只读核验归档；加 `--git-repository <仓库路径>` 可同时核验历史 before 源码的两个 Git blob。核验器不执行 `original/` 中任何脚本，也不发网络请求。`.gitattributes` 的 `* -text` 保留原换行字节，局部 `.gitignore` 使完整原日志可纳入提交。
