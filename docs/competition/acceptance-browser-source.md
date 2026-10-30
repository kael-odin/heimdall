# Browser 所选侧候选基线：字节核验内核

Browser 验收已经能够对照参考页和目标页，生成视觉、结构、健康与交互报告。本切片增加纯字节核验器：明确选择一次已完成运行的 `baseline` 或 `target` 侧，核验原件和全部实际引用证据，生成完整候选预览及版本化摘要。它为后续页面基线的批准和复验提供来源合同。

当前交付是内部模块 [browser-candidate-projection.mjs](../../core/src/acceptance/browser-candidate-projection.mjs)，已有独立的[owner 私有读取器](acceptance-browser-reading.md)捕获全引用原件。控制台和项目目录仍只开放 Spec 候选；Browser 的版本归属、批准、选用和托管执行另行接入。公开投影函数不返回私有计划或原始字节，预览固定 `executionReady:false`。

## 为什么按侧核验

原报告比较的是旧参考页和旧目标页。整体门禁为 `failed`，可能只是目标出现视觉 BUG，健康的参考侧仍能提供基线材料。目标侧健康且观测完整时，也可以交给人工审阅，判断其外观和行为是否应成为新的认可版本；原报告的失败结论继续保留。

旧报告的 `expected` 和检查身份中的 `oracleKey` 始终基于旧参考侧。选择 `target` 时，新候选从目标截图、DOM 摘要、HTTP 状态及规范计划中的操作和断言重建 oracle。复制旧 `expected` 会让目标截图与参考侧期望混在一起，本模块独立重建并以固定反例阻止这种混用。

## 调用合同

```js
import { projectBrowserBaselineCandidate } from './browser-candidate-projection.mjs';

// files 是内部采集的原始字节 Map，不接受路径或网络 URL 代替原件。
const { projection, preview } = projectBrowserBaselineCandidate(
  { snapshot: { manifest, report, integrity }, files },
  { sourceSide: 'target' },
);
```

`files` 为原生 `Map<basename, Buffer | Uint8Array>`，包含 `manifest.json`、`report.json` 及报告实际引用的每一份非空证据。`sourceSide` 必须显式为 `baseline` 或 `target`；不从门禁、URL 或最近运行推断。输入拒绝 getter、Proxy、稀疏数组、共享内存和超预算 JSON。函数不发请求、不读写文件、不创建 ID 或时间值，也不修改调用方数据。

内部 `verifyBrowserBaselineMaterial` 另返回 freshly parsed 的规范计划，供将来的受控服务器读取链使用。公开调用只返回 `projection` 和 `preview`。两者使用独立的 Browser domain/version，不能直接写入现有 Spec catalog schema。

## 核验范围

核验器按规范计划重建全部 `route × viewport × 六个基础维度`，以及对应的 `point × viewport`。六个基础维度为导航、脚本、网络、水平溢出、结构和视觉；报告中若实际存在只读阻断，还要有对应附加槽。检查 ID、角色文件名、声明操作和断言、原检查身份、旧期望和实际、coverage、summary 与 gate 都要与重建结果一致。仅重算外层摘要不能掩盖缺槽、重槽或跨路由、视口和交互点借用证据。

原 manifest/report 字节必须与 snapshot 一致；原计划指纹、报告摘要、已审阅的验证器指纹、全部实际引用文件的长度和 SHA-256 均独立重验。多余未引用索引不进入“已验证证据”摘要。未选侧导航失败时，原截图和重复截图允许为 `null`；所选侧的详情、首张截图和重复截图必须齐全。

所选侧还须满足：导航成功、HTTP 2xx/3xx、DOM 非空、全部声明操作完成、全部声明断言通过、无已观测脚本/网络/只读阻断/水平溢出、完整全页截图、遮罩与采样未触顶、重复截图稳定。PNG 解码前核对全部 chunk、唯一 IHDR、尺寸、单图像素、累计像素及比较包围网格预算；只接受当前捕获器与 diff 编码器的 8 bit RGB/RGBA 非隔行子集。稳定性根据真实 PNG 重新计算，不信任 `details.stability` 自报值。这里的“健康”只涵盖声明范围和有界观测，人工仍须审阅截图是否符合产品意图。

| 预算 | v1 上限 |
| --- | ---: |
| 单份 JSON / snapshot | 8 MiB / 24 MiB |
| 完整 preview | 2 MiB，超限直接拒绝 |
| 实际引用证据 | 1024 份，单份 64 MiB，总计 256 MiB |
| PNG 单边 / 单图像素 | 12000 / 12000000 |
| PNG 累计像素 | 96000000，包含双方与 diff 的实际引用图 |
| PNG chunk / 每对比较网格像素 | 4096 / 12000000 |
| 重复截图稳定性 / 遮罩比例 | 至少 0.9995 / 至多 0.8 |

规则记录 runner 的有效值，例如 schema 中 `settleMs:3000` 实际按 runner 上限 2000 执行。Browser 首版只接受在 `e427ec1` 独立审阅的十源实现对应的 LF / CRLF 两个固定摘要，不自动继承 Spec 的早期兼容映射，也不从运行时当前源码自动加入新版本。

完整 preview 包含每个观测槽的所选侧证据、结构与截图摘要、规范操作及断言、捕获/遮罩/稳定性、全部规则和 URL 证明范围。完整规范 entry URL 与 resolved route 可由原计划锁定；捕获的最终 URL 已去除 query 值，只能证明仍保留的字段。模块不声称完整最终查询值、重定向链、文件系统归属、签名历史或未来同 URL 部署内容被冻结。

## 固定样本与复现

[固定真实样本](../../core/test/fixtures/acceptance-browser-source/source-index.json)由现有 Chromium runner 和完成存储器生成，原件逐字节保留。主样本包含两条路由、两种视口、两个交互点和 28 个检查；另有两组对称的单侧导航失败，以及一组真实断言失败。失败侧的空截图不计入实际引用集合。

现有 legacy snapshot reader 把 `null` 证据角色视为无效，因此两个导航失败样本的 `integrity.json` 是按全部非空引用字节及完成索引独立核对后构建的交接值，不能冒充 legacy reader 已原生支持 nullable。原始 manifest、report、details 和 PNG 没有重写。新增 Browser 私有读取器原生保留这些空角色并重建一致的 integrity；Spec 证据规则保持独立。

```powershell
node --test core/test/acceptance-browser-candidate-projection.test.mjs
pnpm acceptance:browser:source:smoke

# 显式采集一批新材料，只接受尚不存在的目录；不覆盖冻结样本。
node core/scripts/freeze-acceptance-browser-source.mjs core/workspace/_runs/browser-source-new
```

真实采集与离线反例的结果见[实施验收记录](../audits/README.md)。固定夹具不能证明真实外部开发项目的通用覆盖；认证、写操作、数据库、完整状态机及持久 BUG 账本仍需独立建设。
