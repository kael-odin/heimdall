# CarbonAds 显式移除策略

日期：2026-10-16

## 结论

CarbonAds 默认仍按 `unsupported-runtime` 阻断。只有导出时显式加 `--remove-carbonads`，候选包才会删除已识别的 CarbonAds 脚本、广告容器及其中关联像素。

这是一次明确降级，不是业务等价：删除后镜像不再包含实时广告和广告追踪，也不能声称复刻了原站的广告行为。若识别不完整、解析失败或 HTML 中仍有 CarbonAds 引用，严格导出继续失败。

## 行为

- 仅在 `--offline --strict` 下允许开启。
- 识别：
  - `id="_carbonads_js"` 或指向 `carbonads.com / carbonads.net` 的脚本
  - `id="carbonads"`
  - `VPCarbonAds`、`VPDocAsideCarbonAds`、`carbon-pixels` 容器
- 删除候选包中的 live HTML 与静态克隆页 HTML，不改写源工作区。
- `health.carbonAdsRemoval` 记录策略、文件数、脚本数、容器数、剩余 HTML 引用与失败数。
- `heimdall-live.json` 写入 `carbonAdsPolicy: "remove"`，接收方可核对降级策略。
- `strictBlockers.thirdPartyPolicyRemaining` 与 `thirdPartyPolicyFailed` 保证漏删或失败不得发布。

## 验证

定向测试：

```powershell
pnpm --dir core test -- test/live-carbonads-removal.test.mjs
```

结果：3 项通过。

- 默认导出：CarbonAds 继续作为 `unsupported-runtime` 阻断。
- 显式移除：脚本、容器、嵌套广告与追踪像素被删除，无关外链保留。
- 漏删场景：`remainingHtmlReferences=1`，报告为 `incomplete`，strict 继续阻断。

## Vite 57 页真实复验

命令：

```powershell
$dataRoot = Join-Path $env:TEMP 'heimdall-public-vite-wide-c40b0b28'
$out = Join-Path $dataRoot 'deliverable\vite-live-remove-carbonads-recheck'
$env:HEIMDALL_DATA_DIR = $dataRoot
node --max-old-space-size=4096 core/src/live/export.mjs vite.dev `
  --offline --strict --root mirror --heal --materialize-har `
  --public-text-links-max-targets 256 --remove-carbonads --out $out
```

结果：退出码 1，失败候选保留，符合预期。

| 指标 | 显式移除前 | 显式移除后 |
| --- | ---: | ---: |
| CarbonAds 服务 | 1 类阻断 | 0 类阻断 |
| external assets | 266 | 0 |
| 被修改 HTML 文件 | 0 | 108 |
| 移除节点 | 0 | 108 |
| 剩余 CarbonAds HTML 引用 | - | 0 |
| unsupported runtime services | 2 | 1 |
| strict `missingLinks` | 0 | 0 |
| unsupported external redirects | 1 | 1 |
| unresolved resources | 1 | 1 |

移除后剩余阻断：

- YouTube 嵌入：1 个 unresolved 资源，1 类 unsupported runtime。
- `/rolldown`：1 个显式 unsupported 跨域跳转。
- 浏览器逐页探针：因前置阻断仍为 57 页未测。

## 剩余工作

1. 为 YouTube 嵌入设计显式本地占位或授权替换策略。
2. 为 `/rolldown` 提供授权替代或显式跳过策略；不能静默跨站抓取。
3. 两项策略完成后重跑 Vite 57 页严格导出，并执行断外联浏览器逐页探针。
