# `cloneTask` 多案例复验

日期：2026-11-15  
范围：本机外部归档中的公开只读快照；没有登录、写入或业务副作用。

## 复验方法

每个案例都使用当前工作树的同一命令，只切换脱敏数据根目录：

```powershell
$env:HEIMDALL_DATA_DIR = '<case-data-root>'
node core/src/cli.mjs site-assessment <site-id> --json
```

`cloneTask` 读取当前扫描结果。旧的 `verify/verify-summary.json` 不能覆盖当前页面的 `missing`、`stale` 或 `incomplete` 状态。

## 当前结果

| 案例 | 页面 / 镜像 | 当前视觉验证 | strict 交付 | `cloneTask` | 独立部署 | 其他证据 |
| --- | ---: | ---: | --- | --- | --- | --- |
| `example.com` | 1 / 1 | 1 / 1 | `passed` | `ready_for_ai_review` | `verified` | scope limited；API missing，QA not_configured |
| `vitest.dev` | 3 / 3 | 2 / 3 | `blocked`，96 个阻断，12 条浏览器失败 | `blocked_on_visual_verification` | `unknown` | API missing，QA not_configured |
| `iana.org` | 8 / 8 | 0 / 8 当前有效 | `blocked`，248 个阻断 | `blocked_on_visual_verification` | `unknown` | API adapter_observed，QA not_configured |
| `rfc-editor.org` | 0 / 0 当前归档镜像 | 未开始 | `not_recorded` | `blocked_on_capture` | `unknown` | SEO 84，GEO 68.4，API missing，QA not_configured |

## 结论

- `example.com` 证明当前声明范围内的静态交付和独立断网部署可以通过；由于范围仍受限，`cloneTask` 保持 `ready_for_ai_review`，并要求 `allDiscovered` 复测，不再显示为无缺口 `ready`。
- `vitest.dev` 证明多页站点会保留部分视觉验证和 strict 阻断，不会把 2/3 页面包装成完整通过。
- `iana.org` 的旧摘要记录了通过结果，但当前扫描把 8 页都视为非当前有效；`cloneTask` 正确停在 `blocked_on_visual_verification`。
- 当前 RFC Editor 归档目录只有 SEO 报告，没有页面目录。此前 6/6 镜像和视觉验证记录应保留为历史现场，不能用当前归档重新声称已复现。

## 本轮改动

`scope.visual.verificationGaps` 现在返回当前扫描发现的前 50 个页面及其状态，并保留 `total` 与 `truncated`。这给 AI 提供具体复测对象，同时避免把旧验证摘要当成当前证据。

对 `example.com` 的同一份真实归档复核还确认：`readiness.clone.status=ready` 只表示页面和视觉验证通过；`readiness.clone.scope.status=needs_scope_review`、`scopeLimited=true` 才表示当前整站范围仍未闭合，`readiness.delivery=last_check_passed` 也不会清除这个范围缺口。

仍未证明登录、权限、写入、状态机、WebSocket、持久化和外部副作用等价。公开快照也不能证明任意站点的克隆成功率。

## 克隆范围门禁复验

同一批归档在范围门禁加入后重新读取：

| 案例 | 当前范围 | `scopeLimited` | `cloneTask` | 范围动作 |
| --- | --- | --- | --- | --- |
| `example.com` | `recon-discovered` | `true` | `ready_for_ai_review` | `allDiscovered` |
| `vitest.dev` | `recon-discovered` | `true` | `blocked_on_visual_verification` | 被更早视觉阻断覆盖 |
| `iana.org` | `unknown` | `true` | `blocked_on_visual_verification` | 被更早视觉阻断覆盖 |
| `rfc-editor.org` | `unknown` | `true` | `blocked_on_capture` | 被更早采集阻断覆盖 |

这保留了“当前范围可交付”和“整站范围完整”之间的区别。

## SEO/GEO 行动元数据复验

2026-11-15 在同一批脱敏归档上重新读取 `site-assessment`，确认行动列表的截断元数据不会改写克隆门禁：

| 案例 | SEO/GEO 任务 | observed actions | medium advisories | `actionsTruncated` |
| --- | --- | ---: | ---: | --- |
| `example.com` | `blocked_on_observation` | 0/0 | 0/0 | `false` |
| `vitest.dev` | `blocked_on_observation` | 0/0 | 0/0 | `false` |
| `iana.org` | `blocked_on_observation` | 0/0 | 0/0 | `false` |
| `rfc-editor.org` | `ready_for_ai_review` | 8/8 | 2/2 | `false` |

合并返回超过 20 条的边界由 20 条 SEO 加 1 条 GEO 的脱敏 fixture 覆盖，专项测试验证 `observedActionsMeta.truncated=true`。真实归档复验只证明当前样本的投影稳定，不能外推任意站点的 SEO/GEO 结果。
