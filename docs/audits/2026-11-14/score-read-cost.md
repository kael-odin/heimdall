# 评分读取与失效产物成本实测

日期：2026-11-14。

## 结论

本轮用已归档的 IANA 公开站点 8 页副本和 Datasette 独立部署 83 页副本复测当前 CLI 读取链路，确认旧单页评分不会被静默当成当前评分：IANA 8 页和 Datasette 83 页的 `scoreStatus` 均为 `legacy`，`site-assessment` 的 `clone.averageScore` 均保持为空，`scoreStatuses.verified` 均为 0。评分读取路径会保留状态并排除无效分数。

当前实现还会把多视口验证已经核实的 `inputSha256` 传给评分读取，因此已验证页面不再重复哈希整棵 clone 树；没有有效验证证据的页面仍会独立核对输入。这两组归档产物都没有当前有效多视口证据，所以本轮成本数据主要是失效状态扫描基线，不把它包装成大站复用收益证明。

## 范围与命令

数据来自工作树外的公开、只读归档：

```text
D:/Github-Star/heimdall-evidence-archive/2026-11-12/iana-local-search/data
D:/Github-Star/heimdall-evidence-archive/2026-11-13/datasette-standalone/data
```

在 `D:/Github-Star/heimdall` 运行，使用 Node.js 26.12.1：

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-12\iana-local-search\data'
node core/src/cli.mjs site iana.org --view pages --limit 200 --json
node core/src/cli.mjs site-assessment iana.org --json
```

每个数据集的两条命令各运行 5 次，使用响应 `meta.durationMs` 记录引擎调用耗时。

## 结果

| 数据集 | 调用 | 5 次耗时（ms） | 中位数 | 结果摘要 |
| --- | --- | ---: | ---: | --- |
| IANA 8 页 | `site --view pages` | 265, 317, 287, 254, 251 | **265** | 8 页；`legacy:8`；`stale:8` |
| IANA 8 页 | `site-assessment` | 298, 253, 255, 253, 284 | **255** | 8 个镜像；平均分 `null`；`verified:0`、`legacy:8` |
| Datasette 83 页 | `site --view pages` | 336, 349, 356, 342, 351 | **349** | 83 页；`legacy:83`；`verifyStatus:stale` 10 页 |
| Datasette 83 页 | `site-assessment` | 337, 336, 327, 340, 332 | **336** | 83 个镜像；平均分 `null`；`verified:0`、`legacy:83`；交付 `blocked` |

补充的直接哈希成本样本仍保留在 `2026-11-13/mirror-reference-integrity/hash-scan-cost.json`：8 页 clone 合计 117,707,179 bytes；单页首次直接哈希最大 16.3146 ms，热缓存中位数最大 14.4604 ms。

## 解释与边界

- 这次复测证明 `legacy`、`stale` 和空平均分会沿当前 CLI 链路被稳定报告，不会把历史分数伪装成当前结果；83 页样本也没有因规模扩大而把历史分数重新纳入平均值。
- 直接哈希样本和 CLI 耗时都来自单机归档数据，可能受操作系统文件缓存影响；没有测量并发、内存、浏览器验证、资产索引或多百页站点的累计成本。
- 这不是 SEO/GEO 效果、视觉还原度或后端等价性的证明；IANA 归档仍需重新生成当前多视口证据后，才能得到可用的当前评分。

## 下一步

下一批用经授权的 80 页左右站点，分别测量旧输入、单页变化和批量变化下的 `site`、`site-assessment`、资产索引及多视口验证耗时；记录峰值内存和并发，之后再决定是否需要异步索引或外部变更通知。当前代码没有为尚未证明的规模提前增加缓存层。
