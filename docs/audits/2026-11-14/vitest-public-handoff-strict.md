# `vitest.dev` 三页 `handoff --strict` 失败边界实测

日期：2026-11-14。

## 结论

本轮使用公开、无登录、只读的 `https://vitest.dev/`，限制为首页、博客页和 `/api/test` 三页。新版 `handoff --strict` 正确返回非零：侦察 3/3 页、克隆 3/3 页、三视口 3/3 页完成，视觉平均 99.7%，但严格离线交付被阻断，正式包没有被覆盖。

阻断数为 112，包含 12 个未解析资源、3 个外链资产、2 个不支持的第三方运行时、91 个未镜像站内链接、3 页断网浏览器失败和 1 个隐私扫描不完整。候选包与 `health.json` 保留，交接说明逐项列出这些原因。

这个案例说明视觉高分不能替代独立部署门禁。`handoff` 保留“测量已生成但证据不完整”的页面状态，也没有把 strict 失败降级成成功。

## 运行与结果

运行数据写在仓库外：

```text
D:/Github-Star/heimdall-evidence-archive/2026-11-14/public-handoff-vitest-strict-20261114/
```

```powershell
$env:HEIMDALL_DATA_DIR = 'D:\Github-Star\heimdall-evidence-archive\2026-11-14\public-handoff-vitest-strict-20261114'
node core/src/cli.mjs handoff https://vitest.dev --max-pages 3 --strict
```

| 环节 | 结果 | 证据 |
| --- | --- | --- |
| 侦察 | 3/3 页，页数上限触顶，范围受限 | `workspace/vitest.dev/recon/atlas.json` |
| 克隆 | 3/3 页完成，259 个引用，175 个本地化 | `workspace/vitest.dev/pages/`、`audit/asset-gaps.json` |
| v2 还原度 | 3/3 页完整测量，平均 99.7%，最差首页移动视口 98.2% | `workspace/vitest.dev/verify/verify-summary.json` |
| 视觉证据状态 | 1 页证明为 stale；数字保留但不作为门禁通过 | `workspace/vitest.dev/handoff/README.md` |
| strict 离线 | `status=blocked`、`published=false`、阻断数 112 | `workspace/vitest.dev/live-export.json`、候选 `health.json` |
| 浏览器探针 | 3/3 页检查，3/3 页失败，0 页未测 | 候选 `health.json` 的 `browserProbe` |

主要阻断来源：

- 页面脚本引用的多个 `/assets/*.js` 在候选包中缺失，造成 HTTP 404 和请求失败。
- `/api/test/` 与 `/blog/` 仍触达 CarbonAds，`/api/test/` 还触达 DoubleClick。
- 三页共有 91 个未镜像站内链接。
- 候选包的 `har.json` 超过隐私扫描文件预算，扫描状态为 incomplete；没有发现凭据型问题。

## 证据边界

- 三页是 `--max-pages 3` 的受限样本，不能代表 Vitest 全站。
- 视觉通过只描述捕获页面和当前验证器；stale 证据不进入交付门禁。
- strict 失败原因已被定位，但本轮没有自动删除广告、补抓缺失页面或接受第三方运行时降级。
- 页面没有观察到业务 API；认证、权限、写入、状态机和实时连接保持未知。
