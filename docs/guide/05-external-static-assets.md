# 可选跨源静态资源补抓

`live export` 可用 `--external-static-approvals <JSON 文件>` 补抓候选包里仍被 HTML/CSS 引用的跨源静态资源。必须同时使用 `--offline --strict`；不传该参数时不进行跨源网络补抓。批准文件只在导出进程读取，不进入交付包。

```powershell
node core/src/cli.mjs live example.org --offline --strict --materialize-har --external-static-approvals .\external-static-approvals.json
```

文件格式是 JSON 字符串数组，最多 50 个规范化的完整 HTTPS URL，没有通配符或域名级批准。例如：

```json
["https://static.example.net/css/site.css?v=1"]
```

批准列表应按候选包中尚未本地化的实际引用准备；被 HAR 落盘提前消除的引用无需再次批准。模块在候选包复制、HAR 落盘及自愈之后运行，再重新扫描 `health.json`。`health.externalStatic` 记录批准数、成功数、失败数、读取字节和失败项的批准列表索引；整体扫描异常只记 `capture-error` 类别，不写异常文本或 URL。`strictBlockers.externalStaticFailed` 或其余跨源缺口大于零时，候选包保留用于诊断，旧正式包不会被覆盖。

直接调用内部模块时需明确提供 `approvedUrls`：

```js
import { localizeApprovedExternalStaticAssets } from './src/live/external-static.mjs';

const { report, urlMap } = await localizeApprovedExternalStaticAssets({
  liveDir: '/candidate/site/live',
  host: 'example.org',
  origin: 'https://example.org',
  approvedUrls: ['https://static.example.net/css/site.css?v=1'],
});
```

只在候选包副本上调用：函数会写入 `site/live/_ext/`，并改写候选包中 `site/live/` 与静态克隆页里的 HTML、CSS 资源引用；不会改写导航链接或 JS 文本。它只抓候选 HTML/CSS 实际引用的批准 URL；下载后发现的 CSS 嵌套资源也必须逐条批准。通过 `--materialize-har` 提前落盘的跨源 CSS 会按 HAR 中实际映射的原始 CSS URL 解析相对引用。报告的失败项只给批准列表的索引和原因，避免把查询值写入交付报告。`urlMap` 只用于导出进程的依赖对照，不会序列化进报告。

默认单资源读取预算 5 MiB、累计响应体读取预算 32 MiB、每个 URL 最多 2 次同源重定向、每次请求 10 秒；可配置上限分别是 10 MiB、100 MiB、3 次和 15 秒。读取在响应体分块边界停止，最后一个分块可能使实际读取字节数略超预算，报告以 `transferBytes` 记录。仅接收公开 HTTPS URL；不发送 Cookie 或登录头；仅接收与引用用途相符的明确脚本、样式、字体、常见图片及媒体 MIME。HTML、JSON、SVG、未知 MIME、跨源重定向、私有查询参数和 CarbonAds 服务域名均不本地化；明显非静态的文件后缀在请求前拒绝。

域名字符串过滤不能证明解析后的 IP 是公网。即使精确批准了域名，DNS 也可能解析到私网地址，或在校验后发生重绑定；调用方应在隔离网络中运行，并在 DNS、代理或出口防火墙层禁止访问私网和元数据服务。批准列表只应由可信操作员维护。当前内部模块没有网络层 IP 约束，不能单独充当任意 URL 抓取服务的安全边界。

补抓成功只表示这些文件已搬进候选包。脚本运行时继续发起的 API、实时连接、未批准资源，以及尚未镜像的页面仍须由 `--offline --strict` 的静态扫描与浏览器探针检查；失败候选不能发布为离线可用。广告等第三方运行时服务需要明确标为不支持或由站点所有者实现经审核的本地替代，不能把静态脚本下载视为业务等价。
