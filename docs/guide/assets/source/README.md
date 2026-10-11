# 图源

这两份 JSON 是上面两张图的**可编辑源**。改图不要改导出的 HTML —— 那是产物，改完重跑就没了。

```bash
# 需要一个 archify 的检出（技能目录），把 <archify> 换成实际路径
ARCH=<archify>
node "$ARCH/bin/archify.mjs" finalize architecture \
  docs/guide/assets/source/architecture.json \
  docs/guide/assets/architecture.html \
  --repo-root . --quality showcase --json
```

`finalize` 会依次跑校验、导出、严格检查与真实浏览器检查四道门，任何一道不过都会指出具体原因
（例如"这两个节点之间的间距放不下这条关系标签，至少需要 84px"）。改完记得重新导出一张 PNG
放进同目录 —— Markdown 里嵌的是 PNG，因为 GitHub 不会预览 `.html`。

| 文件 | 图 | 说明 |
| --- | --- | --- |
| `architecture.json` | 三层架构 | 节点上带 `sources`，指向仓库里的真实文件与行号 |
| `clone-sequence.json` | 一次整站克隆的时序 | 含"引擎重启后从断点续跑"那一段 |

> 节点里的 `sources` 是**证据**：每条都指向仓库里能核对的位置。
> 改了代码导致职责变了，这些引用也该跟着改 —— 图与代码对不上时，以代码为准。
