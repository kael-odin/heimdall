# Heimdall 当前状态（STATUS）

> 更新：2026-11-28 · **本页只写“当前为真”**：网站克隆、AI 重建与独立交付现在到哪一步、怎么验、边界在哪。按日期追加的历史记录在 [逐日记录](archive/STATUS-log-through-2026-11-15.md)。

## 一句话

面向获授权网站，采集真实页面与资产证据、度量多视口还原度、辅助 AI 重建可维护项目并交付独立运行的离线/静态镜像，同时提供站内 SEO/GEO 诊断。

## 现在的主线

**专注做好网站克隆与高保真重建引擎**（已彻底剥离原比赛命题的 `acceptance` 项目验收工作台与 `qa` 无参照物巡检模块，减重 3.5 万行非核心代码）：

1. **站点克隆与独立交付**：捕获页面、CSSOM（含 `@import` 展开）、字体、图片、Canvas 光栅化、视频首帧和可观察 API 行为，验证多视口还原度与严格离线（`--offline --strict`）交付。
2. **AI 驱动的逐段重建与正式门禁**：通过 `heimdall_brief`、`heimdall_compare`（输出像素/结构/内容缺口 Fix Packet）和本地六维 `heimdall gate formal` 闭环，把克隆镜像重建为可维护的 HTML/CSS 或 React 工程；对捕获到的只读 API 提供 B1 契约、B2 回放适配器与 B3 本地后端脚手架。
3. **站内 SEO/GEO 诊断与监控**：基于采集证据对 66 条规则评分，输出可追溯、可复测的改进方案与站点变更监控报告。

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

# AI 重建闭环
heimdall clone https://example.org/
heimdall rebuild init example.org --page home
heimdall brief --project . --detail sections
heimdall compare --project .
heimdall gate report --project . --level gold
heimdall gate formal --project . --level gold
heimdall rebuild deliver --project .
```

## 怎么验

```bash
pnpm -C core lint          # 语法 + JSON
pnpm -C core check:docs    # 文档链接
pnpm -C core test          # 快速集（无浏览器的核心单测与流程测试）
pnpm -C core test:full     # 全量（含真浏览器与控制台 E2E）
pnpm -C console build      # 控制台构建
pnpm -C packages/mcp test  # MCP v2 协议与插件测试
pnpm skills:check          # 技能与子代理同步检查
pnpm run audit             # core / console / MCP 三套依赖审计
pnpm check                 # 本地总门禁
```

## 已知边界（不藏）

- 只碰公开页面或操作者本人有权访问的页面；不绕过登录、验证码、访问控制。
- 交互镜像依赖 `*.localhost` 解析；被代理接管 DNS 的环境里打不开，静态镜像不受影响。
- WebGL、运行时画布、视频、滚动编排：只做降级或明确标不支持。
- 大站（>500 页）受并发与页数上限约束；当前默认并发 2。
- 后端只能克隆“被观察到的行为”，不声称业务等价。

## 文档地图

| 想知道什么 | 读哪里 |
| --- | --- |
| 项目价值、启动、产物 | [README](../README.md) |
| 控制台与 CLI 操作 | [USAGE](../USAGE.md) |
| 产品定义与验收等级 | [PRD](../PRD.md) |
| 边界与技术风险 | [RISKS](../RISKS.md) |
| 当前架构（对着代码维护） | [docs/guide/01-architecture.md](guide/01-architecture.md) |
| AI 接入层方案与路线 | [docs/prd/ai-native/](prd/ai-native/README.md) |
| 接入 Claude Code / Desktop | [docs/guide/06-ai-integration.md](guide/06-ai-integration.md) |
| 待办与长期维护 | [docs/ROADMAP.md](ROADMAP.md) |
| 历史开发记录 | [docs/archive/](archive/README.md) |
