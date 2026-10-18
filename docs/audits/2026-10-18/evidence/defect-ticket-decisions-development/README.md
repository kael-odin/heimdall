# D6 开发证据归档

2026-10-18；本归档仅保存开发阶段原件，不代替最终构建、最终门禁或精确提交 SHA 的 CI。源现场全部保留。

已逐文件复制并读回核验 **689 文件 / 6930554 bytes**；排除 **2760 文件 / 72798170 bytes**。

## 入口与证据范围

- [开发报告](originals/d6-browser-development-20261018/REPORT.md)：七轮现场、四组探针对照、截图视觉检查与保证边界。
- [schema/store 最终专项](originals/d6-schema-store-final-20261018T084028628/REPORT.md)：50/50、exit 0，包含全部135个普通原文件、2条符号链接元数据及12个真实SIGKILL场景现场。
- [第七轮 summary](originals/defect-ticket-decisions-console-smoke-20261018T093910120/summary.json)：4×17案内与13全局检查；[当时 strict 原输出](originals/d6-browser-build-20261018T090008180/attempt-7-strict-verifier.log)。
- [逐目录统计](source-statistics.json)、[逐文件排除清单](exclusions.json)、[复制清单](archive-manifest.json)：原路径、目标路径、bytes、SHA-256。
- [测试符号链接元数据](source-links.json)：2条，保存readlink原目标文本、UTF-8 bytes/SHA及lstat尺寸；不跟随、不在Git归档重建链接。

原目录名保留在 originals/ 下，因此原开发报告中的跨目录链接仍可导航。复制全部顶层JSON/JSONL/日志/HTML/DOM/PNG与各case原件，四组probe均保留完整脚本、log.json和results.json；Browser运行数据只额外保留不可变defect-ticket事件原件。

## 版本与结果限制

第七轮runner和当时strict verifier均exit 0，但使用早于约01:20 UTC Catalog四文件改动的旧console bundle。构建前后原件只固定D6两前端输入；不能据此声称最终Catalog已验证。旧bundle的完整文件路径/bytes/SHA清单在第七轮implementation-inputs-before/after.json，未复制可重建dist实体。

第七轮当时verifier：**22379 bytes**，SHA-256 **6ed1be2e9f654aa5e5bb79d576446fc6bcac096c920b120577c17cd383340f58**。[当时 verifier 完整源码](../defect-ticket-decisions-verifier/originals/verifier-before-current-inputs.mjs)已在相邻正式归档保存，bytes与SHA-256均已核对一致。当时before==after及strict原输出均原样保留。后续增强版本增加当前12源码/dist匹配与时间链/快照等检查；它拒绝旧输入属于预期。最终新OUT由root单独归档。

第六轮原runner曾返回passed:true/exit0，随后完整relay日志记录finally引起的两条proxy-error。独立strict verifier真实exit1（2!==0），所以第六轮是被严格门禁拒绝的假绿，不能当通过：[原summary](originals/defect-ticket-decisions-console-smoke-20261018T093345261/summary.json)、[完整relay](originals/defect-ticket-decisions-console-smoke-20261018T093345261/relay.jsonl)、[拒绝日志](originals/d6-browser-build-20261018T090008180/attempt-6-strict-verifier.log)。它们均未改写。第七轮有序teardown后全日志零意外代理错误。

前四轮completion失败、第五轮普通轮询额外502也完整保留。只保证同一真实数据根和保留不可变动作账本内的受控样例，不宣称断电、备份回滚或跨根exactly-once。

## 体积与排除

- 全部chromium-profile/：11个浏览器运行/探针目录的缓存、配置、数据库等，逐项路径与bytes见排除清单。
- 七轮Browser runtime/：排除source捕获、Browser operation产物、catalog和运行期状态；仅保留runtime/acceptance/defect-tickets/v1/events/下12个决定原件。其对应raw decision、上游/deny回执、完整ticket/artifact快照与源内容摘要仍在各case和顶层日志中。
- 可重建console/dist实体及依赖不属于这14个源目录，也未作为归档输入；原清单保留旧bundle指纹。没有删除或移动源原件。

## 文件核验

仅文件I/O，不会启动Browser、engine、Core测试或子进程：

```powershell
node docs/audits/2026-10-18/evidence/defect-ticket-decisions-development/archive-control.mjs verify
node docs/audits/2026-10-18/evidence/defect-ticket-decisions-development/archive-control.mjs verify --sources
```

第一条可在其他checkout核验全部归档字节、文件集合和manifest封印；第二条另读取原本机core/workspace/_runs路径，对所有已复制源文件重新核对。归档manifest不包含自身与其SHA封印文件，verify单独校验二者并拒绝其他多余文件。局部.gitattributes为* -text，局部.gitignore仅为本目录originals解除日志等全局忽略。
