# small-runner 调度候选独立只读复核

审查工作树：codex/ci-small-runner-concurrency。比较基线：a0f834ebe727d6d00e2d692a008d3d0512a56536。

结论：本次限定范围未发现问题。源码仅对 availableParallelism()===2 的默认文件并发从1改为2；既有policy执行记录与当前源码、loader和维护文件集合绑定一致。该候选的真实耗时收益与稳定性需要由新head的完整CI证明；旧D5 run没有记录实际CPU/availableParallelism，不能将ubuntu-latest标签当作该run实测双核的证据。

证据级别：源码确认、既有policy记录独立重算、原字节核对。本审查没有再次执行driver、loader、policy脚本、测试、Browser、engine或CI，没有修改维护源码、旧证据、现有报告，也没有stage。唯一新增文件为本ignored review.md。

## driver 与现有 policy 记录

core/scripts/test-core.mjs 当前1450 bytes，SHA256 36c4cab4696de79e7c82fc401297094f5fd8f688b8dc009d562845ba19b440bf。相对基线在 core/src、core/scripts、core/test、console/src、.github/workflows、core/package.json、core/pnpm-lock.yaml 的 git diff --name-only 中，唯一变更为 core/scripts/test-core.mjs。

源码保留顶层普通 .test.mjs 发现、排序、空集合报错、单次 Node --test 调用、stdio inherit、cwd=core、spawn错误抛出与非零/null退出语义。修改默认映射如下：

| availableParallelism P | 基线默认 | 当前默认 |
| --- | ---: | ---: |
| 1 | 1 | 1 |
| 2 | 1 | 2 |
| 3 | 2 | 2 |
| 4 | 3 | 3 |
| 5 | 4 | 4 |
| 64 | 4 | 4 |

core/workspace/_runs/ci-small-runner-20261018/policy.json 为133316 bytes，SHA256 dd502847b1f8449d37d24111d764d010dfdf6ff702e50fb79749375e8f1ca936。记录的driverSha256与当前文件相同；loaderSha256与当前policy-loader.mjs相同，为ed5a37235b5b16ca143316f337cc04c32cbb129ad87ece5c6ade2542053537ae。

该记录来自实际维护driver配合ESM loader：只替换node:os建议并行度和node:child_process调用，仍由driver实际读取顶层维护目录。它验证调度合同，不是两核Linux性能实测，也不是额外跑了一套Browser/engine。

独立读取policy的11条case，再用当前源码公式、CLI和当前229文件逐项重算完整child argv，结果均一致：

- P=1/2/3/4/5/64：默认分别为1/2/2/3/4/4。
- P=2且CLI为--test-concurrency=1：保留显式1；P=2且CLI为--test-concurrency 3：保留空格形式与值3。
- P=64且CLI为--test-concurrency=7、--test-name-pattern=example：原样保留两个参数，不注入默认并发。
- 模拟child status17→driver exit17；模拟status null→exit1。
- 各case均只有一次记录的child调用，argv尾部完整包含相同229文件；cwd解析为当前core，stdio为inherit；recorded checks与passed均true。

这里没有新增对spawn error分支的实测；该分支源码保持不变。没有更改原断言、测试数、skip、timeout或smoke顺序。

## 顶层维护集合

使用只读os.scandir(follow_symlinks=False)枚举core/test顶层普通.test.mjs得到229文件。将逐名排序结果与git ls-tree读取的a0f834e顶层维护集合比较，数量与每个名称均相同。

排序basenames以LF连接并附末尾LF的SHA256为：a7245a5b73f1b0f6c0e9ff2e37ae78ea7d9a7be112e810fa3a57799447ffdd7f。policy的每条invocation均逐名匹配此集合；未纳入ignored/runtime/evidence冻结源码。

## 旧八个 verifier 原字节

逐个使用git cat-file blob a0f834e:<path>取得原字节，与新树文件read_bytes比较，8/8完全相同：

| 文件 | bytes | SHA256 |
| --- | ---: | --- |
| core/src/acceptance/browser-operation-schema.mjs | 20848 | bb088bea4986339d8bee957346a1e088ed1a6e3d159a56db98bc4fc5fccaf062 |
| core/src/acceptance/browser-operation-store.mjs | 46174 | f1b3a61fc0e88838f987e46375f8311e7819e348c7484b94ef8a57e42166684a |
| core/src/acceptance/browser-fixed-contract.mjs | 13573 | d0ed6efc68445c71a1d36d0565829f3997f6161e4d73dcab9f6fddcdd0d3a09c |
| core/src/acceptance/browser-fixed-runner.mjs | 272 | fda76d30533719efc67e746ef36e8c0f1b8232db28cc2f410638c8f5d55ce846 |
| core/src/acceptance/runner.mjs | 40165 | c0f249bd45b1f3b5e42383297b332fa57f126605b809e09eac7b781ee058cc57 |
| core/src/acceptance/identity.mjs | 6601 | 3f4c7cedd8f12a8f752c1a4be0108d63f5f5ab9cd4c289d0ff555e131d1086e5 |
| core/src/acceptance/report.mjs | 6191 | 8d244ff2209eaea5bb325cd56a58f42d8cc043a9316d01b3714c55ed9a044c15 |
| core/src/verify/compare.mjs | 3617 | 59b432e481e0f62a4755b30362172ad0fa1d49bdc349af094255eb81b597ea68 |

## 公开超时原件归档

docs/audits/2026-10-18/evidence/defect-ticket-ci-timeout/manifest.json 为42678 bytes，SHA256 d6d80ec9dca77af49f8474d40fe7ab286c09190046960ddee0cb785ae2d205f6。

独立核对manifest身份为run39072135745 / attempt1 / head a0f834ebe727d6d00e2d692a008d3d0512a56536 / conclusion cancelled。96条文件路径无重复，合计5196054原字节；逐个比较公开dest、manifest声明的source、bytes、SHA256，全部相同。没有缺失；公开目录额外仅README.md、.gitattributes、manifest.json这三个说明/清单文件。

原annotations第1条确为The job has exceeded the maximum execution time of 45m0s。README与独立核验均保留取消失败历史：2661 tests / 2657 pass / 0 fail / 4 skipped，前19项smoke success、第20项D5 cancelled无terminal summary、Docker skipped；部分成功没有替代全轮结果。该公开manifest逐文件保存原来源；没有通过更改核验器接受旧失败。

## 旧 run 实际 CPU 未记录

本轮在旧final-20261017T222913.304634Z的全部raw logs及downloads/complete-stdout.log中，只读搜索availableParallelism、CPU/cpus/cores/nproc/lscpu/parallelism、test-concurrency和processor count，未找到记录实际CPU数量或availableParallelism返回值的命中。

旧Core的1_Set up job.txt只记录runner version2.337.0、Hosted Compute Agent、Azure westus2、Ubuntu24.04.5与ubuntu-24.04镜像20261012.334.1等；这些字段不证明CPU数量。jobs API的ubuntu-latest标签同样不是实测计数。

可以确认源码在P=2时旧默认为1，以及旧pnpm test的真实34m9s API时段；不能据此断言旧run的实际P=2或证明串行是全部34分钟的唯一原因。没有联网扩搜CPU规格。新调度候选的耗时与完整门禁结果由新head的CI验证。

