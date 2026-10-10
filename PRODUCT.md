# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **混合团队**：前端/研发成员与 SEO、增长、竞品分析成员共同使用。
- 研发成员需要从目标 URL 得到静态镜像、可交互镜像、部署包和视觉质检证据。
- SEO/增长成员需要运行全站 SEO 审计、对标矩阵、变更监控和情报抽取，不应被克隆内部实现阻塞。

## Product Purpose

Heimdall 将一个目标站点 URL 转换成可管理的站点工作区：全站页面地图、静态镜像、可交互镜像、部署包、视觉/功能验证、SEO 审计和竞品情报。

成功标准是：用户无需修改源码或先理解内部命令行，就能从控制台输入一个站点，选择侦察/克隆/审计/验证任务，获得可解释、可回溯、可交付的结果。

## Positioning

核心机制不是单纯下载 HTML，而是把**渲染态捕获 → CSSOM/资产归档 → 镜像构建 → 多视口/交互验证 → SEO/情报产出 → 部署交付**串成确定性闭环，并保留每一步的证据与产物。

## Operating Context

- 本地优先运行：Node.js、Playwright Chromium、引擎 HTTP API、Vue 控制台。
- 用户会管理多个站点和大量页面/资产；工作区可达到 GB 级规模。
- 控制台当前默认入口是星图探索；本批次保持星图入口，但补强工作台、存储治理和报告能力。
- 站点资产使用内容寻址存储（CAS）与硬链接去重；删除站点/页面后需要可解释地释放无引用 CAS 空间。
- 用户可以在控制台配置第三方模型服务；Key 存本地、只显示脱敏提示。

## Capabilities and Constraints

- 站点克隆支持静态镜像与可交互镜像；对未知框架采用 generic 适配器和确定性降级。
- SEO 包含审计、测试基础设施、变更监控和跨站矩阵。
- 模型协议支持 OpenAI-compatible chat、OpenAI responses、Anthropic messages；模型服务不是确定性主流程的硬依赖。
- 控制台默认保留深空观测站/星图视觉识别；批次 2 的目标是工作台化、组件化、可读性和可访问性增强，而不是替换品牌世界。
- 页面/任务/报告/资产数据必须能从引擎产物或 API 证据追溯；不能用虚构数据填充指标。
- 个人研究用途下，项目不内置 robots.txt 或 crawl-delay 强制限制；并发和节流如需调整应作为显式配置。

## Brand Commitments

- 产品名 **Heimdall** 与“全视侦察/站点宇宙”隐喻保留。
- 控制台保留“深空观测站”HUD 语言：深色观测场、青色侦察、琥珀警告、紫色 AI、细线仪器框。
- 用户已确认：批次 2 采用渐进重构路线；默认入口继续星图探索；界面业务术语统一中文；混合团队使用；无障碍目标为 WCAG AA 基线。

## Evidence on Hand

- 项目架构与实现：[ARCHITECTURE.md](ARCHITECTURE.md)、[HANDOFF.md](HANDOFF.md)。
- 产品/路线方案：[docs/PLAN-2026-10-09.md](docs/PLAN-2026-10-09.md)。
- 真实站点验收：astro.build 首屏 100.00%、vitest.dev 99.96%、tailwindcss.com 99.92%。
- 质量门：core lint、unit tests、offline smoke E2E、console build。
- 现有实现证据：`console/src/Atlas.vue`、`core/src/engine-server.mjs`、`core/src/store/cas.mjs`。

## Product Principles

1. **先证据，后结论**：每个分数、体积、缺口和审计问题都能下钻到产物或请求。
2. **确定性优先，模型增强**：LLM 提升抽取和校准，但不能成为基础克隆链路的单点故障。
3. **一次输入，多种交付**：侦察、静态镜像、可交互镜像、SEO 和部署应由同一站点工作区承载。
4. **删除也要可解释**：任何空间回收都显示影响范围、释放量和安全边界。
5. **混合团队不互相阻塞**：研发的视觉/交互工作流与 SEO/增长的审计/报告工作流共享数据但不强耦合。

## Accessibility & Inclusion

- 本批次以 WCAG AA 基线为目标：正文与控件对比度、可见键盘焦点、语义按钮/表单、reduced-motion、可读字号和响应式布局。
- 动效必须表达状态，不得阻塞任务；数据表和报告在窄屏下应有明确的折叠/横向滚动策略。
