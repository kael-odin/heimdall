# SEO 基线

每个文件对应 `../seo-targets.txt` 里的一个来源（协议、主机名、端口）。
文件名由 `core/src/seo/baseline-file.mjs` 的 `versionedBaselineFileKey()` 计算。
例如 `https://example.com` → `example.com--origin-100680ad546ce6a577f42f52--score-v5--measure-v5.json`。
来源 URL 的 SHA-256 前 24 位区分协议、端口和主机名；末尾分别区分评分与测量口径。
CI 使用同一函数生成文件名，不要手工截断 URL。旧版本文件保留，不自动覆盖。

**这些文件要进 git。** 基线不进仓库，CI 每次都算「首次运行」，门禁就永远不会红 ——
看起来一切正常，实际上什么都没在检查。

## 基线里有什么

只存判定需要的字段（不含证据文本），所以文件很小、PR 里 diff 得动：

```json
{
  "version": 1,
  "scoreMethodVersion": 5,
  "measurementVersion": 5,
  "host": "example.com",
  "origin": "https://example.com",
  "score": 92.4,
  "stable": 92.4,
  "collection": { "version": 1, "sitemapCoverage": "complete" },
  "pages": {
    "https://example.com": { "score": 94, "stable": 94, "issues": { "content-title-long": "low" } }
  },
  "siteIssues": { "index-robots-missing": "info" }
}
```

`stable` 是**稳定分**：剔除 LCP/CLS/FCP 之后的分数。这三个每次跑都在抖，
拿它们当判据的话门禁会随机变红，然后被 `continue-on-error` 关掉。

## 常用命令

首次建立当前口径基线（选择新路径并审核；同口径的 `--update-baseline` 会覆盖目标文件）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com--origin-100680ad546ce6a577f42f52--score-v5--measure-v5.json --update-baseline
```

按基线判回归（CI 用的就是这个，有阻断级回归则 exit 1）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com--origin-100680ad546ce6a577f42f52--score-v5--measure-v5.json --require-baseline --fail-on-regression
```

门禁命令会在抓取前校验基线结构及 origin，缺失、损坏、空页面、错误严重度或来源不一致都会失败。建立基线的命令允许文件尚不存在，但已存在的坏基线仍需先人工处理。
评分或测量口径缺失、不兼容时，普通审计会保留旧文件并跳过对比；门禁和原路径更新会失败。应使用新路径建立并审核基线，不能把算法变化当成网站问题修复。工作流会自动选择当前版本的文件名，但仍需先创建并审核该文件。
评分口径 3 将 robots.txt 返回 404/410 和已检查的位置未发现 sitemap 改为不扣分的观察；这不证明搜索引擎实际抓取或收录情况。旧口径 2 的基线保留原样，不能与口径 3 直接比较。
评分与测量口径 4 调整了子资源分类，可能改变 JavaScript 体积报警和得分；口径 3 的基线同样保留，不能与口径 4 直接比较。
评分与测量口径 5 保留摘要限制证据，并修复值指令后空格连接的 noindex 解析；口径 4 的基线保留，须改用新路径重新采集并审核。GEO 方法 4 的变化不计入 SEO 基线。
门禁或基线更新遇到未成功采集的页面（HTTP 错误、导航失败或跨来源重定向）也会失败，不把错误页更新为基线。
仓库目前没有已授权的真实目标与审核过的基线，因此工作流只支持手动触发；接入后先审核首份基线，再启用定时任务。

额外启用「总分跌幅」门禁（默认关闭，因为分数是问题列表的派生量）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com--origin-100680ad546ce6a577f42f52--score-v5--measure-v5.json --fail-on-regression --tolerance 3
```

## 判定口径

门禁会因下列情况返回 exit 1：

- 目标页面未从配置的来源成功采集（HTTP 错误、导航失败、跨来源重定向）
- 上次能访问的页面这次不见了（404 / 不可达 / 不再被发现）
- 已有页面上新出现一条 `critical` 或 `high` 问题，或同一问题的严重度升至 `critical` / `high`
- 新出现一条 `critical` / `high` 的站点级问题，或同一站点级问题的严重度升至该级别
- （仅当 `--tolerance N > 0`）总分跌幅超过 N

不阻断：新增页面的问题、波动规则（LCP/CLS/FCP）、低/中severity 的新增、分数小幅下降。

`diff.md` 是同一份结论的 Markdown 版，可直接贴进 PR 评论。
