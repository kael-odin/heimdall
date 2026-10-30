# Browser 来源私有读取器

Browser 基线的来源需要两层核验：先在已有验收目录 owner 内捕获原始字节，再由[纯投影器](acceptance-browser-source.md)明确选择 `baseline` 或 `target` 并核对声明语义。本切片新增内部读取器 [browser-candidate-source.mjs](../../core/src/acceptance/browser-candidate-source.mjs)，原生保留导航失败侧的空截图，始终核验报告双方及 diff 的全部实际引用。

读取成功表示捕获的材料满足有界读取合同。页面健康、来源资格和新 oracle 仍由纯投影器判断。这里没有项目版本归属、目录写入、批准、选用、HTTP/UI 或托管 Browser 执行入口；Spec 的既有读取器和证据规则保持独立。

## 内部调用

```js
import { readBrowserCandidateSource } from './browser-candidate-source.mjs';
import { projectBrowserBaselineCandidate } from './browser-candidate-projection.mjs';

// owner 必须是调用方已经取得的真实验收目录 owner。
const material = readBrowserCandidateSource(runId, { root, owner });
const { projection, preview } = projectBrowserBaselineCandidate(material, {
  sourceSide: 'target',
});
```

reader 不接受 `sourceSide`，不根据门禁或 URL 推断选侧。返回值精确为 `{ snapshot, files }`；私有 `Map<basename, Buffer>` 包含原始 `manifest.json`、`report.json` 和每份实际引用证据。Buffer 不附加到 snapshot，也不写进目录、HTTP、AI 输入。调用方修改一次返回值不会污染后续读取。preview 继续固定 `executionReady:false`。

参数只接受原生 data descriptors，拒绝 getter、Proxy、未知字段及增加上限的预算。错误使用固定安全信息和 reason，不附带 fs cause、绝对路径、errno 或解析器原文。输入无效返回 400；运行不存在为 404；材料不完整、不支持来源和 managed 隔离为 409；owner 未取得、已释放或身份失效为 503。

## 所有权与文件核验

读取器调用真实 `assertAcceptanceOwner(owner)` 私有品牌检查。方法外形相同的 facade、代理包装、其他 root 的 owner、已释放 owner、被替换的 owner 锁都无法作为能力。owner 在取得所有权时固定 canonical root 的真实目录身份，关闭原先首次 reader 捕获之前仍可搬回原锁到替换 root 的窗口；assertOwned 与 owner 写入 / 清理也复查这层身份。reader 本身不创建目录、不获取或恢复 owner，也不修复损坏材料。

requested root 在每次 fence 时必须仍解析到相同 canonical root。同一 owner 的 canonical root 从 acquire 起跨调用固定；run directory 身份在本次捕获期间固定，每次新调用重新 pin。没有跨调用固定 run 目录的保证。同目标 alias 链接重建可以接受：读取路径始终来自固定 canonical root，本片没有冻结 alias 链接实体或整条父目录链；alias 换向其他 root、canonical root 同路径重建或本次读取途中 run 换代会被拒绝。

canonical root 已替换时，owner.release 返回 false 并保留新目录现场。只有调用方 alias 换向、原 canonical root 本身仍完整时，release 继续允许清理原目录内自己持有的锁；普通目录内容新增和 metadata 中的 mtime / ctime 变化不会单独导致失去所有权。

每份 head 和实际引用证据必须为 run 目录内的直接 regular file，拒绝 symlink、junction 和 `nlink !== 1` 的硬链接。读取按 `lstat → open → fstat → 有界分配 → 循环 read → EOF → fstat / path / owner fence` 执行；能使用时额外带 `O_NOFOLLOW` / `O_NONBLOCK`。读取前检查预算，不以无界 `readFileSync(fd)` 代替。短读继续，截短、增长、非法 read count、文件身份或 metadata 变化均阻止返回；所有已打开描述符尝试关闭，close 失败保守拒绝且不盲目重试同一个 fd。

manifest / report 首读后核对 runId、Browser mode、completed、旧 plan 指纹、原 report SHA、URL、summary 和 gate 自洽。全部实际引用先 pin，再分别两次有界读取并比对真实字节和索引长度 / SHA；随后重读 heads，检查全部 metadata、managed namespace 以及最终 owner / root / run fence。读取期间不更改原报告 gate。

## 空角色与预算

每个 Browser 检查必须包含六种已知基础角色，可以另有 `diff`。只有 `baselineScreenshot`、`targetScreenshot`、`baselineRepeat`、`targetRepeat` 可以为 `null`；两侧 Details 必须为文件名，diff 若出现也必须为文件名。未知角色、缺角色、空字符串、保留名、非法文件名、重复或大小写冲突索引都拒绝。所有实际非空引用都必须被索引并核验，包含未选侧和 diff；未引用索引不被读取或计入 verifiedFiles / verifiedBytes。

| 预算 | 默认上限 |
| --- | ---: |
| 单份 manifest / report | 8 MiB |
| 检查 / 证据索引与实际引用 | 各 1024 |
| 单份 / 全部引用证据 | 64 MiB / 256 MiB |
| head JSON depth / nodes | 80 / 400000 |
| head JSON 字符计数 | 32 Mi 字符，含字段名 |

`limits` 仅能降低各上限。JSON 在后续 stringify、summary 和语义遍历前检查复杂度；字节预算先于文件分配。PNG 与完整 preview 的更严格预算由纯投影器继续核验。

## 托管隔离与证明范围

reader 在读取 head 前建立 `createLegacyAcceptanceReadScope`，核对 run 没有被 managed dispatch inventory 保留，解析 head 后再检查 marker。即使 marker 为 false 也拒绝。损坏或不可读的 namespace 不能当空集合；新建、增加、删除、替换以及其他读中 namespace 变化会阻止返回。检查 namespace 后再次核验来源和 owner，不把普通 Browser 材料变成 managed 执行能力。

最终 fence 只能说明本次有界捕获完成时核验合同成立。它不能保证跨文件原子快照、目录永远不变、签名历史、不可变部署或 release 身份。以后写目录必须重新读取并在提交前再次设置来源 guard；旧 material 不是永久授权。现有 run binding 只记录 target URL，不能用它宣称 baseline 属于同一个 release。

## 复现

```powershell
node --test core/test/acceptance-browser-candidate-source.test.mjs
pnpm acceptance:browser:read:smoke
```

smoke 新采集四次本地 Chromium 运行，取得 owner 后验证全部原件、两向 nullable、八个明确选侧案例、返回值隔离和 owner 拒绝，同时检查读取阶段没有同步写入、fetch 或进程启动，原文件字节和被观测 metadata 不变。结果与边界见[实施验收记录](../audits/README.md)。它不能代替真实外部项目、认证业务或目录批准 UI 的验收。
