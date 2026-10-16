# vitest.dev 全站公开样本 strict 离线验收

日期：2026-10-16

## 结论

`vitest.dev` 公开站点完成 221 个已发现 URL 的克隆、交互镜像构建和 strict 离线导出。最终正式包 `health.json` 中全部门禁为 0；221 个页面在真实 Chromium 断外联探针中全部通过，0 失败、0 未测、0 个运行时外部 origin。

将正式包复制到不含原工作区的独立临时目录后，包内 `serve.mjs` 仍可独立启动：

- `/` 返回 200，约 53.5KB。
- `/lm/vitest.dev/` 返回 200，内容大小与根路径一致。
- `/__heimdall/health` 返回 200。
- 独立目录中重新枚举 221 个 live 路由，并重跑真实浏览器断外联探针：221 checked / 0 failed / 0 untested / 0 runtime origins。

这份证据只覆盖 `vitest.dev` 的公开页面、本次侦察发现的 221 个 URL、显式声明的运行时服务策略和当前包内容。它不证明任意站点可完整克隆，也不包含登录、写操作、支付、实时连接或长期会话等业务能力。

## 最终包

本机临时数据根：

```text
C:\Users\44548\AppData\Local\Temp\heimdall-public-vitest-20261016
```

正式包：

```text
C:\Users\44548\AppData\Local\Temp\heimdall-public-vitest-20261016\deliverable\vitest-full-strict
```

正式包约 715MB，包含 221 个页面、清洗后的 HAR、本地静态资源、213 个公开文本源文件、21 条 Iconify 运行时缓存响应、健康报告、校验和与独立部署文件。

独立复验目录：

```text
C:\Users\44548\AppData\Local\Temp\heimdall-vitest-independent-da34d27e53044cd4a7d655e7f2989c37
```

独立复验证据：

```text
C:\Users\44548\AppData\Local\Temp\heimdall-vitest-independent-probe.json
```

## 门禁结果

| 指标 | 结果 |
| --- | ---: |
| 侦察发现 URL | 221 |
| 克隆页面 | 221 |
| 交付 live 页面 | 221 |
| strict blocker 总数 | 0 |
| 静态 unresolved | 0 |
| 站外静态资产 | 0 |
| 未镜像站内链接（扣除显式跨域跳转） | 0 |
| 未克隆 / 未交付页面 | 0 / 0 |
| 侦察失败（扣除显式接受的外部跳转） | 0 |
| 公开文本目标 eligible / captured | 213 / 213 |
| Iconify 运行时缓存 requested / fetched / failed | 21 / 21 / 0 |
| 隐私扫描 issues / failures | 0 / 0 |
| 浏览器探针 checked / failed / untested | 221 / 0 / 0 |
| 浏览器运行时外部 origin | 0 |

`/vscode` 是探测出的跨域跳转。本次使用 `--allow-unsupported-external-redirects` 显式接受该跳转；`health.externalRedirectPolicy` 保留 accepted=1、references=6、acceptedReconFailures=1，不把它伪装成本地页面。

## 视觉验证

全部 221 个页面目录都有 verify 结果。当前口径下：

| 指标 | 结果 |
| --- | ---: |
| 完整测量 | 219 |
| 未测成 | 2 |
| 平均分 | 94.10% |
| A | 76 |
| B | 142 |
| C | 1 |
| 最低页 | `blog-vitest-3` 84.25% |

未测成页面：

- `config-changed--4c839d0484f80cffc8390768d279cb05`：`1440x900: render did not settle`
- `config-dangerouslyignoreun--6258bf551243b4c67faa2d08e172d418`：`1440x900: render did not settle`

新补的 10 个入口页已全部完成三视口验证：

| 页面 | 总分 | 等级 |
| --- | ---: | --- |
| root-index | 96.21% | A |
| api-test-index | 94.49% | B |
| blog-index | 96.64% | A |
| blog-vitest-3 | 84.25% | C |
| config-index | 92.58% | B |
| guide-index | 94.28% | B |
| guide-features | 94.54% | B |
| guide-why | 89.33% | B |
| releases | 91.21% | B |
| team | 95.68% | A |

视觉分数用于说明还原能力，不是 strict 离线可用的门禁。低分页面仍可离线打开；它们代表像素、DOM 或字段覆盖差异。

## 本轮修复

1. **CarbonAds 清理容量**
   - 221 页 HTML 超过旧默认 64MB 扫描上限。
   - `removeCarbonAds` 支持 `maxTotalBytes` 参数和 `HEIMDALL_CARBONADS_MAX_TOTAL_BYTES` 环境变量，范围 64MB 到 1GB。
   - 本次使用 512MB，438 个 HTML 容器和 1 个运行时脚本全部处理，remaining=0。

2. **公开文本补抓预算**
   - 新增 `--public-text-links-max-wall-ms 60000..900000`。
   - 修正 `/api/**.md` 被当成私有 API 路径的一刀切规则；`users/private/tokens/secrets` 等敏感父目录仍拒绝。
   - 本次 213/213 个公开文档全部捕获。

3. **隐私扫描**
   - 文档中的 ANSI 颜色转义不再被当作二进制导致 `undecodable-text`。
   - `token=123`、`token=...` 等公开示例值不再被当成泄漏。
   - Markdown 反引号不再被误包含到 query 值里。
   - 新增 `--privacy-max-total-bytes 134217728..1073741824`，本次使用 512MB；最终扫描 clean，0 issues、0 failures。

4. **显式跨域跳转**
   - `--allow-unsupported-external-redirects` 时，已探测并明确接受的跨域跳转不再计入 strict 的 `reconFailures` 阻断。
   - 原始侦察失败和接受理由保留在 `health.externalRedirectPolicy`，证据不删除。

5. **运行时服务**
   - 使用已有 `--cache-runtime-services` 策略缓存 Iconify。
   - 策略文件只声明 `["iconify"]`，从源 HAR 收集 21 个安全 GET，并补齐三个公开镜像域名。
   - 全部缓存成功并改写为本地 `_ext` 路由。

6. **浏览器稳定判定**
   - 修复 `<video preload>` 打开本地 `.webm` 后长期保持连接导致的假 `observationDeadline`。
   - 普通慢请求仍 fail-closed；本地媒体流不再被当成页面不稳定。
   - `blog/vitest-3` 与 `blog/vitest-5` 的 `.webm` 请求为本地资源，最终不再阻塞。

## 复现命令

策略文件：

```json
["iconify"]
```

导出：

```powershell
$dataRoot = Join-Path $env:TEMP 'heimdall-public-vitest-20261016'
$policy = Join-Path $dataRoot 'runtime-services.json'
$out = Join-Path $dataRoot 'deliverable\vitest-full-strict'
$env:HEIMDALL_DATA_DIR = $dataRoot
$env:HEIMDALL_CARBONADS_MAX_TOTAL_BYTES = '536870912'

node core/src/cli.mjs live vitest.dev `
  --offline `
  --strict `
  --root mirror `
  --heal `
  --materialize-har `
  --remove-carbonads `
  --omit-nonvisual-pixels `
  --public-text-links-max-targets 256 `
  --public-text-links-max-wall-ms 600000 `
  --privacy-max-total-bytes 536870912 `
  --cache-runtime-services $policy `
  --allow-unsupported-external-redirects `
  --out $out
```

运行：

```powershell
cd "$env:TEMP\heimdall-public-vitest-20261016\deliverable\vitest-full-strict"
node serve.mjs --port 8080 --offline
```

## 定向测试

```powershell
pnpm -C core exec node --test test/live-privacy-audit.test.mjs test/live-public-text-links.test.mjs test/live-carbonads-removal.test.mjs test/live-browser-probe.test.mjs
pnpm -C core lint
pnpm test
pnpm docs:links
pnpm build
```

结果：

- privacy audit：6/6 通过。
- public text links：7/7 通过。
- CarbonAds removal：4/4 通过。
- browser probe：7/7 通过。
- `core lint`：285 个文件语法检查通过。
- 完整 core 测试：897 个测试中 895 通过、2 个 Docker 用例按本机条件跳过、0 失败。
- 文档链接检查：41 个文件、135 个本地目标全部通过。
- 控制台生产构建：418 个模块转换成功；Graph3D chunk 超过 500KB，构建仍成功，该警告为本轮未处理的既有体积提示。

## 剩余边界

- 只验收 `vitest.dev` 公开页面；没有登录态、写操作、支付、实时连接或账号数据。
- 没有 `operation-plan.json`，因此未声明交互流程，不宣称完整业务替代。
- 2 个页面视觉验证未测成，原因是源页渲染未收敛；它们不代表 strict 离线包失败。
- `/vscode` 跨域跳转被显式接受，不会在离线包中伪造目标站。
- CarbonAds 被显式移除，Iconify 响应被显式缓存；这是降级 / 回放决策，不表示与在线服务长期等价。
- 侦察发现 221 个 URL 不等于网站全集；`health.coverage` 只证明本轮已发现范围内 221/221 覆盖。
