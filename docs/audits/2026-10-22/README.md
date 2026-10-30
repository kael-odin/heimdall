# Heimdall 仓库审查报告（大白话版）

- 审查日期：2026-10-22 开始，2026-10-23 收尾
- 审查基线：`main` / `9838a20`，开始时工作区是干净的
- 上一轮全面审查见 [2026-10-14 审查](../README.md)，本报告不重复它已经讲过的内容
- 怎么审的：我先自己跑了基线（语法检查、文档链接检查、全量测试），再派了 7 位只读审查员分区读代码：HTTP 引擎、采集与克隆、live 与 SEO、验收子系统、控制台、文档、测试与 CI 与打包
- 怎么读这份报告里的"可信度"：
  - 写**实测**，是我亲手复现过的
  - 写**读码**，是我只看代码推出来的，没跑
  - 写**审查员报告**，是别人查的，我没逐条复现，动手前请先复现
- 改动状态：**全部没提交**，都在工作区里，随时可以撤销（见文末附录）

> **2026-10-23 更新**：这份审查之后，本分支又完成了一批修复与治理，下面的"待办"里已有多项落地。
> 已完成的包括：CI 拆成 4 个 job 并分片、SEO 基线口径与门禁模式、引擎写操作统一守卫、
> 采集链路 8 项修复（全部先复现再改）、9 个控制台体验与可靠性问题（主包 494→189 kB）、
> 测试不再依赖 `docs/audits`（改用 `core/test/fixtures/audit-evidence/`）、
> `docs/audits` 中 6 棵无代码引用的最大证据子树移到 `docs/archive/audits/`（见第 6 节）。
> 下面各节保留当时的判断与证据，**未逐条回改**；以第 9 节"当前状态"为准。

## 一句话结论

这是一个"演示能力很强、工程底子偏薄"的项目。

核心流程（克隆、还原度、SEO 审计）能跑，测试很扎实（2764 个测试，0 失败）。但有三个麻烦：主分支 CI 已经连红 4 次；仓库 92% 的文件是证据存档；验收子系统长得比主角还大，演示稿里却一个字没提。

创作期到 11-20，还剩约 4 周。建议先把 CI 变绿，再把演示故事讲顺，**别再加功能**。

## 1. 先看这 3 件事

### 1. 主分支 CI 是红的，文档还写着"待核验"

- 最近 30 次 CI：16 次成功、12 次失败、2 次取消
- 当前最新提交 `9838a20` 和它前面 3 个提交，一共 4 次都失败；最后一次绿是 10-17 的 `5006e16`
- 4 次失败不是同一个原因：两次是"人工动作决定"那个浏览器冒烟，一次是"项目目录"冒烟，一次是 `pnpm test`
- 成功的那些次，耗时从约 17 分钟涨到 39 分钟，离 45 分钟的超时线只剩 6 分钟
- README、HANDOFF、ROADMAP 里还写着"新提交自身 CI 待核验"。答案已经有了：红的

### 2. 演示稿和项目里最大的模块对不上

- 验收子系统占 core 源码的 32%、核心测试代码的 62%、控制台代码的 50%
- README 开头一大段全是 D1 到 D6 这类内部里程碑，外人看不懂
- 但 `DEMO-SCRIPT.md` 全文没有"项目验收"四个字

评委看到的故事（克隆一个网站）和你们投入最多的东西（验收）是两回事。得先定谁是主角。

### 3. 仓库 92% 是证据存档，clone 一次要拉 261MB

- `docs/audits` 一个目录就有 7712 个文件、约 380MB，占全部 8418 个已跟踪文件的 92%
- 它们不是随手乱丢的垃圾：报告按字节数和 SHA-256 引用它们，7 个测试和 3 个脚本直接读里面的文件
- 所以我**没删**，只给了分步瘦身方案（第 6 节）

### 成熟度打分（我的主观打分，满分 5）

| 维度 | 分 | 一句话理由 |
| --- | --- | --- |
| 核心功能（克隆、还原度、SEO） | 3.5 | 流程完整，有真实站点验证；但采集链路里同一条规则被写了多份，已经各改各的（第 5 节） |
| 验收子系统 | 3 | 落盘、加锁、路径白名单做得很严谨，我们没看到目录穿越；但体量压过主线，`catalog.mjs` 一个文件 1092 行 |
| 控制台 | 3.5 | 没有 `v-html`，竞态保护和焦点管理做得好；`Atlas.vue` 2227 行是最大短板 |
| 测试 | 4 | 2764 个全过；用随机端口、无 `.only`、审查员没发现依赖真实外网；扣分在太慢（最慢一条 437 秒）和个别测试乱写目录（已修） |
| CI 与发布 | 2 | 近 30 次只有 53% 是绿的；`lint` 只是语法检查 |
| 文档 | 3 | `docs/guide` 和审计证据扎实；根目录文档落后于代码，而且越写越长 |
| 安全 | 3 | 默认只听本机，有 Token，有 CSP 沙箱，真实 LLM 密钥从没进过 git；但写操作的守卫在不同接口上不一致，Docker 默认配置偏松 |
| 工程基础设施 | 2 | 没有 LICENSE（`package.json` 写的是 UNLICENSED）、没有依赖自动更新、没有覆盖率、没有 ESLint、全部提交（含其他分支共 230 个）出自同一人（两个邮箱） |
| 演示就绪度 | 3 | 克隆主线能讲通；缺验收那一幕；全新 clone 会撞上目录版本的坑（第 5 节 P0） |

**综合：3 / 5。** 一个能拿出来演示的强原型，还不是能交给别人长期维护的产品。

规模参考：`core/src` 40424 行，`core/test` 56705 行（含夹具），`core/scripts` 9783 行，`console/src` 11782 行；13 个活跃日里提交了 225 次。

## 2. 我已经动手改了什么

全部**没提交**。"怎么验证的"一列写清楚了是实测还是读码。

| # | 改了什么 | 为什么 | 怎么验证的 |
| --- | --- | --- | --- |
| 1 | `engine-server.mjs`：审计、侦察、克隆单页、监控这四个启动接口只收 http(s) 网址；所有 JSON 接口的回调外面包了一层兜底 | 给 `/api/audit` 发 `{"url":"file:///x"}`，**整个引擎进程直接退出**，所有正在跑的任务一起没了 | **实测**。旧代码：连接被断，进程退出。新代码：7 种坏输入都回 400，引擎还活着。另用一个损坏的 `atlas.json` 逼出"来源冲突"异常：旧代码崩，新代码回 400 并在日志留一行 |
| 2 | 同文件：`/api/reveal` 启动子进程时补错误监听；跨域允许的方法里补上 PUT | 缺 `xdg-open` 的 Linux 容器里点"打开所在目录"会崩引擎；开发模式下保存模型设置用 PUT，浏览器的跨域预检（调用前先问一句"允许吗"）被拒 | PUT：**实测**，预检现在返回 `GET,POST,PUT,DELETE,OPTIONS`。reveal：**读码**，Windows 上不触发 |
| 3 | `queue.mjs`：没设 `HEIMDALL_API` 时用 `HEIMDALL_PORT` 拼地址 | 引擎启动子进程时只传端口、不传地址，引擎一换端口，整站克隆就连不回引擎 | **读码**，没跑整站克隆 |
| 4 | `seo/collect.mjs` 与 `seo/rules.mjs`：没有 canonical、og:image、twitter:image 时保持为空；hreflang 保留标签原值来判断"是不是相对地址" | 旧代码把空值解析成"页面自己的地址"，于是没有 canonical 的页面看起来"有"。`缺少 canonical`、`缺少 og:image` 两条规则对真实页面**永远不会触发**。相对 hreflang 也被提前转成绝对地址，同样永远不报。以前的单测全是手造数据，绕开了采集层 | **实测**。真实 Chromium 复现。新增 4 个回归用例，旧代码上 2 个失败，新代码全过 |
| 5 | `live/heal.mjs`：落盘前拒绝含 `..`、反斜杠、`%5c`、空字符的路径，并再加一道"必须在目标目录内"的检查 | 导出时 `--heal` 会按页面里写的路径把资源写到磁盘。`/..\..\x.js` 在 Windows 上能把文件写到目录外面 | **实测**：直接调用落盘函数，`..` 和反斜杠两种写法都写出了目录。新增回归用例旧代码失败、新代码通过。**注意**：只验证了落盘函数本身，没有演示"恶意网页到落盘"的整条链路 |
| 6 | `.dockerignore`：排除 `.env*`（保留 `.env.example`）和本机运行状态 | `COPY core ./core` 会把含 `LLM_API_KEY` 的真实 `core/.env` 打进镜像层，而引擎运行时会读它 | **读码**（Dockerfile、`env.mjs`、原规则），没有真的 `docker build` |
| 7 | `Dockerfile`：健康检查带上 Token；控制台构建阶段补拷一个文件；删掉没人读的环境变量 | 开了 Token 后 `/api/status` 要鉴权，旧健康检查拿 401，容器永远是 unhealthy。另外控制台有个组件直接 import 了 `core/` 里的文件，而构建阶段只有 `console/`，镜像根本构建不出来 | 健康检查：**实测**，旧 401、带对 Token 200、带错 Token 401。构建失败：**模拟**——只放 `console/` 的目录里复现了 `UNRESOLVED_IMPORT`，补一个文件后构建通过。**不是真正的 `docker build`** |
| 8 | `console/vite.config.js`：`strictPort: true` | 5173 被占时 vite 会悄悄换成 5174，引擎只放行 5173，结果页面能打开但数据全是空的 | **读码**，没跑 |
| 9 | `core/.env.example`：注释写明 HOST、TOKEN、ALLOWED_HOSTS、DATA_DIR 要设进"环境变量"，写在 `.env` 里不生效 | 旧示例让人以为在 `.env` 里写了 Token 就开了鉴权 | **实测**：Token 只写在 `.env` 里，不带 Token 访问 `/api/status` 返回 200，等于没开 |
| 10 | `DEMO-SCRIPT.md` 里两处"53 条规则"改成 66；规则数守卫测试把演示稿也纳入 | 现场要念出来的数字是错的 | 守卫 4 个用例通过，并用旧稿验证了守卫能抓到。**缺口**：第 269 行写的是"53 条 SEO 规则"，中间隔了"SEO"，守卫的正则抓不到这种写法，是我手工改的 |
| 11 | 3 个测试不再乱写目录：`acceptance-defect-ticket-store` 和 `acceptance-defect-ticket-decision-crash` 默认改用系统临时目录并清理；`acceptance-browser-fixed-runner` 跑完清理 | 前两个按"当前目录"找路径，`pnpm test` 从 `core/` 跑，就会写出 `core/core/workspace/`。第三个每次往真实 `core/workspace/_runs/` 里加几百个文件，从不清理（我量到 484 个涨到 968 个） | **实测**。改后三个测试 52 个全过，跑完无残留。原来的环境变量（设了就留盘）实测仍有效；第三个新增 `D3_FIXED_RUNNER_KEEP_OUTPUT=1` 用来保留 |
| 12 | 新增测试：`seo-collect-empty-meta.test.mjs`（3 个），`seo-i18n-jsrender.test.mjs`（加 1 个），`live-health.test.mjs`（加 1 个） | 给 #4、#5 钉住回归 | 全量测试从 2759 个变成 2764 个，正好多这 5 个 |

## 3. 我删了什么，以及为什么敢删

| 删除项 | 依据 |
| --- | --- |
| 根目录 `pnpm-lock.yaml`（内容只有一行空的 `importers`） | 根 `package.json` 没有依赖，也没有 `pnpm-workspace.yaml`；CI 和 Dockerfile 用的都是 `core/`、`console/` 里各自的锁文件；全仓只有 `.gitattributes` 里有一行提到它 |
| `core/src/differ/keeprate.mjs` | 全仓零引用：`src`、`test`、`scripts`、`console`、`.github`、两份 `package.json`、CLI 都查了，也查了动态拼路径的写法。只有历史快照里提过 |
| `core/scripts/smoke-console-cdp.mjs` | 同样零引用，只在历史审计文档里被提到 |
| `docs/archive/` 里的 `W0` 到 `W4-REPORT.md`（6 份）和 `deliver-plan-2026-10-10.json` | 零引用。前者是 9-29、9-30 的周度旧报告，后者是本机运行时文件的旧副本。git 历史里都在，取回方法写在 [归档说明](../../archive/README.md) 里 |
| 我自己跑测试留下的 `core/core/` 和 `core/workspace/_runs/d3-fixed-runner-tests/` | 删之前核对过：前者没有被 git 跟踪，后者里没有任何早于我第一次启动测试的文件，也就是全是我造的 |

## 4. 我特意没动的东西

- **`docs/audits` 的 380MB 证据**：见第 6 节。
- **`HANDOFF.md`**：文档审查员建议"合并后删"（理由是没有入链）。我没采纳：它是新会话的"接手入口"，10-18 还在更新。
- **`docs/archive/` 里的三份 `*-through-2026-10-13.md`**：README、USAGE、ROADMAP 等还指着它们，要删得先改链接。
- **`docs/REVIEW-HANDOFF.md` 和 `.impeccable/`**：前者装着还没做完的 B3、B4 清单，后者是有意入库的设计产物。
- **`core/workspace`（13G）、`core/assets-cas`（12G）、`core/deliverable`（2.3G）**：你本机的运行数据，不在 git 里，删了就没了。建议用 `HEIMDALL_DATA_DIR` 挪到仓库外面，用引擎自带的回收预览处理，不要手删。
- **2 个 stash、5 个 codex 工作树、17 个本地分支**：是你的现场，清单在附录里。
- **`core/src/acceptance/*` 和 `core/src/verify/compare.mjs`：一个字节都没碰。** 原因是下面这个陷阱。

### 陷阱：验收"指纹"（以后动这些文件前必读）

验收系统给每次运行盖一个"指纹"，指纹是 10 个源文件的**字节哈希**。这 10 个文件任何一个动了一个字节（哪怕是自动格式化），新跑出来的运行就**无法生成基线候选**。

- 这 10 个是 `core/src/acceptance/` 下的 schema、urls、runner、report、spec-schema、spec-runner、response-schema、openapi、identity，加上 `core/src/verify/compare.mjs`
- 另外还有两份互相不一致的指纹清单（`managed-run-store.mjs:105`、`browser-operation-store.mjs:450`）。**不要"统一"它们**，统一会让所有已有指纹作废
- `browser-fixed-runner.mjs` 只有 6 行转发、只有 1 个调用点，看着像死代码，但它的文件名写在指纹清单里，别删

## 5. 还没修的问题（按紧急度）

可信度标记：**实测**是我复现的；**读码**是我看代码推的；**审查员**是别人查的、我没逐条复现，动手前请先复现。

### P0：影响演示或 CI，比赛前必须处理

| # | 问题 | 位置 | 可信度 |
| --- | --- | --- | --- |
| 1 | **CI 连红。** "人工动作决定"那个浏览器冒烟连挂两次，日志是 `Response body … navigated away`：点击之后才去读响应体，页面一跳走就读不到。建议改用同文件 143 到 148 行已有的响应监听，响应一到就读。另外两次红分别是项目目录冒烟和 `pnpm test`，原因不同 | `core/scripts/smoke-acceptance-defect-ticket-decisions-console.mjs:262,268` | 审查员（高）。失败步骤名我用 `gh` 核对过，日志原文没看 |
| 2 | **CI 太慢，逼近超时。** `pnpm test` 一步约 29 分钟，20 个冒烟合计约 11 分钟。建议用 `--test-shard=1/2` 分两片（`test-core.mjs` 已会透传参数，约 29 分钟变 15 分钟）；独立的 `console` job 只要 27 秒，但和另外两个 job 重复安装构建控制台，可以删，删前先看 GitHub 上有没有把它设成必需检查；再加一步 `docker build .`，现在根 Dockerfile 没人构建，这次镜像构建失败才一直没被发现 | `.github/workflows/ci.yml` | 审查员（高/中） |
| 3 | **全新 clone 的演示会撞墙。** 新建的验收目录默认是 v3，而浏览器候选、执行、缺陷单整条链要 v4，会报 `CATALOG_MIGRATION_REQUIRED`。零代码解法：演示前先跑一次 `node core/src/acceptance/catalog-maintenance-cli.mjs --create --target-schema 4`（这条命令只在 `docs/competition/acceptance-catalog-schema4.md` 里提过）。**别改默认值**，有冒烟脚本依赖 v3 | `engine-server.mjs` 建目录处，`catalog.mjs` | 审查员（高），我没跑 |
| 4 | **验收锁残留会让整个引擎起不来**（克隆、SEO 也一起没了）。抢锁失败直接退出，报错里没有锁文件路径和处理办法。建议报错带上路径，并写"确认没有别的引擎后，删掉 `.acceptance-owner.json`"。Windows 上 PID 被复用、关终端不释放锁，是推断 | `engine-server.mjs:73-78` | 审查员（中） |
| 5 | **文档状态过期。** 上面 CI 的状态句要改。`DEMO-SCRIPT.md` 还有：第 196、200 行把已经有的并发、增量、熔断写成"下一步"；`RISKS.md:11` 已有登录复用，稿子却写"不涉及登录后区域"；第 28 行准备步骤缺 `console build` 和 LLM Key；全文没有"项目验收"。`RISKS.md:20` 写"节流是可配项"，但代码里没有节流开关。按你的偏好（节流保持可选、默认不限制），应改文档说"暂无"，或加一个默认关闭的开关 | 如左 | 审查员核对，未逐条复核 |

### P1：比赛前修，影响正确性或安全

**采集与克隆**（审查员）
- 冻结样式泄漏：多视口快照先注入"冻结样式"再读样式表，动画归零、隐藏 cookie 弹窗这些规则被烤进 375 和 768 宽度的 CSS，桌面那份却是冻结前读的，三个视口不一致。`crawler/multi-snapshot.mjs:50-63`（中高）
- 视频封面漏拷：只拷 `canvas-N.png`，不拷 `video-N.png`。`crawler/build_clone.mjs:382`（中）
- 字体规则输出两次：`/* latin */` 注释后的 `@font-face` 被输出两遍，第二份的相对路径没绝对化。`css-refs.mjs:123`（高，审查员用探针复现）
- 全局字符串替换会误伤：`/x/a.png` 会被换成 `/xassets/a.png`；下载序号每次进程重启归零，重跑可能覆盖已被引用的文件。`crawler/linker.mjs:347,50`（高/中）
- 类型嗅探顺序反了：注释写"内容、响应头、后缀"，代码却先看内容是不是以 `[` 或 `{` 开头，样式表 `[data-x]{..}` 会被判成 json。`asset-ext.mjs:123`（高，面窄）
- 脚本剥离正则在配置为空数组时退化，会剥光所有外链脚本；`rel="stylesheet"` 精确匹配，漏掉 `preload stylesheet`。`crawler/build_live.mjs:44,163`（高/中）
- data-URI 里的 `url(%23f)` 被当成缺失资源，而"回收孤儿"的回滚判据读的正是这个缺口。`audit/assets.mjs:28`（高）
- 没有体积上限：整包读进内存，录 HAR 时视频也嵌进去，超限后静默放弃 HAR 恢复。`capture.mjs:591`、`build_clone.mjs:68`、`linker.mjs:103`（中，没量过实际 HAR 大小）
- AI 修复补丁的 `fixes.css` 只注入 `clone/index.html`，重建后丢失，历史却仍记"已保留"。`differ/fixup.mjs:62`（中）
- 移动端还原度：`build_clone.mjs:342` 的多视口变体没做视频封面和画布光栅化，会直接拉低演示里的移动端数字（审查员列为采集区第 2 件事）

**SEO 与 live**（审查员）
- 基线的"稳定分"是全站扣分求和、没除页数，而总分是页均：多页站恒为 0，`--tolerance` 分数跌幅门禁形同虚设。`seo/baseline.mjs:93`（高。我读码确认了"求和后封底到 0"，没跑）
- 无基线时，抽样里只要有 4xx 或 5xx 页就直接失败退出，而且不落基线。`seo/audit.mjs:283-293`（高）
- 基线里的页本次没抽到（比如被 `--max` 截断），就报 critical 的 `page-missing`。`seo/audit.mjs:95-133`（中）
- `seo-gate.yml` 现状必红：我核对了，`config/seo-targets.txt` 没有任何有效目标行，`config/seo-baseline/` 里只有 README；另外"更新基线"模式仍带 `--fail-on-regression`，刚覆盖完基线又失败（高）
- CSV 没有公式注入防护（`seo/report.mjs:18`）；`live/serve.mjs:335` 的异步处理函数没有顶层 try/catch，HAR 里状态码非法会让进程退出（中）

**引擎与 Docker**（审查员）
- 写操作的守卫不一致：`replace-domain` 的判断写反了（无 Token 的非本机请求被放行，其他几处是拒绝）；`llm/test` 没有守卫，会拿已存的 Key 发往调用者给的地址；回收站清空、登录接口也没有。`engine-server.mjs:1950` 附近（中）
- 取消整站克隆只杀了 queue 进程，它启动的 forge 子任务还占着槽；`queue.json` 不是原子写（`fsutil` 里已有原子写工具）；看门狗只管 forge 和验收（中，读码）
- `/px/` 代理会跟随重定向，可被上游引到内网，还把 `set-cookie` 原样透传（中）
- 设置接口不拒绝带换行的值，可往 `.env` 里注入白名单之外的键（`settings.mjs:145-163`）；`LLM_MAX_RETRIES=abc` 会变成 NaN（`llm.mjs:36`）
- `docker-compose.yml` 默认把 8900 开在所有网卡、Token 默认注释掉；容器里"是不是本机访问"只能看到网桥地址，没 Token 时写配置也会被 403；Chromium 以 root 运行。建议绑 `127.0.0.1:8900`、Token 与 `HEIMDALL_TRUSTED_HOSTS` 成对配置、加 `USER node`（后者要先确认 Playwright 浏览器目录的权限）（中，未实跑）

**验收子系统**（审查员）
- `atomic-file.mjs:29-31` 先改名、不 fsync：断电可能留下空的 `catalog.json`，而且不会回退到上一份，之后所有验收写入都返回 503。动手前先看 atomic-file 的测试有没有断言调用顺序（事实高，影响中）
- `recovery.mjs:15,45-47`：run 目录超过 1024 个，启动恢复就卡住，之后写入全是 503，全仓没有清理逻辑（中）

**控制台**（审查员）
- `Atlas.vue:1078`：克隆事件流断开时只关闭、不置失败，节点永远显示"克隆中"；`:681` 的侦察同理（高）
- 详情面板的缓存放在组件里，而组件的 key 随选中变化，每点一颗星都重拉资产缺口。`Atlas.vue:2202`、`DetailDock.vue:127`（高）
- 整站克隆、审计、导出都没有"停止"按钮；后端 `/api/jobs/:id/cancel` 只有验收执行在用
- 小毛病：`--text-faint` 在 surface-2 上对比度是 4.44:1，低于 4.5；两处用了没定义的 `var(--font)`（应为 `--font-ui`）；`aria-busy` 少了冒号；`ui.css` 里 `rail-sweep` 重复定义
- 对照：约 50 条前端请求逐条对照后端路由，都存在；`v-html` 为 0 处

**测试与工程**（审查员）
- CI 上传失败证据的路径，缺 `baseline-console`、`managed-reading-*`、`owned-recovery-*` 等目录
- 根 `package.json` 的 27 条 `acceptance:*` 与 `core/package.json` 逐条一致，没有漂移；但 14 份 `docs/competition` 文档按根级命令书写，要删根上的别名得先批量改文档
- `smoke-upgrade-failure.mjs` 零引用，但断言有价值（构建失败后原克隆字节不变），建议改成 `*.test.mjs`，别删
- Node 口径不统一：CI 用 22，Dockerfile 用 24，`engines` 写 ≥20.19，本机是 25；CI 从没跑过 20

### P2：赛后再做

- 拆大文件：`engine-server.mjs`（按 http 工具、镜像代理、任务、视图、存储五块）；`Atlas.vue`（12 份重复的事件流样板约 560 行，抽成 `useEngineTask.js` 可省约 400 行，再拆设置页和报告页）；`catalog.mjs`（单个闭包 1092 行、约 60 个内部函数）
- 收敛重复：CSS `url()` 与 `@import` 扫描至少 5 份（并入 `css-refs.mjs`）；`isMain` 有 17 种写法；站点名正则约 22 份；遍历目录 5 份；验收里 RUN_ID 正则 8 个文件、SHA 正则 15 处、`sameFile` 约 13 份且强度不一（`managed-dispatch-store.mjs:15` 不比较 mode 和 nlink，`managed-run-files.mjs:26` 比较）。**注意避开上面的"指纹陷阱"**
- 删死代码：未用的 import 约 8 处（如 `engine-server.mjs` 的 `writeFileSync`、`llmChat`），`runScriptBool`、`isConservative`、`listLegacyAcceptanceRuns`、`har.mjs` 的 `mergeHar` 等。审查员都 grep 过，删之前请你再 grep 一次
- 评估删除 v1、v2 的目录迁移代码：约 12 个文件、其中迁移相关测试和脚本约 1.4k 行。先确认你本机默认根下没有旧 `catalog.json`（审查员查过没有；若你设过 `HEIMDALL_DATA_DIR`，请自查 `schemaVersion`）
- 工程底座：LICENSE（现在是 UNLICENSED，开源或提交前要定）、`dependabot.yml`、ESLint 的 `no-undef` 与 `no-unused-vars`（`engine-server.mjs` 的注释里记过一次变量作用域漏写导致引擎退出）、覆盖率报告、CHANGELOG
- 依赖小落后（不紧急）：`playwright` 1.63.0 到 1.64.1，`pixelmatch` 7.2.0 到 8.0.0，`vite` 8.3.1 到 8.3.5，`vue` 3.5.43 到 3.5.44。`pnpm audit` 在你当前的镜像源（npmmirror）上没有审计接口，**漏洞扫描没做成**

## 6. 那 380MB 证据怎么瘦身

**现状**
- 已跟踪 8418 个文件，`docs/audits` 占 7712 个、约 380MiB；`.git` 本身 261MB
- 大头：14 个 zip 共 107MB，282 个 gz 共 92MB，1149 张 png 共 80MB，4068 个 json 共 61MB
- 每个 CI job 都要把这些检出一遍

**为什么不能直接删**
1. 7 个测试和 3 个脚本类文件直接读里面的文件当夹具，而且没有"文件存在"的守卫，删了就红
2. 审计报告按字节数和 SHA-256 引用它们。比如三个 `complete-evidence.zip` 合计约 103MB，里面有 5544、2208、1088 个文件，别处没有解开的副本
3. `check:docs` 会校验报告里指向这些文件的链接，删了会红

**三步方案，按风险从低到高**

| 步骤 | 做什么 | 工作量 | 风险 |
| --- | --- | --- | --- |
| 1 | 把测试真正用到的几棵小目录复制到 `core/test/fixtures/audit-archive/`，改 10 处路径，加"文件存在"守卫。用到的是：`2026-10-16/evidence/` 下的 `acceptance-spec-execution-control/preparation/prepared-record.json`、`acceptance-catalog/console/`、`acceptance-spec/console/run-evidence/`、`acceptance-baseline/console/`，以及 `2026-10-17/evidence/acceptance-managed-store/managed-preparation/prepared-record.json`。做完，测试就不再依赖 `docs/audits` | 半天 | 无 |
| 2 | 把大件挪出仓库：三个 `complete-evidence.zip`（约 103MB）、`2026-10-18/evidence/defect-tickets/` 整个目录（约 60MB，其中 56 个 tar.gz）、各处的 CI `run-logs.zip`。放到 GitHub Release 或单独的证据仓库，仓库里只留 `INDEX.json`（它已经记了字节数和 SHA-256）和下载链接。文件本身不变，哈希仍然成立；`check:docs` 本来就不检查外部链接 | 1 天 | 低。要同步改报告里的链接 |
| 3 | 用 `git filter-repo` 把历史里的大件抹掉，`.git` 才会真的变小 | 半天 | **高，不可逆，要你拍板** |

关于第 3 步：它会改写所有提交哈希。远端 `origin`、5 个 codex 工作树、已推送的 `codex/acceptance-demo-d7` 都得重来，文档里写的提交号（如 `c170f50`、`5006e16`）也会失效。我没做，也不建议在比赛期间做。做完 1、2 步，**新提交**就不会再长胖，这已经解决了大部分日常痛点。

另外，本机 `docs/audits` 里还有 51 个被 gitignore 的文件（约 17MB，如 `engine.log`、`verify-*.log`）。它们不在 git 里，删了就没了，我没动。

## 7. 接下来四周怎么走（10-23 到 11-20）

| 周 | 目标 | 具体做什么 |
| --- | --- | --- |
| 第 1 周 | **止血：CI 连续 3 次绿** | 修 P0 第 1 条的冒烟竞态；`pnpm test` 分两片；删重复的 `console` job；补全失败证据的上传路径；加一步 `docker build .`；改正 README、HANDOFF、ROADMAP 里的 CI 状态句 |
| 第 2 周 | **讲顺故事** | 重写 `DEMO-SCRIPT.md`。加 60 到 90 秒"验收"一幕：先跑 `acceptance:benchmark` 夹具，展示检出和门禁，再用 triage 做 AI 解读（注意：AI 解读只支持旧式运行，也就是 Mirror 和 Regression；托管运行的 `triageSupported` 是 false，演示要走前者）。README 首屏改成"一句话 + 一张图 + 三步启动"，D1 到 D6 挪进 docs，catalog、managed、defect-ticket 降成"高级治理"。把"AI 用在哪"讲成卖点：确定性检查做门禁（可复核），AI 只做解读、修复建议和情报——文档和演示稿 Q3 本来就是这个设计 |
| 第 3 周 | **冻结与瘦身** | 冻结验收的新功能；做瘦身第 1、2 步；补 LICENSE、`dependabot.yml`、ESLint 两条规则、`.node-version`；统一 Node 口径；从 P1 的采集与克隆项里挑最影响演示的 3 到 4 个修（冻结样式泄漏、视频封面、全局替换、移动端变体） |
| 第 4 周 | **彩排** | 在另一台机器上全新 clone，照着脚本完整走一遍；录一份兜底视频；只修彩排中暴露的问题 |
| 赛后 | 还债 | 第 5 节的 P2 清单 |

## 8. 方法与局限

- **实测的**：引擎崩溃、Docker 健康检查、SEO 空值、heal 越界写、CORS 预检、`.env` 里的 Token 不生效、测试乱写目录、CI 成败统计、密钥扫描。密钥扫描包括：tracked 文件里找常见厂商密钥格式的串；真实 `core/.env` 里的 LLM 密钥在 git 全部历史里搜过，**没出现过**
- **只读码的**：第 2 节的 #3、#6、#8，以及基线"稳定分"求和
- **审查员报告、我没逐条复现的**：第 5 节里标"审查员"的全部
- **没做的**：真实 `docker build`；依赖漏洞扫描（镜像源不支持审计接口）；Linux 实跑——本机是 Windows，12 个用例因平台条件被跳过，CI 在 Linux 上才会跑它们，所以"本机全绿"不等于"CI 全绿"；整站克隆端到端；控制台打包体积
- **审查员没读透的文件**：`motion*.mjs` 后半、`operation-candidates`、`operation-dependency-parity`、`source-read-data`、`extract/components` 后半，以及 `seo/` 下的 pagination、structured、probe、coverage、privacy-audit、third-party-services
- **测试口径**：
  - 基线：2759 个，2747 通过、0 失败、12 跳过，约 26 分钟
  - 改动后全量：2764 个，2752 通过、0 失败、12 跳过，约 22.5 分钟
  - **全量跑完之后**我又改了：演示稿与规则数守卫（单独跑 4 个通过）、3 个乱写目录的测试（单独跑 52 个通过；保留开关的用法另跑 40 个通过）。这几处没有再整套重跑

## 附录

### A. 怎么复核

```bash
git status --short
git diff --stat
pnpm -C core lint
pnpm -C core check:docs
cd core && node --test test/seo-collect-empty-meta.test.mjs test/seo-i18n-jsrender.test.mjs test/seo-rule-count.test.mjs test/live-health.test.mjs
```

### B. 怎么撤销

- 撤销单个文件：`git restore -- <路径>`
- 找回被删的文件：`git restore -- pnpm-lock.yaml core/src/differ/keeprate.mjs core/scripts/smoke-console-cdp.mjs docs/archive`
- 全部撤销（**会丢掉这一轮所有修改**）：`git restore .`，再手动删掉两个新文件 `core/test/seo-collect-empty-meta.test.mjs` 和 `docs/audits/2026-10-22/`

### C. 建议怎么提交（拆三个）

1. `fix:` 引擎崩溃、SEO 空值、heal 越界、queue 端口，连同回归测试
2. `chore:` Docker 与开发配置、`.env.example`、演示稿数字
3. `chore:` 删除死文件和旧归档、测试不再乱写目录、本报告

### D. 你本机的待处理清单（我没动）

- 2 个 stash：`stash@{0}` "Preserve main first-fstat bytes before verified D1 ff"（改了 `managed-run-reader.mjs` 和一个测试）；`stash@{1}` "D1 before display-head hotfix 0988fc3"（38 个文件）
- 5 个 codex 工作树，在 `C:/Users/44548/.codex/worktrees/` 下：`acceptance-demo-d7`、`browser-start-resolution-d4`、`ci-small-runner-concurrency`、`defect-ticket-closure-d5`、`managed-spec-provenance`
- 17 个本地分支，其中 15 个已合并进 main（`git branch --merged main` 可列出）；`codex/acceptance-demo-d7` 没合并，且已推送到 origin
- 仓库在 GitHub 上是私有的

## 9. 当前状态（2026-10-23，本分支的新状态）

这一节是唯一"现在为真"的部分；上面各节是审查当时的样子。

**已经落地的（19 个提交，分支 `chore/review-sweep-2026-10-22`）**

| 领域 | 做了什么 | 怎么验证的 |
| --- | --- | --- |
| CI | 拆成 `core-test`（2 片，各约 15 分钟）、`core-smoke`、`core-lint`、`console` 四个 job；补上 `docker build .`；失败证据上传路径补齐 | YAML 解析 + 逐 job 列步骤；分片参数本地实测被 `test-core.mjs` 透传 |
| SEO | 站点稳定分改页均；普通审计不再因 4xx 退出且能落基线；基线页并入目标集，`page-missing` 只报真消失；seo-gate 更新模式不再自相矛盾 | 本地夹具实测（1/3/10/40 页都得到 88；plain exit 0、gated exit 1；真 404 仍报） |
| 引擎 | 8 处写操作统一守卫；`replace-domain` 写反的条件修正；`llm/test`、`session/login`、`session DELETE` 补守卫 | 引擎绑 0.0.0.0：回环写 200、局域网写 403、读不受影响 |
| 采集 | 8 项：CSS 注释重复输出、linker 子串替换、类型嗅探顺序、空剥离列表剥光脚本、data-URI 误判缺口、视频海报漏拷、多视口冻结样式泄漏、`fixes.css` 重建丢失 | 每项先本地复现再改，各带回归测试；反向验证旧代码会失败 |
| 控制台 | 断流置失败、缓存 LRU、停止按钮、人话错误卡片、空状态、对比度与 ARIA、验收视图懒加载 | `vite build` 通过；主包 494→189 kB（gzip 155→63） |
| 测试 | 3 个乱写目录的测试改为临时目录并清理；验收证据迁到 `core/test/fixtures/audit-evidence/`（58 文件 / 176 KB），带缺失即报错的守卫 | 相关 470 个测试通过，2 个 POSIX FIFO 跳过 |
| 仓库 | 删空壳锁文件、两个零引用脚本、6 份旧周报；6 棵最大且无代码引用的证据子树移到 `docs/archive/audits/`；证据树标记 `-text` 保住原始字节 | `check:docs` 全绿；搬迁前后 620 个 blob 逐字节比对一致 |
| 文档 | README 首屏改成"三件事 + 两步启动"；D1–D6 折叠；改正"53 条规则""≤3 轮""节流可配""/lm 备用"等与代码不符的说法 | 规则数守卫纳入 `DEMO-SCRIPT.md`；逐条读码核对 |

**仍然待办的（按我现在的排序）**

1. **等一次绿 CI 再合 main。** 第 1 节的 CI 红是审查当时的快照；本分支改完后需要一次真实 CI 确认。分片把单 job 从 39 分钟压到约 15 分钟，但仍需观察 2–3 次。
2. **验收指纹清单不一致**（第 5 节"陷阱"）：三个清单互不一致，统一会让已有指纹全部作废。建议给这 10 个文件加"冻结"标记文件头，而不是现在去统一。
3. **`resetContext()` 会在进行中的只读 GET 上 abort 响应体**（D6 冒烟的 CI `ERR_ABORTED` 根因）。属于权限/重连语义，改动面大，单独立项。
4. **`docs/audits` 还剩约 270MB**：下一批候选是 `defect-ticket-decisions-final`（35MB、5 处 md 链接、0 代码引用）、`defect-tickets`（60MB）、`catalog-schema4`（19MB）等；它们仍被 md 引用，需要同时改链接。`.git` 体积要真正下降需要 `filter-repo`，是否做由你决定。
5. **P2 重构**：`Atlas.vue` 仍有约 2,500 行（9 条任务流已统一挂载，但 `runAudit`/`runLiveExport`/`runCloneSite` 三个 runner 仍近乎重复）；`engine-server.mjs` 2,460 行；`catalog.mjs` 1,092 行。
6. **工程底座**：LICENSE（仍为 UNLICENSED）、`dependabot.yml`、ESLint 的 `no-undef`/`no-unused-vars`、覆盖率、CHANGELOG。
7. **演示稿重写**：第 7 节第 2 周的"加一幕验收"还没做；`DEMO-SCRIPT.md` 目前只改了两处与代码不符的说法。

---

## 10. 2026-10-24 追加：把"跑得完"这件事补上（5 个提交，已在 `main`）

上一节列出的待办里，第 1 项（等绿 CI）之后真正卡住全站验证的是另一件事：**`verify --all` 没有断点续跑**。407 页按小时计，中断一次就归零 —— 这才是"402 页待测"一直推不动的根因。这一轮按顺序做了：

| 改动 | 解决了什么 | 怎么验证的 |
| --- | --- | --- |
| `verify --resume`（`71af14d`） | 复用已完整测成、且 `manifest.json` / `clone/index.html` 都没比结果更新的页；未测成的页一律重跑；摘要里 `reused` 与 `measured` 分开计数，门禁仍要求全部页测到 | 5 条新用例：复用 / 未测成重跑 / 克隆更新后重跑 / 视口变化重跑 / 只能配 `--all` |
| 有界置信度（`0b1a1ba`） | 超时不再只有一句 `render did not settle`：记录卡点（请求未结束 / 图片未加载 / 版面仍在动 / 滚动后仍增长），并分 `full` / `bounded` / `none` 三档；只有 `--allow-bounded` 才把 bounded 计入分数，**默认口径逐字未变** | 长轮询页默认仍判未测、开 `--allow-bounded` 后计入且单列 `bounded`；"版面还在动"的页开不开都拦下 |
| `verify --jobs N`（同上） | 按页并行（默认 1，上限 8），结果按目录序重排保证可复现 | verify CLI 全部 20 项用例（含原有 15 项）通过 |
| `heimdall handoff <url>`（同上） | 侦察→克隆（增量）→验证（断点续跑）→资产→交付一条命令；自起临时引擎（`queue` 走 HTTP 提交，没引擎整条链会死在 "engine unreachable"）；写 `handoff/README.md`，第一段先说"测到多少页、没测到的卡在哪" | 本地两页夹具站点全链路跑通（2/2 页完整测到、交付包生成、退出码 0）；交接说明渲染有 6 条单测 |
| 控制台状态进 URL（`f36cbf6`） | `?site=&view=&page=`；切视图 push（后退能在视图间走），选页 / 切站 replace | 浏览器实测：刷新恢复视图与详情面板、后退回上一视图、切站 URL 跟随 |
| 进度与"下一步"（同上） | 体检显示 `3/41 · 还剩约 N 分钟`（按本次会话速度估算，复用页不计入）；失败任务行给出最常见卡点与两条可执行命令 | `console/test/format.test.mjs` 5 条用例 |

**这一轮新发现、值得记一笔的两个坑**（都已修，原因写在这里免得下次再踩）：

1. `pickSite()` 没有返回它内部那条异步链，于是"按 URL 恢复选中页"永远在星图建好之前执行。
2. 修了第 1 条之后还有一层：**找到节点 ≠ 恢复成功** —— `onNodeClick` 在页面状态加载期间会直接返回，而旧代码此时已经放开了地址栏同步，`page` 当场被抹掉。现在只有 `selected` 真被设上才算恢复完成。

**仍然待办**（在上一节基础上更新）：

1. **已推送**（2026-10-24，`c47e946`、`d1af628`）。两次真实 CI 的结果：
   - 第 1 次（`40073050122`）3 处失败：Docker 交付验收那一步是**本分支拆 CI 时引入的**（新加的 job 没装 Chromium，严格导出的断网浏览器探针直接失败）；另两处是计时竞态（Schema4 smoke 在验收执行槽释放前就发下一个 run → 409；named-session 用例的通过型断言只给了 100ms）。三处均已修（`d1af628`）。
   - 第 2 次（`40080692099`）：core 两片测试、lint/docs/Docker、console 全绿；**e2e smoke 里 `Browser start resolution` 的 native-locks 段失败**。这一段本轮没有改动，历史上 3 次跑过都是绿的。
2. **跨标签回执竞态 —— 已修（`208fe2e`）**。验收工作台在浏览器本地记"待核对的操作"（Browser 启动确认、人工缺陷单确认）时，原先用 Web Locks 串行"读 localStorage → 改 → 写回"；锁只保证一次一个持锁者，不保证读到别的标签刚写的值，负载下会把已解除的确认写回、或丢掉新确认（CI `40080692099` 多出的那条记录即此；本机压测 300 次全丢）。现在每次写都在 IndexedDB 读写事务里对**已提交的值**做决定（`console/src/receipt-collections.js`），localStorage 只做逐字节相同的镜像供同步展示与既有证据读取；旧版本留在 localStorage 的确认首次写入时会被接管、不会丢。新增 `core/test/receipt-collections-browser.test.mjs` 在两个独立 Chromium 渲染进程里跑真实模块：旧代码稳定复现（40 轮中 3 轮写回已解除确认；30 轮中 1 轮放进两条缺陷单确认），新代码 3 次全量运行全过；相关 105 项单测、start-resolution / D3 / D5 / D6 smoke 与 D6 校验本机均通过。
3. `core/scripts/verify-historical-batch.mjs` 仍是逐页独立子进程，**没有接入**新的有界置信度口径；那三个未测页要先用 `verify <host> <page> --allow-bounded` 单个复核，再决定是否改造脚本。
4. `handoff` 已在真实站点 `example.org` 上跑通一次（2026-10-24，`--max-pages 3`：侦察 1 页 → 克隆 1/1 → 验证 1/1 页完整测到 → 资产缺口 0 → 交付包生成，退出码 0，耗时约 45 秒）。但这只是一个单页静态站，**多页、SPA、带长轮询的站点仍未验证**；卡点分布与交付包体积仍无真实样本。
5. 本机全量回归：2796 项、2783 通过、1 失败、12 跳过。失败项是 `acceptance-managed-executor-engine` 的 fixture 在满负载下等引擎启动超时，**单跑 6/6 通过**，属已知的并发间歇项，与本轮改动无关。
6. 验收指纹冻结标记、`resetContext()` abort、`docs/audits` 剩余 270MB、P2 重构、LICENSE / dependabot / ESLint 仍未动。
