# 公开页面离线验收与资源提示误报修复

日期：2026-10-16

## 结论

按用户选择的公开页面路线完成两组隔离验收：

- `example.com` 首页完成单页克隆、strict 离线导出和独立 Node 服务浏览验收。
- `vitest.dev` 首页完成真实前端单页克隆，并用 `--heal --materialize-har` 把同源资源补齐；剩余阻断均为未克隆的站内链接。

第二轮验收发现并修复了一个 strict 门禁误报：健康扫描用子串匹配 `rel`，把 `dns-prefetch` 误认为 `prefetch`，导致 Google Fonts 的两个提示链接被计为必需外部静态资源。现在 `rel` 按空格分词后整词匹配，`dns-prefetch` 和 `preconnect` 不再产生资源缺口。

## 验收过程

隔离数据目录：

```powershell
$env:HEIMDALL_DATA_DIR = Join-Path $env:TEMP 'heimdall-public-acceptance-20261016'
```

### example.com

```powershell
node core/src/cli.mjs forge https://example.com home
node core/src/cli.mjs live example.com --offline --strict --root mirror --out "$env:TEMP\heimdall-public-acceptance-20261016\deliverable\example-public-strict"
```

结果：

- 单页分数：像素 100%、DOM 70%、数据 100%，综合 91.0%（B）
- 覆盖口径：`captured-only`，分母 1，克隆 1，交付 1
- 资源：未解析 0，外部静态资源 0
- strict 浏览器探针：1/1 通过，观察 3 秒后网络安静
- 隐私扫描：0 问题

独立启动 `node serve.mjs --port 8091 --offline` 后，用 Chromium 访问根路径：

- 页面标题为 `Example Domain`
- 3 个请求全部指向本地服务，均返回 200
- 控制台错误 0、警告 0

### vitest.dev

```powershell
node core/src/cli.mjs forge https://vitest.dev home
node core/src/cli.mjs live vitest.dev --offline --strict --root mirror --heal --materialize-har --out "$env:TEMP\heimdall-public-acceptance-20261016\deliverable\vitest-public-healed"
```

单页克隆结果：

- 像素 97.12%、DOM 99.99%、数据 100%，综合 98.6%（A）
- 25 个捕获资源全部成功，2 个 Canvas 已光栅化
- 差异形态为弥散小点，主要位于文字与图形边缘

首次 strict 导出（未启用 heal）：

- 同源未解析资源 4
- 跨源静态资源 2
- 未镜像链接 17
- 浏览器探针因前置阻断未运行

修复 `dns-prefetch` 误报并启用 heal / materialize 后：

- 同源未解析资源 0
- 跨源静态资源 0
- 未镜像链接 16
- 浏览器探针仍因前置阻断未运行
- 候选包保留，未发布为正式离线包

剩余 16 个链接阻断来自首页导航指向的 `/guide/`、`/api/test`、`/blog`、`/config/`、`/team` 等尚未克隆页面。这是单页验收的范围边界，不是资源缺口。

## 代码修复

- `core/src/live/health.mjs` 将 `ASSET_REL` 正则改为 `ASSET_RELS` 集合
- `rel` 属性先按空白分词，再整词匹配
- `core/test/live-health.test.mjs` 覆盖 `dns-prefetch` 与 `preconnect` 不按资源处理

## 边界

- 两个样本都是公开页面，不包含登录、写入 API 或实时连接
- `example.com` 只证明最小独立部署链路
- `vitest.dev` 是单页样本，`captured-only` 不能代表整站覆盖
- LLM 语义增强与视觉校准因当前模型服务余额不足跳过，不影响本次离线资源门禁
- 未克隆链接必须通过扩大侦察/克隆范围或明确降级策略处理，不能从报告中删除

## 验证

```powershell
pnpm -C core exec node --test test/live-health.test.mjs
pnpm -C core lint
pnpm -C core test
```

结果：

- `live-health` 定向测试：26/26 通过
- 语法检查：285 个文件通过
- 全量测试：893 通过、0 失败、2 条 Docker 用例按环境跳过
