# Heimdall 当前状态（STATUS）

> 更新：2026-11-17 · **本页只写“当前为真”**：三项能力现在到哪一步、怎么验、边界在哪。按日期追加的记录在 [逐日记录](archive/STATUS-log-through-2026-11-15.md) 与 [审计索引](audits/README.md)。

## 一句话

面向获授权网站，采集证据、辅助 AI 重建与独立部署，度量还原度，诊断 SEO/GEO，并按充分的需求与接口信息检测前后端缺陷。

## 现在的主线

**持续增强三项能力，用真实案例推动改进**。Heimdall 采集和核验证据，外部 AI 代理补全实现与提出修复方案：

1. **站点重建与独立交付**：捕获页面、资产和可观察行为，辅助 AI 补写缺失功能，验证多视口还原度与离线交付；未知后端规则保留为待确认事项。
2. **SEO/GEO 诊断与优化**：基于采集证据评分，输出可追溯、可复测的改进方案；GEO 当前是准备度启发式，尚未验证真实模型引用命中率。
3. **前后端缺陷检测**：结合页面、业务需求、账号权限、接口契约和声明检查点检测问题；分别说明已验证、未测和证据不足的范围。

优先复用现有入口、修正真实案例中的误报与漏测，保持核心代码为主体，运行证据放在仓库外。验收子系统保持冻结，作为正式门禁被调用。

## 最近一轮实测（2026-11-17）

三项能力各用公开真实站点跑了一遍，只修实战暴露的缺陷。过程、数字和中途一次错误见 [真实站点横扫](audits/2026-11-17/real-site-sweep.md)。

| 能力 | 真实案例 | 现在的结果 | 仍未知 |
| --- | --- | --- | --- |
| 站点重建与独立交付 | quotes.toscrape.com（含无限滚动页与分页接口） | 侦察按站点自己的地址写法访问，同主机的协议降级改回本站来源重试：60 页预算下 48 页、0 失败（最初 4 页预算下只得到 3 页，另有 45 个地址访问失败）。样式表里的 `@import` 就地展开，外链字体全部落到本地：离线包未解析/外链资源 15/50 → 0/0，4/5 页拿到带证明的三视口验证（平均 99.99%） | 无限滚动页如实标为未测量；strict 离线导出剩下的是范围问题（未克隆页的链接），没有按全站预算重跑 |
| AI 重建闭环 | 同站首页，故意只写 3/10 条内容的候选 | 修复包新增「内容缺口」：点名参考里有文字、候选页找不到的元素。不完整的候选报出 70 处（侧栏标题、7 条引文、`(about)` 参考 10 处 / 候选 3 处），内容补齐后为 0 | 没有用真实模型跑完多轮重建；只验证了清单的正确性 |
| 后端补写入口 | 同上，`GET /api/quotes?page=N` | 带查询的 GET 接口默认不采集，但契约会报出被拦下的请求数与放行办法；按 `read-data-plan.json` 放行后契约为 B1，离线包回放这 3 页数据后无限滚动页不再报浏览器失败 | 第 4 页起没有证据；没有生成 B3 后端；鉴权、4xx/5xx 形状、写入行为 |
| SEO/GEO 诊断 | nodejs.org、wordpress.org、runoob、sqlite.org、知乎等 7 站 | 选页按页面类型轮流、入口必查；robots.txt 按 RFC 9309 判断 Googlebot 与回答引擎能否抓取；别名地址与抽样孤儿页不再误报。评分口径 14、测量 9、GEO 方法 9，共 66 条规则 | sitemap 触发预算时不判断整站；被拒只说明 robots 规则，不证明实际抓取或引用 |
| 前后端缺陷检测 | the-internet 12 页 × 2 视口（含刻意植入的缺陷） | 404 图片与站点自身脚本异常进入提单并带状态码/出错位置；超过 10 秒的请求单独列出；401 入口不再算坏链；同一路由的多页发现保留每个地址 | 认证、权限、状态机与业务规则仍需授权旅程和声明检查点 |

## 现在能跑什么

```bash
# 幂等安装 / 启动 / 可选的 AI 客户端配置
node bin/heimdall.mjs setup

# 单页克隆（不需要先起引擎）
node core/src/cli.mjs forge https://example.com home

# 全流程：控制台 + 引擎（幂等）
node bin/heimdall.mjs setup --no-connect

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
pnpm -C core lint          # 语法 + JSON
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

2026-11-17 Hosted Node 22（提交 `d47f7624`）8 个作业全部通过；全量两分片合计 **3,390 / 3,394 通过，0 失败，4 跳过**。
同日本机快速集 **1,395 / 1,395**，`lint` 775 文件，冻结验收 14 个文件未动，控制台与 MCP 插件产物均为最新。
QA 固定基准当日重跑：21 个缺陷检出 21 个、3 个干净对照 0 误报。验收基准 18/18、13 个已知 BUG 全检出并定位到注入源码（2026-11-04 结果，验收子系统此后未改动）。
以精确提交的 Hosted CI 结果为最终依据；本机结果只说明改动没有破坏快速集。

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

## 历史归档

- 2026-11-15 及以前按日期追加的状态记录：[archive/STATUS-log-through-2026-11-15.md](archive/STATUS-log-through-2026-11-15.md)。
- 逐日审计报告与证据：[audits/README.md](audits/README.md) 索引；运行产物在仓库外 `D:/Github-Star/heimdall-evidence-archive/<日期>/`，更早的原件见 git 历史。
- 截至 2026-10-13 的开发记录、旧路线图、旧使用说明：[archive/](archive/README.md)。
