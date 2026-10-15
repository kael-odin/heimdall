# 运行时服务显式缓存策略

日期：2026-10-16

## 结论

严格离线导出新增 `--cache-runtime-services <json-file>`。它只缓存策略文件显式声明的运行时服务，不把任意 API 静默放入交付包。策略文件是 JSON 数组，例如：

```json
["iconify", "vite-sponsors", "github-avatars"]
```

该策略解决的是“页面脚本运行时再请求的公开只读资源”。它与 `--remove-carbonads`、`--replace-youtube` 一样是显式决策：服务声明、捕获失败、隐私过滤失败或浏览器探针外联都会继续阻断发布。

## 行为

- 只允许在 `--offline --strict` 下开启。
- 从源站每页 `network.har` 收集已声明服务的 GET 请求；只接受安全 URL、安全查询参数和允许的 MIME 类型。
- 策略中的每个 service ID 必须出现在本次源 HAR 的运行时服务证据里，未发现即导出失败，防止拼写错误变成静默 no-op。
- 单文件、总大小、URL 数和服务数都有上限；失败报告只保留 origin 与原因，不泄漏 query 或 token。
- Iconify 的三个镜像域名视为同一服务的等价公开 API。源 HAR 中观测到的安全 GET 会在 `api.iconify.design`、`api.simplesvg.com`、`api.unisvg.com` 间补齐，避免运行时随机选择未采样域名时产生本地 404。
- 已捕获响应写入 `site/live/_ext/<host>/...`，并在 `har.json` 中标记 `kind: "runtime-service-cache"`。
- `rewriteLocalRefs` 会改写完整 URL 和 JS 中的 API 基址；`serve.mjs` 会把带查询的 `_ext` 请求映射到导出时的 `path~hash.ext` 实体。
- `--materialize-har` 会在自愈、公开文本补抓、外链静态化和路径别名之后追加一次最终本地化改写，防止补抓文件覆盖已改写 JS。
- `health.runtimeServiceCache` 记录服务、请求数、成功数、失败数和字节数；`heimdall-live.json` 写入服务 ID。
- `.riv`、`.glb`、`.gltf` 归为可落盘的静态资源，运行时请求的 `.riv` 不再因后缀分类变成包内 404。

## 定向验证

```powershell
pnpm lint
pnpm -C core exec node --test test/live-runtime-service-cache.test.mjs test/live-query.test.mjs test/live-serve-integration.test.mjs test/bundle-selfcontained.test.mjs
```

结果：15 项通过，覆盖：

- 策略文件格式与边界。
- 只收集已声明服务的安全 GET。
- Iconify 镜像域名补齐。
- 未采样域名的基址映射。
- GitHub 头像显式服务内重定向。
- 敏感 query 的拒绝与脱敏报告。
- 本地化查询响应在独立离线服务器中命中哈希实体。
- 交付服务器保持零外部依赖。

## Vite 57 页公开样本复验

命令：

```powershell
$dataRoot = Join-Path $env:TEMP 'heimdall-public-vite-wide-c40b0b28'
$policyFile = Join-Path $dataRoot 'runtime-services.json'
$out = Join-Path $dataRoot 'deliverable\vite-live-runtime-policies'
$env:HEIMDALL_DATA_DIR = $dataRoot

node --max-old-space-size=4096 core/src/live/export.mjs vite.dev `
  --offline --strict --root mirror --heal --materialize-har `
  --public-text-links-max-targets 256 `
  --cache-runtime-services $policyFile `
  --remove-carbonads --replace-youtube `
  --allow-unsupported-external-redirects --out $out
```

最终结果：

| 指标 | 结果 |
| --- | ---: |
| 发现 / 克隆 / 交付页面 | 57 / 57 / 57 |
| 运行时缓存请求 | 77 |
| 运行时缓存成功 / 失败 | 77 / 0 |
| 运行时缓存体积 | 2,379,398 字节 |
| 静态 unresolved | 0 |
| 静态 external assets | 0 |
| unsupported runtime services | 0 |
| strict blockers 全量 | 0 |
| 浏览器探针 checked / failed / untested | 57 / 0 / 0 |
| 浏览器失败明细 | 0 |
| 运行时外部 origin | 0 |

随后把正式包复制到不含原工作区的独立临时目录，重新枚举 `site/live` 路由并运行同一断外联浏览器探针：

| 指标 | 搬迁复验 |
| --- | ---: |
| 路由 | 57 |
| checked | 57 |
| failed | 0 |
| failureCount | 0 |
| untested | 0 |
| runtimeOrigins | 0 |

## 边界

- 这是 Vite 公开页样本的验收，不证明任意站点已支持。
- 只缓存显式声明的服务；未声明或未识别的运行时 origin 仍会被浏览器探针阻断。
- Iconify 镜像补齐只基于已观测的安全 GET，不推断任意未知接口。
- GitHub 头像只在声明服务范围内跟随显式安全重定向，不抓取跨域目标站。
- CarbonAds 和 YouTube 仍是显式降级：一个移除广告运行时，一个用占位替代不可离线播放的视频。
- 浏览器探针验证首载与观察窗口内请求；未声明操作、窗口外延迟请求、登录态和写入业务仍需单独操作计划与适配器验收。
