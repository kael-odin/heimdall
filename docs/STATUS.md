# Heimdall 当前状态（STATUS）

> 更新：2026-11-03 · **本页是“当前为真”的唯一入口**。历史接手记录与逐日审计已归档，见文末。

## 一句话

给它一个网址，交回一张全站星图、一份**可核验**的复刻（原件资产 + 三视口实测还原度 + 缺口清单），以及一个能让 AI 代理闭环重建、由确定性门禁裁决的裁判。

## 现在的主线

**AI 原生接入（Bifröst）**：Heimdall 当眼睛、尺子和裁判，外部 AI 代理当手。三条闭环里，当前只保一条：

1. **重建环（比赛 MVP）**：简报 → 分段 → 代理写代码 → 修复包 → 门禁；失败交付镜像兜底（Floor=Mirror）。
2. 行为环、契约环：只做夹具演示或赛后。

原「克隆 + 还原度 + SEO + 验收」能力全部保留，作为重建环的取证层与裁判层。验收子系统不再扩功能，只作为正式门禁被调用。

## 现在能跑什么

```bash
# 单页克隆（不需要先起引擎）
node core/src/cli.mjs forge https://example.com home

# 全流程：控制台 + 引擎
pnpm -C console build
cd core && HEIMDALL_CONSOLE_DIR=../console/dist node src/engine-server.mjs 8900

# 一条命令跑完侦察→克隆→验证→资产→交付
node core/src/cli.mjs handoff https://example.org --max-pages 40

# AI 重建竖线（夹具 F1）
heimdall clone http://127.0.0.1:5090/
heimdall rebuild init <siteId> --page home
heimdall brief --project . --detail sections
heimdall compare --project .
heimdall gate report --project . --level gold
heimdall rebuild deliver --project .
```

## 怎么验（2026-11-03 起）

仓库已经公开；`CI` 与 `Docs` 已重新启用，本地和 Hosted Node 22 都按同一套确定性门禁收口：

```bash
pnpm -C core lint          # 语法 + JSON，701 个文件
pnpm -C core check:docs    # 文档链接
pnpm -C core check:frozen  # 验收指纹冻结文件（14 个源文件的字节哈希）
pnpm -C core test:full     # 全量（含真浏览器、验收存储与控制台 E2E），约 28 分钟
pnpm -C core test:acceptance  # 只跑验收套件
pnpm -C console build
pnpm acceptance:demo:smoke # D7 全链路真实 UI
pnpm -C packages/mcp test  # MCP 协议测试
pnpm run audit             # core / console / MCP 三套依赖审计
pnpm check                 # 本地总门禁
```

2026-11-03 实测：全量 **2,998 / 3,010 通过，0 失败，12 跳过**；耗时
**28 分 16 秒**。`lint` 701 文件、文档 668 个目标 / 126 个文件、冻结验收 14 个文件均通过。
验收基准 18/18、13 个已知 BUG 全检出且 13/13 定位到注入源码；QA 基准 21/21、0 误报。
Console 最大生产 chunk 为 477.84 kB，无超过 500 kB 的警告；三套官方 registry 审计均无已知漏洞。
本轮本机 Node 为 26.12.1；Node 22 的权威结果由 Hosted CI 单独给出。

## 已知边界（不藏）

- 只碰公开页面或操作者本人有权访问的页面；不绕过登录、验证码、访问控制。
- 交互镜像依赖 `*.localhost` 解析；被代理接管 DNS 的环境里打不开，静态镜像不受影响。
- WebGL、运行时画布、视频、滚动编排：只做降级或明确标不支持。
- 大站（>500 页）受并发与页数上限约束；当前并发 2。
- 后端只能克隆“被观察到的行为”，不声称业务等价。
- 固定夹具成绩很强，但尚未取得获授权、持续可复现的外部项目数据集；不能把 18/18 或 21/21
  直接外推成“任意真实网站都能通过”。
- 验收目录默认 Schema3，Browser 链需要 Schema4；演示前先显式维护：
  `node core/src/acceptance/catalog-maintenance-cli.mjs --create --target-schema 4`。
- 引擎启动时若验收目录锁被其他引擎占用，会打印锁文件路径；确认没有其他引擎后，删除该锁文件再启动，不要删除其他验收数据。

## 文档地图

| 想知道什么 | 读哪里 |
| --- | --- |
| 项目价值、启动、产物 | [README](../README.md) |
| 控制台与 CLI 操作 | [USAGE](../USAGE.md) |
| 产品定义与验收等级 | [PRD](../PRD.md) |
| 边界、风险、演示日清单 | [RISKS](../RISKS.md) |
| 5 分钟演示脚本 | [DEMO-SCRIPT](../DEMO-SCRIPT.md) |
| 当前架构（对着代码维护） | [docs/guide/01-architecture.md](guide/01-architecture.md) |
| AI 接入层方案与路线 | [docs/prd/ai-native/](prd/ai-native/README.md) |
| 接入 Claude Code / Desktop 与 A-3 手测 | [docs/guide/06-ai-integration.md](guide/06-ai-integration.md) |
| 验收工作台各专题 | [docs/competition/](competition/acceptance-workbench.md) |
| 无参照物检测的固定基准 | [qa-detection-benchmark](competition/qa-detection-benchmark.md) |
| 待办与长期维护 | [docs/ROADMAP.md](ROADMAP.md) |
| 审计与实施记录 | [docs/audits/README.md](audits/README.md)（证据已外部归档） |

## 2026-11-03 审查修复收口

- D7 真实 UI 全链路通过：采集、来源归属、候选、已知 BUG、两项人工成员、部分修复禁关、
  完全修复后明确关闭、Markdown 下载；最终结果 `accepted:true`，普通控制台错误为 0。
- 取消整站克隆会级联取消仍在运行的页面 forge；`/px/` 只允许有限同源跳转并剥离 Cookie；
  克隆渲染资产按目录与 MIME 开放只读 CORS。
- 恢复 MCP 干净安装、插件产物检查、Windows `pnpm` 参数白名单、原子写文件与 POSIX 目录
  `fsync`、Console WebGL 星图拆包，并把依赖审计接进总门禁与 CI。
- 开源治理补齐 MIT、SECURITY、CONTRIBUTING、CHANGELOG、Dependabot，pnpm 固定到
  `11.28.10`。当前结论仍是“可认真试用和内部验收”，不是“任意站点开箱即成熟产品”。

## 2026-10-30 仓库瘦身

- **文档**：450 份 / 558MB → 88 份 / 4.8MB。逐日审计报告与 536MB 证据移出工作树，索引见 [docs/audits/README.md](audits/README.md)，原件在外部归档与 git 历史。
- **测试**：默认 `pnpm test` 改为快速集（142 个文件 / 1,140 条 / 约 4–5 分钟）；`pnpm test:full` 保留全量；`pnpm test:acceptance` 只跑验收。
- **工程**：新增 `pnpm check` 一键门禁；根目录空锁文件删除并忽略；Node 固定 22（Docker 同步）；`graphify-out/`、`core/spikes/` 不再出现在 `git status`。

## 2026-10-30 修复包：候选侧数值

- 修复包的每个区域新增 `element.cand`（候选元素矩形 + 计算样式）、`element.styleDiff`（`prop / ref / cand / delta`）与 `element.boxDiff`；区域还会补扫 `element.diffs`，把字号、颜色这类落在更小子元素上的差异带出来。
- `packet.txt` 打印「候选样式 / 样式差」，例如 `fontSize 参考 52px / 候选 46px（−6）`；匹配依据与置信度写在 `match` 里，匹配不到时仍只给参考值，不猜。
- F1 夹具验证：字号、背景色、间距三类注入缺陷都能在修复包里给出候选值与带符号差值。

## 2026-10-31 A-3：Claude Code 插件闭环

- Claude Code 插件 `plugin:heimdall:heimdall` 已安装并连通，11 个工具可用。
- 本会话用 MCP 工具完成 F1 重建：6/6 分段 `pass-candidate`，整页 375 99.89% / 768 99.91% / 1440 100%，正式门禁 `passed silver`（验收视觉 3/3、结构 3/3、健康 12/12）。
- 交付包：`agent/deliver/home-20261030T173510Z-cbc82f/`（状态 passed）。
- Claude Desktop 界面 `heimdall_doctor` 9/9 通过（2026-10-31，操作者贴回结果）；配置与 stdio 也已验证。

## 2026-10-31 产品打磨

- `rebuild init` 不再固定抢 5199：不传 `--port` 时自动找空闲端口；显式传了而端口被占用则直接报错，不偷偷换。
- `compare` 的摘要第一屏直接给「首要差异」，例如 `fontSize 参考 52px / 候选 46px（-6）`，代理不必先翻修复包全文。
- AI 活动页新增「最近一次修复包」：显示最近一次**有差异**的区域与样式差；最新一次是干净收尾时，会同时标出「最新一次无差异」。
- `styleDiff` 兼容旧参考索引：缺逐边值时从 `padding/margin/border/gap` 简写推导，避免把「没记录」误报成 0。

## 2026-11-01 无参照物检测：QA 从“跑不通”扩到“跑得通但不对”

- `qa run` 默认在每个页面跑 23 个页面内检测器，分六类：无障碍（`alt`、可访问名、表单标签、重复 `id`、标题层级、`lang`、`iframe title`、`tabindex`）、布局（文字裁切、图片拉伸、点击目标过小）、内容（占位/调试文案、模板变量、乱码、无效值）、安全（混合内容、`_blank` 缺 `noopener`、http 表单、疑似密钥）、性能（LCP、CLS、过大图片）、可用性（白屏）。发现走同一套指纹、证据门槛、裁决记忆与 `bugs.md`。
- `qa run --explore` 显式开启有界交互探索：每页最多 6 个控件、60 秒预算，找“点击无反应 / 点出异常 / 点出 404”；跳过破坏性文案、表单提交、外链、下载，写请求仍按只读策略拦截。默认关闭，因为它会改变页面状态。
- `qa baseline` 把一次运行登记为基线，之后每次运行对同站同页同视口截图做比对，低于阈值生成 `regression` 发现（附基线截图、本次截图、差异图）；`--no-baseline` 关闭。
- 固定注入基准 `node core/scripts/benchmark-qa.mjs`：21 个缺陷案例 + 3 个健康案例，最近一次 21/21 检出、0 误报，单页静态检测约 2.1 秒、含交互段约 11 秒。夹具与口径见[基准说明](competition/qa-detection-benchmark.md)。
- 验收子系统未改动：`FROZEN-VERIFIER.sha256` 的 14 个文件字节不变。

## 历史归档

- 逐日审计报告与证据：`docs/audits/README.md` 索引，原始文件在 `D:/Github-Star/heimdall-evidence-archive/2026-10-30/` 与 git 历史。
- 截至 2026-10-13 的开发记录、旧路线图、旧使用说明：`docs/archive/`。
