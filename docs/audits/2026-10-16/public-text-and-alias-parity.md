# 公开文本与路径别名奇偶性（2026-10-16）

本次复验继续使用 2026-10-15 的 Vite 57 页隔离工作区，不修改仓库 `core/workspace/` 或 `core/deliverable/`。严格导出仍失败并保留候选包；本报告验证公开文本补抓和路径别名奇偶性，不表示第三方运行时缺口已解决。

## 公开文本补抓

`capturePublicTextLinks` 的默认目标预算从 32 提高到 128，硬上限 256；导出可用 `--public-text-links-max-targets 1..256` 显式调整。报告新增：

- `eligibleKinds` / `capturedKinds` / `uncapturedKinds`
- `targetBudget`
- `limitedReason`：`target-budget`、`byte-budget` 或 `deadline`
- `alreadyPresent`

同时收窄隐私路径规则：公开文本扩展名下的 `config.md` 与 `/config/*.md` 不再因为路径段叫 `config` 被拒绝；`private`、`auth`、`token`、`credentials` 等路径仍拒绝。

Vite 复验结果：

- eligible：44
- captured：44
- rejected：0
- limited：false
- uncaptured：document 0 / feed 0
- 12 个 `.md` 源文档缺口全部消失

## 路径别名

新增 `pathAliases` 探针，只在 `--heal` 下运行。它对未镜像的无扩展路径做有界 GET 探测：

- 源站 404/410：改写到 `/lm/<host>/<alias>`，由镜像内本地 404 复现，不再计入 strict 的意外缺页
- 同源 301/302/303/307/308 且目标本地存在：改写到本地目标
- 跨域跳转：保留为意外缺口
- 源站 200 HTML 但未捕获：保留为意外缺口
- 网络失败或预算截断：保留为失败/未测，不放宽门禁

Vite 的 8 个唯一别名实测：

| 路径 | 引用数 | 源站状态 | 处置 |
| --- | ---: | ---: | --- |
| `/features` | 3 | 404 | `expected-missing` |
| `/build` | 2 | 404 | `expected-missing` |
| `/api-javascript` | 1 | 404 | `expected-missing` |
| `/api-plugin` | 1 | 404 | `expected-missing` |
| `/cli` | 1 | 404 | `expected-missing` |
| `/rolldown` | 1 | 301 → 跨域 | `external-redirect` |
| `/using-plugins` | 1 | 404 | `expected-missing` |
| `/why` | 1 | 404 | `expected-missing` |

结果：

- `links.missing=11`：这是原始扫描计数，保留用于追溯
- `pathAliases.expectedMissingReferences=10`
- `strictBlockers.missingLinks=1`：只剩 `/rolldown` 的跨域跳转
- 本轮改写 21 处链接，把别名点击保持在 `/lm/vite.dev/...` 镜像命名空间内

## 仍阻断发布的原因

本轮候选包仍未发布，strict 阻断为：

- YouTube 嵌入：1
- CarbonAds 外部静态引用：54
- 不支持运行时服务：2（CarbonAds、YouTube）
- 意外路径别名：1（`/rolldown` 跨域跳转）

这些结论与真实浏览器探针一致：7 个别名在源站就是 404 页面，`/rolldown` 最终跳到 `v7.vite.dev`。不能为了通过门禁把它们猜成 `/guide/*` 本地页面。

## 验证

- 针对性测试：路径别名、公开文本、console strict 导出、导出目标与候选包保留全部通过。
- 全量测试：861 项，859 通过、0 失败、2 项 Docker 场景按环境跳过。
- `pnpm lint`：277 个文件通过。
- `pnpm smoke`：通过。
- `pnpm build`：通过。
- `pnpm docs:links`：124 个本地链接通过。
- Vite 57 页真实导出复验：公开文本 44/44，路径别名 8/8 探测完成，strict 缺口从 `missingLinks=23` 降为意外缺口 1。

## 下一步

1. 为跨域别名跳转建立显式策略：`unsupported-external-redirect` 需要站点所有者授权替代，或捕获目标站点并声明跨域关系；不能静默跟随。
2. CarbonAds 与 YouTube 继续保持 `unsupported-runtime`，除非提供显式占位策略并验证 DOM/脚本行为。
3. 将源站 404 奇偶性扩展到资源链接和操作后状态；当前只覆盖无扩展路径别名。
