# IANA 公开站点三能力实战

日期：2026-11-16。

目标：用一个无登录、无写入授权的公开站点，复核克隆、SEO/GEO 和前后端缺陷检测是否能分别给出证据与未知项。

## 范围和命令

目标入口：`https://www.iana.org/help/example-domains`。

侦察预算：最多 3 页、纳入当前侦察发现的全部同源 URL、strict 交付。

原始运行写入临时数据目录，未进入仓库。站点没有登录态、Cookie、令牌或写入操作。

## 克隆和独立交付

| 阶段 | 结果 |
| --- | --- |
| 侦察 | 3 页，`/help/example-domains`、`/`、`/about` |
| 克隆 | 3/3 完成 |
| 多视口验证 | 3/3 页、375/768/1440 三视口、平均 100% A |
| 视觉资产缺口 | 0 |
| 资源本地化 | 90 个引用中 84 个，93.3% |
| strict 初次交付 | blocked，97 个阻断计数 |

strict 阻断包含 2 条 cse.google.com 外部运行时、1 个 Google CSE 本地脚本失败、88 个当前 3 页范围外链接、2 个跨域别名跳转和 1 个未解析的本地脚本路径。链接数量反映当前受限范围，不代表 88 个独立缺陷。

先运行 `--heal --materialize-har`，结果仍为 1 个 unresolved 和 1 个浏览器失败。随后人工批准缓存 2 个公开 cse.google.com GET，2/2 获取成功，约 134 KB；Google 静态脚本的批准抓取失败，因此 strict 继续阻断。该结果验证了“可安全缓存的运行时进入回放，无法获取或无法确认的第三方运行时继续阻断”的分流。

## SEO、GEO 和 QA

SEO/GEO 报告覆盖 3 页，评分口径和测量口径均为 current：

| 指标 | 结果 |
| --- | --- |
| SEO | 74，等级 C |
| SEO 问题 | critical 0、high 3、medium 5、low 6、info 11 |
| GEO | 54.2，高置信度，3/3 页完整 |
| GEO 行动 | 8 条，实体、可抽取性和引用准备度为主要缺口 |
| 真实搜索/收录 | unknown |
| 真实模型引用 | unknown |

QA 使用临时只读工作区，执行 3 页 × 2 视口共 6 次检查：0 条建议提单、14 条可容忍结果、11 个检测器、0 个检测器失败。业务检查点为 `not_declared`，所以页面 QA 结果没有被解释成 API、认证、权限、状态机或业务验收。

## 站点评估结论

`site-assessment` 返回 `needs_human_review`：克隆状态为 `ready`，独立部署为 `needs_verification`，strict 交付为 `blocked`，SEO/GEO 为 `needs_follow_up`，后端为 `needs_observation`，QA 页面检查为 `ready`。QA closure 仍有 4 个 verified、1 个 open 和 1 个 unknown；API 契约缺失，业务检查未声明。

下一步是扩大侦察范围后复测 strict，人工决定第三方运行时的缓存、替换或阻断策略，并在有授权的站点上补充 API 契约、认证/权限矩阵、写入读回和业务检查点。该案例不能证明真实业务后端或整站功能等价。

## 复测修正

真实案例还发现评估摘要把辅助 `score.json` 缺失列成 `clone-score-not-current`，即使当前多视口验证已经给出 100% 还原度。修复后，只有没有有效多视口验证时才生成该 unknown；IANA 复测保留 `averageOverall=1` 和 3 页 `stale` 辅助分数状态，但不再把还原度标为未知。边界回归 7/7、站点评估回归 23/23。
