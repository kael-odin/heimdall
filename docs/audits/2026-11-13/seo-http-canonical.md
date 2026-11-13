# HTTP canonical 与冲突声明实测

2026-11-13。修复 RFC Editor 真实页面的规范地址漏采，并把同一证据贯通 SEO、GEO、分页与 HTML 报告。没有新增运行模块、依赖、测试文件或规则 ID；14 个冻结验收文件未改动。

## 机制与实际误报

Google Search Central 的 [canonical 指南](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)认可 HTML 和 HTTP Link 两种声明方式，建议避免不同目标的冲突。规范地址关系见 [RFC 6596](https://www.rfc-editor.org/rfc/rfc6596)，HTTP Link 的 URI、关系与上下文见 [RFC 8288 第 3 节](https://www.rfc-editor.org/rfc/rfc8288#section-3)。这些是声明信号，不证明搜索引擎已采纳。

本次公开 GET 冻结 RFC 6596、RFC 8288 的 HTML 页面及 Example Domain。只保存状态、Content-Type、Link 和初始 HTML，不保留 Cookie 或其他响应头。两个 RFC 页面都在 HTTP Link 中指向各自 `/info/rfc…/` 地址，HTML 没有 canonical；原工具只看 HTML，均误报缺失。

## 最小改动

- 采集复用现有响应头读取，新增同文件的 Link 解析；不按逗号直接拆分 URI 或引号参数。HTTP 相对目标按导航响应地址解析，不受 HTML base 影响；非法或含凭据的目标不作为可用地址，带 anchor 的头部链接保守忽略。
- 保留 `canonicalEvidence.html/http/conflict`。HTML 仅采集渲染后 head 内的声明；相同目标去重，不同目标时 `canonical` 留空。SEO 复用 `index-canonical-mismatch` 提示冲突，GEO 对该项保留 unknown，分页不再把冲突重复报成缺失。
- 非自指或跨域声明本身不是已证实的 SEO 缺陷，改为不扣分观察；是否归并取决于内容和发布意图。HTML 报告展示声明来源和冲突状态，不把声明写成实际索引选择。
- 地址比较复用已有完整 HTTP(S) 资源身份函数，保留协议、查询及尾斜杠差异，删除原来只比路径的重复 helper。现有健康页测试补入跨域、查询、协议及尾斜杠对照，均仅记录观察且不改变分数。
- SEO 评分 **12**、测量 **8**、GEO **7**，仍为 **64 条规则**。使用手册、基线示例及报告口径同步；旧基线保持原样，须选新路径重新采集审核。
- 集成测试发现升级后旧版本列表隐藏了仍适用的报告说明，已改为按中央版本号的有效范围检查；未来未知版本仍不会套用当前说明，删除逐版追加的重复列表。

## 同批真实页面重放

采集先于产品改动。原 URL 上的真实 Chromium 重放使用冻结的初始 HTML、状态及 Link，子资源隔离；没有核对 sitemap、现场性能或全站发现，明确 `baselineEligible:false`。这是机制校准案例，不是盲测或完整线上审计。

| 页面 | 初始 HTML canonical | HTTP Link canonical | 单页 SEO 11→12 | GEO 6→7 |
|---|---|---|---|---|
| RFC 6596 HTML | 无 | `/info/rfc6596/` | 21→27 | 27.1→33.3 |
| RFC 8288 HTML | 无 | `/info/rfc8288/` | 21→27 | 27.1→33.3 |
| Example Domain | 无 | 无 | 64→64 | 22.8→22.8 |

三个原始 HTML 的 SHA-256 在前后回放一致。RFC 分数变化来自工具补采，不代表站点内容、搜索排名或模型引用效果改善。现有低分也不能解释为网站质量结论。

另以真实 Chromium 直接访问相同三个公开地址，均 HTTP 200 且取得初始导航 HTML：两个 RFC 的 HTTP canonical 与冻结记录一致，Example Domain 仍未发现声明。直接访问只用于核对当前采集行为，不把与冻结回放之间的性能和其他头部差异合并为分数结论。实际 HTML 报告已渲染，声明来源可见，1440px 视口无水平溢出。

## 回归与边界

现有采集测试加入 23 组浏览器对照：重复头、逗号与分号、转义引号、关系列表、重复 rel、相同目标、HTML/HTTP 冲突、多 HTML 冲突、anchor、非法地址、凭据地址、HTML base、实际 302 后的相对解析、body 声明与缺失对照。未闭合引号中的伪链接也不能被重新扫描成 canonical。相关采集、评分、GEO、分页、基线、矩阵和站点评估测试 **164/164** 通过，无跳过。

另有现有 SEO 采集/基线门禁十条通过，覆盖 HTTP 错误、初始 HTML 不可用、跨来源跳转、部分 sitemap、漏采页、旧采集及旧口径基线的保护；与前组去重共 **174 条**，不累计重跑。首次集成运行发现的报告说明遗漏及失败日志保留，修正后全部通过；中央版本测试另确认未来未知口径不会套用当前说明。语法检查 765 文件、14 个冻结文件、775 个文档目标和 843 KB 插件新鲜度检查通过。

证据位于 `D:/Github-Star/heimdall-evidence-archive/2026-11-13/seo-http-canonical/`，包括 `capture.json`、三份冻结 HTML、前后完整采集 JSON、最终 `final-source.json`、`live.json`、`verification-current.json`、报告截图、红灯与回归日志、官方指南快照。首次驱动的 Windows ESM 导入错误、首次后测的主机上下文错误均保留，后者按实际 audit 的去 www 口径修正；此前缺失项的分数不受该主机参数影响，没有覆盖旧输出。

未验证 canonical 目标内容、可访问性、HTTP hreflang、sitemap canonical、初始与渲染后 HTML 声明差异、PDF 正文、实际索引资格或真实模型引用。本轮不提供任意网站等价或生产业务正确性结论。
