# SEO 基线

每个文件对应 `../seo-targets.txt` 里的一个站点，命名 `<host>.json`（去掉 `www.` 与协议）。

**这些文件要进 git。** 基线不进仓库，CI 每次都算「首次运行」，门禁就永远不会红 ——
看起来一切正常，实际上什么都没在检查。

## 基线里有什么

只存判定需要的字段（不含证据文本），所以文件很小、PR 里 diff 得动：

```json
{
  "version": 1,
  "host": "example.com",
  "stable": 92.4,
  "pages": {
    "https://example.com/": { "stable": 94, "issues": { "content-title-long": "low" } }
  },
  "siteIssues": { "index-robots-missing": "low" }
}
```

`stable` 是**稳定分**：剔除 LCP/CLS/FCP 之后的分数。这三个每次跑都在抖，
拿它们当判据的话门禁会随机变红，然后被 `continue-on-error` 关掉。

## 常用命令

建立或重建基线（会覆盖，需自己开 PR）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com.json --update-baseline
```

按基线判回归（CI 用的就是这个，有阻断级回归则 exit 1）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com.json --require-baseline --fail-on-regression
```

额外启用「总分跌幅」门禁（默认关闭，因为分数是问题列表的派生量）：

```bash
cd core && node src/seo/audit.mjs example.com --baseline ../config/seo-baseline/example.com.json --fail-on-regression --tolerance 3
```

## 判定口径

阻断（exit 1）当且仅当出现下列之一：

- 上次能访问的页面这次不见了（404 / 不可达 / 不再被发现）
- 已有页面上新出现一条 `critical` 或 `high` 问题
- 新出现一条 `critical` / `high` 的站点级问题
- （仅当 `--tolerance N > 0`）总分跌幅超过 N

不阻断：新增页面的问题、波动规则（LCP/CLS/FCP）、低/中severity 的新增、分数小幅下降。

`diff.md` 是同一份结论的 Markdown 版，可直接贴进 PR 评论。
