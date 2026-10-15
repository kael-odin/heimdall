# YouTube 嵌入占位策略

日期：2026-10-16

## 结论

YouTube 嵌入默认仍按 `unsupported-runtime` 阻断。只有导出时显式加 `--replace-youtube`，候选包才会把已识别的 YouTube iframe 替换成本地占位。

这是显式降级，不是视频复刻：离线镜像中不会播放原视频，占位只保留可访问的本地节点、标题和基础尺寸。普通 `<a href="https://www.youtube.com/...">` 外链保留，因为它不是离线运行时依赖，用户点击后跳转由浏览器处理。

## 行为

- 仅在 `--offline --strict` 下允许开启。
- 识别 `youtube.com` / `youtube-nocookie.com` 的 iframe。
- 替换 live HTML 与静态克隆页 HTML，不改写源工作区。
- 保留 iframe 的：
  - `title`，转为占位的 `aria-label`
  - 数字或安全单位的 `width` / `height`
- `health.youtubePlaceholder` 记录策略、文件数、替换数、剩余 iframe 和失败数。
- `heimdall-live.json` 写入 `youtubePolicy: "placeholder"`。
- 漏删或解析失败仍通过 strict blocker 阻断。
- 第三方运行时报告不再把普通外链当作 YouTube 运行时依赖；iframe、脚本、图片等仍是依赖。

## 验证

定向测试：

```powershell
pnpm --dir core test -- test/live-youtube-placeholder.test.mjs test/live-third-party-services.test.mjs
```

结果：5 项通过。

- 默认导出：YouTube 继续作为 `unsupported-runtime` 阻断。
- 显式占位：iframe 被替换，外链保留，第三方运行时缺口清零。
- 漏删场景：`remainingEmbeds` 继续阻断。

## Vite 57 页真实复验

与 `--remove-carbonads` 同时使用后：

| 指标 | 结果 |
| --- | ---: |
| YouTube 替换文件 | 4 |
| YouTube 替换节点 | 4 |
| 剩余 YouTube iframe | 0 |
| unresolved resources | 0 |
| external assets | 0 |
| unsupported runtime services | 0 |
| strict `missingLinks` | 0 |

叠加 `--allow-unsupported-external-redirects` 后，浏览器逐页探针真正执行：

- 观察页面：57/57
- 失败页面：57/57
- 失败明细：287 条（报告截断保留前 100 条）

失败原因不是静态资源缺口，而是运行时外联：

- `https://api.iconify.design`
- `https://api.simplesvg.com`
- `https://api.unisvg.com`
- `https://sponsors.vite.dev`
- 运行时仍会请求 `cdn.carbonads.com`
- `/blog/announcing-vite6/` 仍有 YouTube 外联
- 首页另有 3 个运行时请求的 `.riv` 资源返回本地 404

因此该包仍未发布。这个结果说明静态扫描、脚本占位和浏览器探针缺一不可；下一步必须处理动态运行时服务。

## 剩余工作

1. 为 Iconify 三个 API 设计本地缓存或显式占位策略。
2. 为 `sponsors.vite.dev` 设计授权缓存、移除或占位策略。
3. 追查 CarbonAds 移除后仍被运行时脚本创建请求的代码路径，并扩展删除策略。
4. 捕获或显式降级首页 3 个 `.riv` 运行时资源。
5. 全部处理后再重跑 57 页断外联浏览器探针。
