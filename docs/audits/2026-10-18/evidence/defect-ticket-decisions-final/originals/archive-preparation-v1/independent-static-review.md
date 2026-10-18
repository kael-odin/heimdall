# D6 最终归档准备脚本独立静态审查

日期：2026-10-18。工作树：`C:\Users\44548\.codex\worktrees\ci-small-runner-concurrency\heimdall`。

审查范围仅为本准备目录的 archive-control.mjs、inputs.example.json、README.md，以及维护源码中的原 D6 strict verifier。**没有读取活动 final-browser 的任何文件，没有执行 create/verify/strict、engine、Browser、build 或测试，也没有修改维护源码、stage、commit、push。**

## 当前结论与版本边界

当前读回 archive-control.mjs 为30515 bytes，SHA256 `711625bc19765991a7094f09009597808b9788d1c5f9d94262b7ebe7c090fbcb`。

初版27990-byte脚本（SHA256 `8d665656fe0cf2cd31a466f2685bd9d3ceb6616a0c1be286110bab2484c1af56`）有两处会改变严格副本结论的静态边界，已直接交 schema 所有者并抄 root；当前版本均已在源码修复。未发现本范围内其他确定阻塞。这里的“已修复”指源码分支补齐，不代表真实归档已执行通过。

## 发现及修复后复核

### 1. 源链接可能在归档中被规范化，改变 strict 原结论

初版 scan 把symlink只保留成metadata；copy对普通源文件未要求nlink=1。若原21案保留树出现symlink或hardlink，原strict verifier的tree（维护源码47–49行）应拒绝，但副本可能丢掉symlink或把hardlink复制成独立文件后通过。这与“完整两树不删减来制造通过”的要求不符。此项为静态条件，未断言任何真实现场含链接。

当前源码：
- strictOriginal（152–154）覆盖final-browser下21案所有不排除的证据。
- 普通文件收集时核对sourceStat.nlink==='1'（219–223附近），symlink分支明确拒绝strictOriginal（227–229附近）。
- 12源码及完整dist也拒绝源链接；dist先核对links为空及各文件nlink=1。
- originals对相关输入记录requireSingle；copy前后与verify --sources均传给readStable(single=true)。
- 源整树treeDigest现包含每个普通文件的sourceNlink；复制后及--sources复核完整来源集合和nlink。
- 归档每个目标文件本来就通过readStable(single=true)检查，verify也对全部目标拒绝硬链接；归档scan拒绝symlink。

因此该静态等价缺口已补齐。

### 2. 两棵strict完整树内profile命名曾被优先排除

初版excluded先执行全局chromium-profile或*-chromium-profile过滤，再判断两树保留。若两棵strict依赖树中出现该名称的额外普通文件，归档会静默删减，可能让副本strict接受源strict本应拒绝的额外文件。

当前excluded（140–150）先识别21/runtime/acceptance/defect-tickets与sourceRunId两树；其中出现profile命名直接拒绝，而不是排除；其余位置才适用profile和普通batch runtime排除。该项已修复；README及生成README字符串也已同步明确拒绝条件。

## 字节与严格文件集合

- readStable在读取前后核对dev/ino/size/mtime/ctime/nlink，并校验读取长度；需single的范围另要求nlink=1。
- 每个copy先匹配源当前bytes/SHA与预先清单；COPYFILE_EXCL避免覆盖；目标完整Buffer与源before逐字节相等；再次读取源并比较完整bytes和stat。
- 每个来源目录独立记录完整文件集合与treeDigest；复制后再次扫描同源，--sources再复核。新增/缺失/内容或链接元数据变化会失败。
- 当前新增implementation-console-dist的独立statistics，把**完整源dist文件集合**纳入复制后及--sources复验，不只重验已知快照文件。
- manifest.originals和controls目标path唯一；verify要求scan所得文件集合精确等于清单加manifest/seal，逐个匹配bytes/SHA。任何额外或缺失普通文件都会失败；归档链接也被拒绝。
- manifest自身以独立SHA封印核对；source统计、排除清单、链接metadata、strict日志与run结果属于controls并受同一字节清单保护。

## 两棵运行树与独立strict布局

- 21案非runtime普通文件保留，四案screenshots/DOM/raw/log/case与before/after输入按原相对路径复制。
- 21/runtime/acceptance/defect-tickets与21/runtime/acceptance/<summary.sourceRunId>的全部普通文件保留；没有按events白名单筛掉额外文件，额外文件应由原strict判断。树内不支持的链接/profile状态现在明确拒绝归档。
- SOURCE_KEYS精确12项，与维护原strict的implementationSourcePaths逐项一致；前后21案implementation输入必须完全一致；每个当前源bytes/SHA与该输入及四批次flat manifest核对。
- 完整console/dist文件树精确匹配同次21案consoleBundle；使用implementation/core/...、implementation/console/src/...、implementation/console/dist/...原布局。
- 被复制的原strict CORE来自自身../，因此在implementation/core/scripts下运行仍能读取相邻core源码及../console/dist；该strict仅import Node内建模块，不依赖本机node_modules。
- create中只有一次固定spawnSync调用，运行的路径固定是副本内原strict，OUT固定是归档内originals/final-browser/21-decision-artifacts。verify分支不创建子进程。

## 批次、历史失败、排除与失败原件

- 四组final要求completed/真实endedAt/passed，固定组与stage数量；逐stage原run.json与batch记录、argv/cwd/environment计划、退出码、时间、stdout/stderr摘要和changedInputs一致；四final前后flat manifest及跨组输入一致。审查未读取这些实际批次，不宣称其当前状态。
- 首轮Core失败必须保留completed/false；外部中止批次保留running/null/false，通过terminalConfirmed与独立已有外部证明表达停止事实，不改造成completed。
- 修后四案、native-http修前、keepalive最小实验、两份protected-eight与frozen-index为必需supplemental角色。protected-eight两份结果静态要求精确八路径、四份摘要一致、当前文件与final flat manifest一致。归档保留调用方提供的原验证材料，不重新运行git或替代root的stage/index核验。
- 每个排除普通文件记录原路径、bytes、SHA；其余允许保留metadata的symlink记录readlink原文/摘要/大小，未跟随或重建；这些链接也进入来源treeDigest。
- strict不通过仍保存stdout/stderr原字节、argv/时间/exitCode/signal/error，再写manifest与readme，verify结果passed=false并CLI非零，不补造通过。
- 复制途中失败会留下部分final目录；脚本不删除源或部分输出、不覆盖重跑。部分目录不应被称为已完成封印，按README交root检查和可逆处理。
- archive的.gitattributes使用* -text，.gitignore放行证据原件；prearchive与postarchive docs/index材料的边界现已写明，后续release-checks不回写既有封印。

## 尚未做的验收

只有静态审查。最终配置仍须由root填写真实终态来源，并在唯一授权窗口运行create、归档副本原strict和两次verify。源码修复/模板/语法检查均不能替代这些真实结果。审查者未访问活动Browser批次。

