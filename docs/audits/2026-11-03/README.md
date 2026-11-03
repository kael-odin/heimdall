# Heimdall 全仓审查、修复与复测（2026-11-03）

- 审查基线：`main` / `b1536df92d21f38c59e68ac32897753363f8e38e`
- 审查方式：文档与源码全量巡检、质量门复跑、固定夹具基准、真实浏览器流程、
  隔离行为探针、GitHub workflow 与依赖审计
- 处理原则：先保留原始失败证据，再在当日修复，最后用同一路径复测；不把
  “源码看起来改了”当成通过
- 证据等级：
  - **真实流程**：当前产品命令或生产 UI 实际执行
  - **离线复现**：隔离数据根、回环服务或固定夹具上实际执行
  - **源码确认**：只读代码和配置得出，未做破坏性实验

## 一句话结论

**这是一个检测能力很强、测试底盘很厚的工程原型；本轮把主链路、安全边界、
取消语义、安装、CI 和依赖问题都做了实质修复。现在可以认真内部试用，也可以拿
授权项目做验收，但仍不能说“任意网站开箱即成熟产品”。**

固定输入下的确定性检测仍然是它最硬的部分：18 个验收案例中 13 个已知 BUG 全部
检出并定位到注入源码，5 个非 BUG 零误报；QA 的 21 个注入缺陷全部检出、3 个健康页
零误报。弱点不再是“主流程根本跑不通”，而是外部真实项目泛化、超大模块耦合、
非本机部署策略和长期产品化。

## 最终验证结果

| 检查 | 最终结果 | 证据级 |
| --- | --- | --- |
| `pnpm -C core test:full` | **3,010 条，2,998 pass，0 fail，12 skip，约 28 分 16 秒** | 真实流程 |
| `pnpm -C core lint` | 701 个文件通过 | 真实流程 |
| `pnpm -C core check:docs` | 668 个本地目标 / 126 个文件通过 | 真实流程 |
| `pnpm -C core check:frozen` | 14 个冻结验收文件通过 | 真实流程 |
| `pnpm check` | 根级门禁全通过：fast 1,186 条、MCP、skills、审计与 D7 | 真实流程 |
| `pnpm acceptance:demo:smoke` | D7 `accepted:true`，普通控制台错误 0 | 真实流程 |
| `pnpm acceptance:benchmark` | 18/18；13/13 BUG；13/13 源码定位；0 误报 | 离线复现 |
| `pnpm qa:benchmark` | 21/21 缺陷；0/3 健康页误报；P=R=F1=1 | 离线复现 |
| `pnpm -C console build` | 通过；最大 chunk 477.84 kB，无 >500 kB 警告 | 真实流程 |
| Chromium 控制台 E2E | 真引擎、真数据、WebGL2 上下文可用且未丢失 | 真实流程 |
| core / console / MCP `audit` | 三套官方 registry 均为 `No known vulnerabilities found` | 真实流程 |
| MCP 安装、测试、插件检查 | 干净安装通过；2/2 测试；插件产物最新 | 真实流程 |

12 条 skip 主要是跨平台互斥用例，例如 Windows 上的 POSIX FIFO、Linux 上的
Windows 文件句柄，以及未开启 Docker 环境变量时的容器网络测试。

本机最终全量跑在 Node `v26.12.1`。仓库 `.node-version` 和 GitHub Actions 使用
Node 22；Hosted CI 的结果是独立权威证据，不能用本机 Node 26 结果替代。

## 发现、修复与复测

### R-01 D7 完整演示断在第一步（P1，已修）

初始真实流程有两个问题：

1. 控制台切到验收视图会补 `view=acceptance`，演示上下文只接受恰好两个参数，
   因而丢掉本地演示状态。
2. 冒烟脚本又要求地址与启动 URL 逐字相等，导致即使工作台能打开，脚本也先失败。

修复：

- 演示上下文只额外允许唯一的 `view=acceptance`；其他未知、重复、敏感参数继续拒绝。
- 冒烟改成校验同源、路径和启动参数仍在，不再锁死整条查询串。
- D7 冒烟进入 `pnpm check` 和 Hosted CI。

复测：最终控制台构建上从全新会话真实完成采集、来源归属、候选保存、已知 BUG、
两项人工成员成单、1/2 禁关、2/2 复验通过后明确关闭、Markdown 下载。结果为
`accepted:true`，普通控制台错误为 0。

### R-02 `/px/` 可被跨源重定向逃逸并回传 Cookie（P1，已修）

初始探针确认：白名单站点的 302 能把代理引到另一个回环端口，目标服务实际收到
请求，最终 `Set-Cookie` 也会回传给调用端；响应还没有明确超时与体积上限。

修复：

- 新增 `core/src/px-proxy.mjs`，改为 `redirect:'manual'`。
- 最多 5 跳；每跳重新校验 HTTP(S)、同 origin、无 userinfo；跨源跳转在第二跳
  发请求前阻断。
- 剥离 `set-cookie`、`set-cookie2` 与 hop-by-hop 头。
- 总时限 30 秒，响应体上限 32 MiB。

复测：真实回环 HTTP 集成测试中，跨源 302 返回 502 且目标服务零命中；首跳和终跳
的 Cookie 都没有出现在客户端响应里；同源跳转正常。

剩余边界：解析后 IP 拒绝、端口策略、DNS rebinding 防护仍属于非本机部署前必须
完成的统一出站策略；本轮只关闭 `/px/` 的明确逃逸口。

### R-03 取消整站克隆后页面任务继续跑（P1，已修）

初始探针中，取消只结束 queue 子进程，queue 通过 HTTP 启动的 forge 仍然是
`running`，后台继续访问目标站、占用浏览器和槽位。

修复：

- 任务模型增加 `parentId` / `childTaskIds`。
- queue 通过 `HEIMDALL_PARENT_TASK_ID` 声明父子关系，`/api/forge` 验证父任务
  仍在运行且属于 clone。
- 取消 clone 时递归取消它拥有的 forge；父任务失败或取消也会终止仍在运行的子任务。

复测：真实启动引擎、整站 clone、慢页面 forge，再取消 clone；取消响应列出子任务，
forge 最终进入 `cancelled`，慢请求连接关闭。

### R-04 沙箱克隆页的本地字体与遮罩被 CORS 拦截（P1，已修）

克隆 HTML 在没有 `allow-same-origin` 的 sandbox 中运行，页面是不透明源；字体、
图片和 CSS mask 都按 CORS 请求。旧引擎 `/static` 只给白名单控制台 origin 回 CORS。

修复：

- 只对 `workspace/<site>/pages/<page>/clone/` 下的字体、图片、CSS 返回
  `Access-Control-Allow-Origin: *`。
- HTML、脚本、JSON、截图和其他工作区文件不放宽。
- 引擎静态路由与克隆预览服务使用同一验证口径。

复测：真实 Chromium 中 `document.fonts` 为 `loaded`，CSS mask 成功请求；页面仍是
不透明源；`data.json` 从页面内读取失败；HTML 与 JSON 响应没有 CORS 放宽头。

### R-05 MCP 干净安装被 esbuild 构建决定卡死（P1，已修）

旧 `packages/mcp/pnpm-workspace.yaml` 还是占位文本，`pnpm install --frozen-lockfile`
直接因 ignored build scripts 失败。

修复：

- 显式允许 esbuild 构建。
- 插件构建新增 `--check`，比对单文件、prompt 副本和 `BUILD.json`。
- MCP 测试、插件检查和 skills 同步进入总门禁；CI 增加独立 MCP job。

复测：干净临时目录安装成功，16 个包完成；MCP 2/2 通过；插件产物检查为最新。

### R-06 CI 未守主分支，总门禁漏主线（P1，已修到可复验）

审查开始时 `CI` 与 `Docs` 均为 `disabled_manually`，当前提交没有 Hosted 结果；
总门禁也不包含 D7、MCP、skills 和依赖审计。

修复：

- 仓库确认已公开，两个 workflow 已重新启用。
- `pnpm check` 纳入 MCP、skills、三套依赖审计和 D7。
- Hosted CI 增加 MCP 与 dependency-audit job；Core 继续在 Node 22 上分两片跑全量。
- 纯文档提交由 Docs workflow 做链接和规则数字守卫。

复测边界：本地总门禁已可执行；真正的 Hosted Node 22 结论必须以本次提交后
GitHub Actions 的精确 SHA run 为准。若 Hosted run 失败，继续修，不以本地绿灯代替。

### R-07 依赖与 pnpm 工具有已知漏洞（P2/P1，已修）

初始审计：console 7 个漏洞（含 2 high），core 2 个 moderate。继续复核时又发现
项目固定的 pnpm `11.7.0` 自身有 4 个 high 级供应链漏洞。

修复：

- Vite `8.3.1 → 8.3.5`，固定 `source-map-js 1.2.2`。
- ExcelJS 传递依赖固定为 `uuid 11.1.1`、`minimatch 11.0.4`。
- pnpm 全仓、CI、SEO gate 统一到 `11.28.10`，重新生成三个锁文件。
- 新增根 `audit` 脚本和 Hosted dependency-audit job。

复测：core、console、MCP 三套官方 registry 审计均为
`No known vulnerabilities found`；干净临时锁文件目录也能独立通过。

### R-08 Windows 重建安装器的命令拼接风险（P2，已修）

旧 `rebuild init --registry` 在 Windows 上把参数拼到 `shell:true` 字符串里。

修复：

- registry 只接受无凭据 HTTP(S) URL。
- Windows 调用仍经 `cmd.exe /d /s /c pnpm.cmd`，但所有参数先过无 shell 元字符白名单。
- `shell:false`，禁止 `& | < > ^ % !` 等注入字符。

复测：单测覆盖合法 registry 与多种注入；真实 `pnpm --version` 也通过新封装执行。

### R-09 原子写耐久性与 Windows 硬链接假阳性（P2，已修并稳定）

修复：

- 验收原子写先 `write → fsync → close → rename`。
- POSIX 在 rename 后再 `fsync` 父目录；Windows 使用其文件系统已有的替换语义。
- 真实 Windows 文件锁竞态继续覆盖。

全量首次重跑时，另一个硬链接测试在 Windows 并发环境里用 `stat.ino` 比较出现一次
假失败；内容隔离断言实际已经通过。测试改为直接比较 `nlink` 从 2 变 1，连续复跑
20 次通过，随后整轮全量全绿。

### R-10 Console 首屏包体与 Three 运行时（P2，已修）

旧 `Graph3D` chunk 约 1.40 MB，触发 Vite 大包警告。

第一次拆包把 Three 内部循环依赖切成多个 chunk，构建仍然“成功”，但真实浏览器里
`Graph3D` 抛 `r is not a constructor`，星图根本没有挂载。这个失败被最终浏览器 E2E
抓住，说明只看构建输出不够。

修复：

- Three 核心模块与 WebGL 内部模块各自保持完整组，不再按 `maxSize` 切裂循环依赖。
- 使用 Three ESM 源入口做 tree-shaking，并把 WebGPU stub 到明确报错的最小模块。
- Graph3D 自身的 WebGL E2E 增加 canvas 尺寸、WebGL2 context 与 `isContextLost()` 断言。

复测：最终最大 chunk 477.84 kB，无 >500 kB 警告；真引擎 + 真 Chromium 的星图
WebGL2 上下文正常，后续控制台关键路径 E2E 继续通过。

### R-11 文档说法落后于代码与实测（P2，已修）

已同步：

- README 的 CI 红状态、仓库结构与总门禁。
- STATUS 的全量数字、Hosted 边界和剩余短板。
- DEMO 的 A-3 手测状态与 3,010 条测试口径。
- ROADMAP 的 D7 完成状态与字体 CORS 历史口径。
- 安全 PRD 的 `/px/` 当前实现与仍待做的非本机策略。
- 审计索引与 CHANGELOG。

## 当前能力边界

### 已经真正成立

- **克隆与测量**：捕获、静态/交互镜像、多视口验证、SEO、交付包和多类本地夹具。
- **项目验收**：Mirror / Regression / Spec、固定证据、人工缺陷单、复验与明确关闭。
- **AI 重建接入**：简报、修复包、门禁、CLI / MCP / Claude 插件与失败镜像兜底。
- **QA**：无参照物巡检、有限探索、基线、裁决记忆与报告。
- **工程底盘**：严格证据哈希、原子写、所有者锁、取消与重启恢复、真实浏览器回归。

### 仍然没有解决

- **外部泛化没有数据集级证明**：18/18 和 21/21 都来自仓库固定夹具，不能外推为
  任意真实网站、任意业务状态机的检出率。
- **非本机部署没有完整 SSRF 策略**：`/px/` 已修，但统一解析后 IP 校验、
  连接时防 rebinding、端口策略仍需在暴露到共享网络前完成。
- **大模块耦合**：`engine-server.mjs`、`Atlas.vue` 仍有约 2,600 行；
  HTTP 路由、任务生命周期、UI 状态与验收存储紧密相邻，继续加功能会提高回归成本。
- **真实授权站点回归仍不足**：尚缺一套持续可复现、有明确授权的真实站点完整样本。
- **产品发布形态仍是开发线**：版本是 `2.0.0-dev`；没有把开发提交包装成正式 release。

## 主观成熟度

满分 5 分，这是工程判断，不是自动指标。

| 维度 | 分数 | 理由 |
| --- | ---: | --- |
| 核心检测与验证 | 4.2 | 固定基准强，证据链、失败定位与回归覆盖扎实 |
| 验收工作流 | 4.0 | D7 真链路已通，订单、禁关、复验和关闭语义真实可跑 |
| 控制台与本地体验 | 3.8 | 功能完整，星图已恢复且拆包成功；页面组件仍偏大 |
| 安全边界 | 3.9 | Token、CSP、路径守卫、代理跳转和 Cookie 已收紧；共享网络策略未完成 |
| CI 与发布 | 3.6 | workflow 已恢复，门禁覆盖明显补强；Hosted 当前 SHA 仍需以 run 为准 |
| 安装与维护 | 3.8 | 干净安装、License、Dependabot、CHANGELOG、审计已补齐；模块仍需拆分 |
| 外部泛化 | 2.6 | 缺少授权真实项目数据集和跨环境持续样本 |
| **综合** | **3.7** | **能认真试用，不能吹成通用成熟产品** |

## 最值得继续做

1. 用一套获授权的真实项目完成“侦察 → 全页克隆 → 验证 → strict 离线 → 接手”，
   并把目标数、通过数、失败原因固定成可重复数据集。
2. 在非本机部署前统一 Node `fetch` 与 Chromium 的出站策略：解析后 IP、
   连接时校验、端口白名单和 DNS rebinding。
3. 拆 `engine-server.mjs` 的路由/任务生命周期、`Atlas.vue` 的视图状态与
   验收展示逻辑；先加测试再迁移，不一次性大改。
4. 用真实 CI 历史建立失败分类，区分产品缺陷、环境缺失和偶发资源争用。
5. 等这套外部泛化与发布门禁稳定后，再从 `2.0.0-dev` 进入正式版本。

## 证据索引

原始失败证据保留在本机，不提交到 git：

| 证据 | 路径 | SHA-256 |
| --- | --- | --- |
| D7 原命令失败 | `core/workspace/_runs/audit-20261103-d7/summary.json` | `04387a2cc44804e5b9af62b98f6add6d93605ec64160ec5d917d4ec2cb2bf812` |
| D7 放宽 URL 后仍失败 | `core/workspace/_runs/audit-20261103-d7-bypass/summary.json` | `9fad8f69e66f679718df9186de982a3cab9f56048fcad112051de77f5434572f` |
| `/px` 跨源重定向 | `core/workspace/_runs/audit-20261103-behavior/px-redirect-probe.json` | `99fd13f80dcf32de9a3d989af6801e1bc9d3a8518214e45de3a07ad8700b815c` |
| 取消 clone 后 forge 仍运行 | `core/workspace/_runs/audit-20261103-behavior/clone-cancel-probe.json` | `c0a8034c4041e9c44b516ff2e676033952fa1b181318e64cf05050c524640a14` |
| 字体 CORS 对比 | `core/workspace/_runs/audit-20261103-behavior/font-cors-probe.json` | `658ac0e8284bc9e3604c1384eabe201273098e5d8d4b37af383cc7f738fc3293` |

最终通过证据：

- D7 最终根门禁运行：`core/workspace/_runs/acceptance-demo-console-7d22ff27-3a5e-4fbd-b739-70a53c503ea1/`
- 干净依赖审计：`core/workspace/_runs/audit-clean-20261103/`
- 验收基准：`core/workspace/_runs/acceptance-benchmark/benchmark-2026-11-03T05-27-43-194Z-2cf9490a/`
- QA 基准：`core/workspace/_runs/qa-benchmark/2026-11-03T05-27-43-216Z/`

这些运行目录被 git 忽略；报告只记录路径与结果，不把大体积截图和缓存塞回仓库。

## 最后一句

如果目标是比赛演示和内部验收：现在可以跑，主链路已经比审查开始时可靠得多。

如果目标是对外承诺“给任意网址都能稳定完成”：还差真实授权数据集、共享网络部署
策略和模块拆分。当前最准确的说法是：**能打，但别吹过头；这次该修的硬问题确实修了。**
