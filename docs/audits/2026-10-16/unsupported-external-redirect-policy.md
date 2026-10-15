# 跨域路径别名跳转策略

日期：2026-10-16

## 结论

公开路径别名探测已把跨域跳转从普通意外缺链升级为显式的 `unsupported-external-redirect`。该策略不会静默跟随目标站点，也不会把目标 URL 写入报告；引用会被改写到镜像命名空间，使离线服务返回可复现的本地 404。严格导出继续阻断这类跳转，并新增独立计数，避免把它伪装成普通缺页或资源缺口。

本记录证明策略、门禁行为与同一 Vite 57 页样本的真实导出复验，不表示任意站点可独立部署。

## 实现

- `core/src/live/path-aliases.mjs`
  - `disposition` 由 `external-redirect` 改为 `unsupported-external-redirect`。
  - 报告新增：
    - `unsupportedExternalRedirects`
    - `unsupportedExternalRedirectReferences`
  - 仅存在这类跳转时报告状态为 `unsupported-detected`。
  - 目标站点 URL 不进入报告，测试同时断言无泄露。

- `core/src/live/export.mjs`
  - `strictBlockers` 新增：
    - `unsupportedExternalRedirects`
    - `unsupportedExternalRedirectReferences`
  - `strictBlockers.missingLinks` 只扣除源站 404/410 与显式 unsupported 跳转引用，普通意外缺页仍单独阻断。
  - 导出帮助说明跨域跳转会单独归类并阻断。

## 验证

命令：

```powershell
pnpm --dir core test -- test/live-path-aliases.test.mjs test/live-public-text-links.test.mjs
```

结果：

- 7 个测试通过，0 个失败。
- 单元夹具证明源站 404、同源已捕获重定向与跨域跳转三类互不混淆。
- 严格导出夹具证明：
  - `pathAliases.disposition=unsupported-external-redirect`
  - `strictBlockers.unsupportedExternalRedirects=1`
  - `strictBlockers.unsupportedExternalRedirectReferences=1`
  - 该场景下 `strictBlockers.missingLinks=0`
  - 链接被改写为 `/lm/<host>/external/`
  - 失败候选保留，正式包未覆盖

### Vite 57 页真实复验

命令：

```powershell
$dataRoot = Join-Path $env:TEMP 'heimdall-public-vite-wide-c40b0b28'
$out = Join-Path $dataRoot 'deliverable\vite-live-policy-recheck'
$env:HEIMDALL_DATA_DIR = $dataRoot
node --max-old-space-size=4096 core/src/live/export.mjs vite.dev `
  --offline --strict --root mirror --heal --materialize-har `
  --public-text-links-max-targets 256 --out $out
```

结果：退出码 1，失败候选保留，符合预期。

| 指标 | 结果 |
| --- | ---: |
| 页面 | 57 |
| 已克隆 | 57 |
| 已交付 | 57 |
| 原始 missing links | 11 |
| 源站 404 引用 | 10 |
| unsupported 跨域跳转 | 1 |
| strict `missingLinks` | 0 |
| strict `unsupportedExternalRedirects` | 1 |
| unsupported runtime services | 2 |
| unresolved resources | 1 |
| external assets | 266 |

路径别名明细：

| 路径 | 源站状态 | 分类 | 引用数 |
| --- | ---: | --- | ---: |
| `/features` | 404 | `expected-missing` | 3 |
| `/build` | 404 | `expected-missing` | 2 |
| `/api-javascript` | 404 | `expected-missing` | 1 |
| `/api-plugin` | 404 | `expected-missing` | 1 |
| `/cli` | 404 | `expected-missing` | 1 |
| `/rolldown` | 301 | `unsupported-external-redirect` | 1 |
| `/using-plugins` | 404 | `expected-missing` | 1 |
| `/why` | 404 | `expected-missing` | 1 |

当前候选仍被以下问题阻断：

- YouTube 嵌入：1 个 unresolved 资源，第三方服务计 1 类。
- CarbonAds：54 处引用，第三方服务计 1 类。
- 外部广告/追踪资源：266 处 external assets。
- `/rolldown`：显式 unsupported 跨域跳转。

因此本次复验没有发布正式包，也没有执行浏览器逐页探针；`browserUntested=57` 是 strict 分项阻断后的诚实结果。

## 剩余工作

1. 继续设计并验证 CarbonAds 的默认阻断 / 显式移除或占位策略。
2. 继续设计并验证 YouTube 嵌入的默认阻断 / 本地占位或授权替换策略。
3. 在第三方运行时策略完成后重跑 Vite 57 页严格导出和断外联浏览器探针。
