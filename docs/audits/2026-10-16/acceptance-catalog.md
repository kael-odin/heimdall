# 本地项目与版本归属实施验收

日期：2026-10-16。范围：项目、不可变版本声明、历史运行后续归属、引擎所有权和目录并发保护。使用隔离数据目录及本机固定夹具，不操作真实项目数据。

本阶段已接通数据层、引擎 API 和控制台。证据分为源码确认、隔离目录故障注入、本机固定夹具真实流程；没有把本地夹具换算为真实项目准确率。候选批准、托管执行、Browser 来源锁和持久缺陷状态不在本阶段实现范围内。

## 用户可见能力

- 创建本地项目，登记不可变版本的 label、完整目标 URL 和可选 buildRef。
- 明确将已结束运行认领到某项目版本；同一运行一次归属，不按 URL 或历史顺序自动选择。
- 原运行文件保持只读，失败与通过门禁仍可从目录打开查看；来源缺失时保留关系和诊断。
- 每次目录写入校验 generationId 与 revision；冲突保留草稿，需要先刷新核对，POST 不自动重发。
- 引擎先取得真实数据根的 owner，再恢复未完成运行。第二进程和 junction / symlink 别名均不能误恢复首进程任务。

控制台入口、API 和恢复边界见[操作指南](../../competition/acceptance-catalog.md)。版本地址及 buildRef 是声明，不证明当前线上部署；组织归属不等于批准证据或验收放行。

## 实现与不变量

`catalog.mjs` 保存有界目录快照、不可变实体和逐 revision 事件，初始 generationId 在正常重启后保持不变。owner 内的有界队列覆盖 read → validate → CAS → 修改 → 备份 → 原子替换；失败不推进主目录 revision。目录默认 8 MiB，项目 64、版本 1024、归属 4096、事件 8192；达到任一上限拒绝写入，不裁剪历史。首版不开放目录恢复、重绑和删除接口。

所有者锁只在同主机且 PID 明确返回 ESRCH 时，在独立恢复互斥区重新核对 nonce / 文件身份后接管。锁老、未知进程、权限拒绝、不同主机、损坏记录和遗留恢复互斥文件都不构成接管许可。正常退出不删除别人的锁；所有验收 API 都重新检查 owner。

历史认领通过完整 runId 直接读取有界 manifest；测试覆盖 105 条更新记录之外的来源。完整 URL 规范化后匹配，路径和查询均参与。归属诊断明确 `manifest-only`、`evidenceVerified:false`；报告缺失、旧记录没有报告摘要都不会被伪造为“证据已验证”。完整性及可靠修复仍由[显式复验](../../competition/acceptance-comparison.md)判断。

## 实际验证结果

| 检查 | 本机结果与证据 |
| --- | --- |
| 全量 core | **1078 项：1076 pass、0 fail、2 Docker 条件 skip**；217480.5979 ms，见[完整日志](evidence/acceptance-catalog/checks/core-tests.txt) |
| 新增目录 / owner / HTTP / UI helper | 48 项包含于全量；目录独立 22/22，owner + HTTP 15/15，UI helper 11/11 |
| lint | 326 文件通过 |
| console build | 通过；既有 Graph3D 大 chunk 提示仍存在 |
| 新真实 API / 多进程 / 控制台 | **17 组检查通过**，31 条 API 观察记录，3 次真实 worker 运行 |
| 旧 Mirror 控制台 | 通过，见[浏览器记录](evidence/acceptance-catalog/checks/mirror-browser-checks.json) |
| 旧 Spec 控制台 | 通过，见[浏览器记录](evidence/acceptance-catalog/checks/spec-browser-checks.json) |
| 旧显式复验控制台 / API / CLI | 15 项通过，见[浏览器记录](evidence/acceptance-catalog/checks/comparison-browser-checks.json) |
| 原 forge smoke | 通过，见[实际输出](evidence/acceptance-catalog/checks/forge-smoke.txt) |
| 文档链接 | 105 份文件中 300 个本地目标通过 |

真实流程使用既有 Playwright Chromium。Browser plugin not available，因此沿用仓库已安装的 Playwright；没有安装新浏览器依赖。入口为本机动态端口引擎 → 项目验收 → 项目与版本 → 新建 / 登记 / 明确认领 → 打开原运行。

三次 Spec 来源运行分别真实产生 failed、passed、passed；第三次在响应暂挂期间启动两个竞争引擎（相同路径与 junction 别名），均拒绝启动，原 running manifest 字节不变。放行响应后原任务正常完成。目录阶段 **新增目标请求为 0**，全部原运行文件的 SHA-256 在归属、重启和控制台操作后保持一致。

| 反例与 UI 检查 | 实际结论 |
| --- | --- |
| 同 revision 并发写入 | 恰好一个 201，另一个 409 STALE_REVISION；只推进一次 revision |
| 旧 revision、错误 generation、未知字段、字符串 revision | 拒绝；主目录字节不变 |
| 重绑、跨项目版本、查询不同的 URL | 分别明确冲突；原关系不变 |
| 非法目录 JSON | API 返回 503，原件保留；UI 显示目录不可用并保留已有项目，不显示空目录；恢复测试原字节并刷新后草稿保留 |
| 进程重启 | 项目、版本、归属、事件和 generationId 保持一致 |
| 冲突窗口 | 只发一次 POST，保留草稿；刷新核对成功后清除旧错误 |
| 迟到详情 | 项目切换后旧详情不能覆盖当前项目 |
| 迟到版本 POST | 写入仍归提交时项目；当前项目及其未提交草稿保持不变 |
| A → B → A 后迟到创建回包 | 选择序号保护生效，不被旧回包跳转到新建项目 |
| 原报告跳转 | 失败 run 仍显示“发现缺陷”，归属没有抹去门禁 |
| 桌面 / 手机 / 横屏 | 1440×1000、390×844、375×812、844×390；无横向溢出 |
| 键盘 | 原生 summary 使用 Enter 开合，焦点保持 |
| 深浅主题 | 6 类关键文字对比度最低 4.688:1；测试 CSS 放大至 24px 后可换行，无横向溢出 |
| 页面身份 / 非空 / overlay / console | 页面标题和 origin 正确，无框架 overlay，无非预期 error / warning 或 pageerror |

有意制造的 409 与 503 资源错误单独记录在 `expectedResourceErrors`，不混入实际应用异常。文字放大是 CSS 压力检查，不声称覆盖浏览器原生缩放或系统 Dynamic Type。

## 本轮发现并修复

真实 UI 首轮发现冲突刷新完成后错误卡未清除，以及认领成功后旧选择立即触发“重复认领”提示。已在成功核对时清除旧错误、成功认领且草稿未改时清空旧 run 选择，最终 smoke 复验通过。

独立源码及真实 Vue 内存探针发现创建项目的 A → B → A 选择竞态，已补 selectionEpoch，并增加真实 Playwright 迟到 POST 回归。对比度检查发现目录修订号在次级面板只有 4.435:1；改用更清晰的主题文字 token，最终深浅主题均通过。

上一提交 `067dc362a860faa63746775840fd3aba07d8f6e0` 的远端 run `38900831890`：控制台构建与基准 job 成功，但全量 core 有一项失败（1026 pass、1 fail、3 skip）。runner 测试在 1235.83 ms 只得到 1 项环境检查，原日志未打印该环境错误详情。结合测试给 Chromium 启动等操作共用 1200 ms、同文件后续测试正常，强烈指向 CI 冷启动预算不足；这属于诊断推断，未冒称取得原始 launch 栈。测试夹具改为生产默认 10000 ms，并在 45 项断言中加入环境诊断，保留全部检查和缺陷断言、不增加重试。当前本机定向与全量均通过；远端必须按本阶段提交另行核对。

## 证据与复现

- [17 组浏览器 / 流程检查、布局与对比度](evidence/acceptance-catalog/console/browser-checks.json)、[API 观察](evidence/acceptance-catalog/console/api-cases.json)、[目标请求](evidence/acceptance-catalog/console/fixture-requests.json)。
- [初始目录](evidence/acceptance-catalog/console/catalog-before.json)、[最终目录 API](evidence/acceptance-catalog/console/catalog-after.json)、[最终完整持久快照](evidence/acceptance-catalog/console/catalog-storage.json)、[项目详情](evidence/acceptance-catalog/console/project-detail.json)。
- [原运行文件摘要](evidence/acceptance-catalog/console/run-file-digests.json)与 `console/run-evidence/` 完整来源，摘要可重新计算。
- [桌面](evidence/acceptance-catalog/console/catalog-desktop.png)、[390 手机](evidence/acceptance-catalog/console/catalog-390.png)、[375 手机](evidence/acceptance-catalog/console/catalog-375.png)、[横屏](evidence/acceptance-catalog/console/catalog-844.png)、[浅色手机](evidence/acceptance-catalog/console/catalog-mobile-light.png)、[冲突](evidence/acceptance-catalog/console/catalog-conflict.png)、[目录不可用](evidence/acceptance-catalog/console/catalog-unavailable.png)。

```powershell
pnpm -C console build
pnpm acceptance:catalog:smoke
pnpm -C core test
pnpm docs:links
```

新 smoke 已接 CI，使用隔离目录，每次默认生成独立证据目录。所有重启、篡改和进程清理仅针对本次夹具。比较 smoke 的来源归档已限定为实际 run 目录，避免将新增 owner / catalog 运行材料混入原始运行证据。

## 后续切片

下一批先做候选预览、摘要、资格与显式批准 / 选用历史，保持它与执行分开。随后接批准 Spec 的托管执行；Browser 托管必须先实现选定侧的来源投影和实时来源失配的硬阻断。当前版本不提供这些按钮，不维护项目自动通过或持久 BUG 关闭状态，也不把截图归档描述为可执行冻结基线。
