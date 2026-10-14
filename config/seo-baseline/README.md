# SEO 基线

每个文件对应 `../seo-targets.txt` 里的一个来源（协议、主机名、端口）。
文件名由 `core/src/seo/baseline-file.mjs` 的 `baselineFileKey()` 计算：
`https://example.com` → `example.com--origin-100680ad546ce6a577f42f52.json`，
`https://www.example.com` → `www.example.com--origin-cdb4d88dca0bef8defe13d71.json`，
`http://example.com:8080` → `example.com--origin-e0ddde96f675ccf3d1e07e45.json`。
后缀取来源 URL 的 SHA-256 前 24 位，避免不同协议、端口或主机名互相覆盖。
CI 使用同一函数生成文件名，不要手工截断 URL。

**这些文件要进 git。** 基线不进仓库，CI 每次都算「首次运行」，门禁就永远不会红 ——
看起来一切正常，实际上什么都没在检查。

## 基线里有什么

只存判定需要的字段（不含证据文本），所以文件很小、PR 里 diff 得动：

```json
{
  "version": 1,
  "host": "example.com",
  "origin": "https://example.com",
  "stable": 92.4,
  "pages": {
    "https://example.com": { "stable": 94, "issues": { "content-title-long": "low" } }
  },
  "siteIssues": { "index-robots-missing": "low" }
}
```

`stable` 是**稳定分**：剔除 LCP/CLS/FCP 之后的分数。这三个每次跑都在抖，
拿它们当判据的话门禁会随机变红，然后被 `continue-on-error` 关掉。

## 常用命令

建立或重建基线（会覆盖，需自己开 PR）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com--origin-100680ad546ce6a577f42f52.json --update-baseline
```

按基线判回归（CI 用的就是这个，有阻断级回归则 exit 1）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com--origin-100680ad546ce6a577f42f52.json --require-baseline --fail-on-regression
```

门禁命令会在抓取前校验基线结构及 origin，缺失、损坏、空页面、错误严重度或来源不一致都会失败。建立基线的命令允许文件尚不存在，但已存在的坏基线仍需先人工处理。
门禁或基线更新遇到未成功采集的页面（HTTP 错误、导航失败或跨来源重定向）也会失败，不把错误页更新为基线。
仓库目前没有已授权的真实目标与审核过的基线，因此工作流只支持手动触发；接入后先审核首份基线，再启用定时任务。

额外启用「总分跌幅」门禁（默认关闭，因为分数是问题列表的派生量）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com--origin-100680ad546ce6a577f42f52.json --fail-on-regression --tolerance 3
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
