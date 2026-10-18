# D6 最终归档准备工具 v2

2026-10-18。此目录受既有 `core/workspace/` 规则忽略；这里只保存 v2 可执行脚本、显式输入模板与设计说明。**本代理尚未执行 v2 create、独立 strict、engine、Browser、Core 或任何真实 runner。** v1 完整准备目录保持冻结原件，由 root 保留并另行取得真实同错重现原件；v2 仅纠正历史中止合同，不修改维护源码或门禁输入。

v1 假设被中止批次只能原 `running`/`endedAt:null`，因此在真实原件 `completed`/`passed:false` 上拒绝。实际是采集 driver 已收束、写回 endedAt 与 exit1，测试则由 operator 中止；这两个事实分别保留。v2 不改原 batch，不把该历史记录计作完整 Core 通过。首次直接调用无本地原 stdout；后续 `archive-v1-aborted-state-reproduction-20261018T035023.953075Z` 是 root 使用原 wrapper 取得的真实独立重现，不能冒充首次原输出。最终配置由独立 reviewer 填写并收录 v1、v2 与该重现窄目录。

## 入口与执行条件

- `archive-control.mjs`：创建及只读核验器。创建时唯一允许的子进程是归档实现副本中的原 D6 strict verifier；verify 没有子进程、网络或写入。
- `inputs.example.json`：不能直接执行的模板，`terminalSourcesOnly:false` 及各未终态输入的 `terminalConfirmed:false` 会拒绝执行。复制成新的配置文件后，必须逐项填写 root 明确给出的真实终态路径和已有外部中止证据；禁止用活动父目录代替具体批次或实验目录。

四个最终 batch 均要求 `status:completed`、真实 endedAt 和 passed:true，stage 数为 static2/core1/browser27/docs1。前后 flat input manifest 必须未变，四批次输入必须完全相同。逐 stage 要求 run.json 与 batch 项完全相同、argv/cwd/environment 与计划对应、退出码及时间有效、原 stdout/stderr SHA 相同、changedInputs 与两个原输入清单一致。

历史输入显式保留首轮 Core 唯一失败和中止批次。失败 batch 必须真 completed/false，不能包装成通过。中止 batch 始终保留 `disposition:aborted`、`rawPassed:false`，支持两类原状态：原 running/null，或原 completed 且有有效 endedAt 和至少一条非零 stage。后一类继续执行与普通 completed 相同的完整 batch/stage 输入清单、changedInputs、run.json、argv/cwd/environment、开始/结束时间和原 stdout/stderr 摘要校验，并核算原 passed 一致性；不能只改状态条件后跳过终态证据。

两类中止均要求调用方 `terminalConfirmed:true`、说明和至少一个原 `operator-interruption` JSON 外部证明：安全正整数 targetPid、非空 reason、verifiedCommand 精确匹配计划 argv，taskkill 记录须指向该 targetPid。completed 分支进一步要求该 PID/命令精确对应所保留的非零 stage。其他外部证明文件可以一同保留，但不能替代上述原 operator 证明。此工具不凭状态猜测进程已停止，也不启动子进程查看系统状态；原证明没有时间戳时不会补造时间。

supplemental 必须独立收录修后四案专项、native-http-fixture-connection 修前完整文件和说明、http-keepalive-loopback 最小实验（包括未复现结论）、protected-eight 发布前和最终 stage 后核对结果、最终 frozen-index raw blob 绑定结果。有多个最小实验目录时，增加同 role 的不同 id；所有 supplemental 必须窄到确切已停止来源，目录内普通 runtime 原样保留。protected-eight 两份结果要求八个真实路径精确、baseline/HEAD/index/worktree 摘要相同、与当前文件及最终 flat manifest 匹配；摘要结果不能声称保存了未提供的完整 git blob 文件。

需要额外保存最终 driver、runner、验证脚本或主报告时，可增加自定义 supplemental role/id。文件来源放入 `originals/<id>/original-file`，目录来源保留相对结构。

## 复制和严格校验

最终 Browser 的 `21-decision-artifacts/` 非 runtime 普通原件全部保留，含四案截图/DOM、case 目录、请求、回执、完整日志、源摘要及实施前后清单。普通 batch runtime 排除，但21案 `runtime/acceptance/defect-tickets/` 和 `runtime/acceptance/<summary.sourceRunId>/` 两个完整子树全保留，任何额外文件也保留，交由原 strict 验证真实拒绝或接受。不能只复制 events，也不能删减源码树以制造通过。

全部路径段 `chromium-profile` 和 `*-chromium-profile` 排除；两棵完整 strict 依赖树优先，树内出现 profile 命名直接拒绝，不能静默删减后制造通过。每个排除普通文件记录路径、bytes、SHA-256。21案非排除原件、12源码和完整dist拒绝源符号链接及硬链接；其余源符号链接不跟随也不重建，保存 readlink 原文本/摘要/尺寸。归档本体拒绝符号链接和硬链接。每个复制文件使用 COPYFILE_EXCL，复制前后核对源 stat/SHA、目标完整 bytes；整棵来源再核对完整文件集合、摘要和nlink，完整dist来源也独立复验，不删除/移动源文件。

实现快照保留 `implementation/core/...`、`implementation/console/src/...` 和完整 `implementation/console/dist/...` 原布局。12个源码 key 精确对应真实21案 before==after，当前源码 bytes/SHA 和四批次 flat manifest 必须匹配，同次 console/dist 完整文件树必须匹配。快照内原 verifier 只有 node 内建依赖，创建归档后真实只读执行：

```powershell
node <ARCHIVE>/implementation/core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs <ARCHIVE>/originals/final-browser/21-decision-artifacts
```

工具自行执行上述唯一固定子进程并保存真实 argv、时间、exitCode/signal/error、stdout/stderr 原字节及 SHA。即使 strict 失败也原样封存，manifest 的 passed 和命令退出码不冒充通过。不会修改 verifier、原21案 manifest 或业务证据。

局部 `.gitattributes` 为 `* -text`，`.gitignore` 放行全部归档原件。manifest 列出原始路径与目标路径、bytes/SHA；自身和 SHA 封印单独核对。只读 verify 检查完整文件集合、每个字节、strict 原输出、快照匹配；`--sources` 额外核对全部复制/排除源文件、链接元数据及所有来源完整文件树。默认可在无原现场的 checkout 检查已归档内容。

## root 终态授权后的命令

先把模板复制到新的 `inputs.final.json` 并填写完整终态路径；所有 false 仅在对应外部事实已有原始证据时改 true。不要在 Browser 运行时执行以下 create。

```powershell
node --check core/workspace/_runs/d6-final-archive-preparation-v2-20261018/archive-control.mjs
node core/workspace/_runs/d6-final-archive-preparation-v2-20261018/archive-control.mjs create --config core/workspace/_runs/d6-final-archive-preparation-v2-20261018/inputs.final.json
node docs/audits/2026-10-18/evidence/defect-ticket-decisions-final/archive-control.mjs verify
node docs/audits/2026-10-18/evidence/defect-ticket-decisions-final/archive-control.mjs verify --sources
```

destination 固定为本树 `docs/audits/2026-10-18/evidence/defect-ticket-decisions-final`，只允许全新目录；既有 development/verifier/specialists 均不作为输出且不会被覆盖。若复制或校验失败产生部分 final 目录，工具不会删除或复写它；保留错误现场，由 root 先检查并可逆归档后再决定后续。

本归档使用 prearchive docs 和已stage维护输入的 frozen-index/protected-eight 结果。证据归档自身不要求事先stage，防止依赖循环。归档Markdown及最终报告链接生成后，root 另做 postarchive docs，将原非Markdown run/log/input存独立 release-checks；最终完整交付stage/index核验也在 release-checks 接续，不能改写已封印 final archive。

## 当前验证范围

已对脚本执行过 `node --check`（exit0）。仅静态设计和语法检查不证明真正归档已通过；最终待 root 四组门禁、历史失败/中止和全部补充来源齐备后，在授权终态窗口实际创建并做两次文件核验。
