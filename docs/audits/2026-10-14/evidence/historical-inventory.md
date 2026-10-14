# 历史产物与评分口径盘点

盘点时间：2026-10-14。范围仅为本机 `core/workspace/` 的现存产物及当前 `core/src/verify/`、`core/src/url-canon.mjs` 代码；没有访问目标站、改写产物或重跑克隆。

## 规模与覆盖口径

| 指标 | 现值 | 解释 |
| --- | ---: | --- |
| 站点目录 | 22 | 排除 `_` 开头的工具目录 |
| 有 `recon/atlas.json` 的站点 | 15 | 其余 7 个不能据此计算星图覆盖率 |
| 历史 atlas 的不同规范化 URL | 657 | `canonUrl` 去 hash、统一尾斜杠后去重 |
| 配方排除类型 | 15 | 当前 `queue.excludeTypes`，默认含 `auth`、`legal` |
| 异源历史节点 | 1 | `apple.com` 的 atlas.origin 为 `https://www.apple.com`，却有 `https://www.apple.com.cn/` |
| 可比较的历史 atlas URL | 641 | 657 - 15 - 1；这是受当时 `maxPages` 限制的已发现集合，不是整个网站 |
| 已有对应 manifest 的 URL | 397 | 以 `manifest.target` 的规范化 URL 判定，不以目录名或旧任务行判定 |
| 未有对应 manifest 的 URL | 244 | 其中既有未启动/抽样任务，也有旧页名碰撞；不能全称作丢页 |
| atlas 内 URL 覆盖率 | 61.9% | 397 / 641，仅描述这批历史产物 |
| 页面目录 / 有效 manifest + clone | 408 / 407 | 多出 1 个无 manifest 的残留目录 |
| `score.json` | 407 | 管线的像素/DOM/数据综合分，均无 `scoreVersion`；与多视口 `verify.json` 不可混读 |
| `verify.json` | 62 | 61 份在 `apify.com`、1 份在 `ant.design`；全无 v2 `scoreVersion` |
| 完整三视口旧 verify | 59 | 另 3 份有超长页视口跳过，不能算完整测量 |
| 当前 v2 verify | 0 | 尚无站点历史产物接受新评分口径的正式重跑 |

`atlas.meta.maxPages` 在现存数据中常为 20、40、80、120；“覆盖 61.9%”不得写成“真实全站只覆盖 61.9%”。`nuxt.com` 有 22 个 atlas 节点而没有已克隆页；`apify.com` 则在当前配方排除 2 页后，120 个候选 URL 有 119 个对应 manifest。不同站点运行范围相差很大，应分别展示发现数、已克隆数、未覆盖数与抽样上限。

## 旧页名碰撞与残留

旧 `pageNameOfUrl` 只读 `pathname`，把 `/` 折成 `-` 并截断 60 字符，完全忽略 query。按这个旧规则映射历史 atlas 后有下列明确冲突：

| 站点 | 同一个旧目录名 | 不同 URL | 目前证据 |
| --- | --- | --- | --- |
| apify.com | `store-categories` | `/store/categories` 与 `/store/categories?managedBy=COMMUNITY` | 前者有 manifest，后者在 atlas 中但无 manifest；可确认缺一份克隆 |
| astro.build | `integrations` | `/integrations` 与 `/integrations?search=&categories%5B%5D=adapters` | 同上 |
| vercel.com | `home` | `/` 与 `/home` | 根页已有 manifest，`/home` 未克隆；还需核对站点语义后再补 |
| apple.com | `home` | `www.apple.com/` 与 `www.apple.com.cn/` | 后者与 atlas.origin 异源，应从该站覆盖率分母排除，不能直接补到 apple.com 工作区 |

现行 `createPageNameResolver` 按旧 manifest 的 `target` 保留原目录；新的 query URL 得到稳定哈希页名。例如 apify 的无 query 页仍是 `store-categories`，query 页为 `store-categories--512545d45acc9ae6449122ff08a7c2e5`。离线逐个喂入历史 atlas 的 URL，当前 resolver 在这些站点内均给出不同目录名；但这只证明新映射不再碰撞，不代表过去缺失的页面内容已经恢复。

`thordata.com/pages/products-serp-api-google-search-hotels/` 只有 `assets/` 和 `styles/`，没有 manifest 或 clone。这是未完成产物，不能算已克隆页，也不能据此判断为页名撞失；应保留现场直至对照任务日志后再处理。

## v2 小样本推算

当前比较器把仅出现在一侧的宽高区域计为缺失像素。旧 `verify.json` 保留了每视口的 `width`、`sourceHeight`、`cloneHeight` 和旧重叠区域 `mismatched`；在两图宽度均为记录的视口宽度的前提下，可**只读重加权旧观测**：

```text
overlap = width * min(sourceHeight, cloneHeight)
union   = width * max(sourceHeight, cloneHeight)
missing = union - overlap
derived_v2_pixel = 1 - (old_mismatched + missing) / union
```

这不是 v2 实测：旧完整多视口源图/镜像图在 verify 后被删除，历史 `pages/<name>/shot-src-full.png` 与 `shot-clone.png` 也并非同一种全页截图。当前源码与旧克隆还可能都已变化。推算结果只能用来确定重跑优先级，不得写回 `verify.json` 或与正式 v2 分数混排。

| 历史样本 | 旧综合分 | 用旧计数推算的新综合分 | 关键差异 |
| --- | ---: | ---: | --- |
| `apify.com/ideas` | 99.16%（A） | 72.96%（C） | 移动端原 98.69%，推算 58.89%；源高 13,926px，镜像高 8,310px，像素覆盖率 59.67% |
| `apify.com/jobs` | 95.07%（A） | 93.86%（B） | 三个视口均有 129–147px 高度差 |

59 份完整三视口旧记录中，按上述旧观测重加权有 2 页跨等级下降；另 3 份的部分视口因高度超过 25,000px 被跳过，即使旧记录显示 A 也不能据此认定三视口通过。`node --test core/test/verify.test.mjs` 本次执行 8/8 通过，包括 10×100 对 10×10、缺失宽度及不同尺寸像素联合面积的反例；这些测试证明新公式的实现，不是历史站点的实时验收。

## 可复现的只读盘点

除下面的原始盘点命令外，当前仓库还提供可重复的只读审计脚本。它会把每个历史页面的旧验证状态、仅用于排序的 v2 推算值，以及 atlas 中尚未克隆的 URL 身份写成 [JSON](historical-verification/historical-verification.json)、[页面 CSV](historical-verification/historical-verification-pages.csv) 和 [缺页 CSV](historical-verification/historical-verification-missing.csv)；query 值只保留 SHA-256 短哈希，不会把潜在凭据写进清单。本轮结果为 408 个页面目录、407 个有克隆页面、62 个旧验证、0 个正式 v2 验证、641 个可比较 atlas URL 和 244 个未克隆 URL。它不会改写 `core/workspace/`。

```powershell
node core/scripts/audit-historical-verification.mjs --out-dir docs/audits/2026-10-14/evidence/historical-verification
```

`estimatedV2` / `estimatedGrade` 是根据旧 `mismatched` 与尺寸字段重加权的排序估计，不是浏览器重测结果；只有 `scoreVersion: 2` 且当前克隆重新采集完成的记录才可作为正式 v2 证据。

在仓库根目录的 PowerShell 中运行。脚本仅读取 JSON；`legacyName` 是修复前源码的页名规则，用于检测历史冲突。

```powershell
@'
import fs from "node:fs";
import path from "node:path";
import { canonUrl, isSameOriginUrl } from "./core/src/url-canon.mjs";
import { loadProfile } from "./core/src/site-profile.mjs";

const root = "core/workspace";
const read = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const legacyName = u => {
  const p = new URL(u).pathname.replace(/\/$/, "").replace(/^\//, "")
    .replace(/[/?&#]+/g, "-").slice(0, 60);
  return p || "home";
};
const sum = { hosts: 0, atlases: 0, atlasUrls: 0, excluded: 0,
  crossOrigin: 0, eligible: 0, covered: 0, missing: 0,
  pageDirs: 0, forged: 0, scores: 0, oldVerify: 0, v2Verify: 0 };
for (const host of fs.readdirSync(root).filter(x => !x.startsWith("_"))) {
  const base = path.join(root, host);
  if (!fs.statSync(base).isDirectory()) continue;
  sum.hosts++;
  const pages = path.join(base, "pages");
  const names = fs.existsSync(pages) ? fs.readdirSync(pages)
    .filter(x => fs.statSync(path.join(pages, x)).isDirectory()) : [];
  sum.pageDirs += names.length;
  const forged = new Set();
  for (const name of names) {
    const dir = path.join(pages, name);
    if (fs.existsSync(path.join(dir, "score.json"))) sum.scores++;
    const url = canonUrl(read(path.join(dir, "manifest.json"))?.target);
    if (url && fs.existsSync(path.join(dir, "clone", "index.html"))) {
      forged.add(url); sum.forged++;
    }
  }
  const verify = path.join(base, "verify");
  if (fs.existsSync(verify)) for (const name of fs.readdirSync(verify)) {
    const result = read(path.join(verify, name, "verify.json"));
    if (result) sum[result.scoreVersion === 2 ? "v2Verify" : "oldVerify"]++;
  }
  const atlas = read(path.join(base, "recon", "atlas.json"));
  if (!atlas?.nodes) continue;
  sum.atlases++;
  const nodes = [...new Map(atlas.nodes.map(n => [canonUrl(n.url), n])
    .filter(([url]) => url)).values()];
  sum.atlasUrls += nodes.length;
  const excluded = new Set(loadProfile(host).queue.excludeTypes);
  const active = nodes.filter(n => !excluded.has(n.type));
  sum.excluded += nodes.length - active.length;
  const sameOrigin = active.filter(n => isSameOriginUrl(n.url, atlas.origin));
  sum.crossOrigin += active.length - sameOrigin.length;
  sum.eligible += sameOrigin.length;
  sum.covered += sameOrigin.filter(n => forged.has(canonUrl(n.url))).length;
  sum.missing += sameOrigin.filter(n => !forged.has(canonUrl(n.url))).length;
  const byOldName = new Map();
  for (const n of nodes) {
    const key = legacyName(n.url).toLowerCase();
    byOldName.set(key, [...(byOldName.get(key) ?? []), n.url]);
  }
  for (const [name, urls] of byOldName) if (urls.length > 1)
    console.log("OLD_COLLISION", host, name, JSON.stringify(urls));
}
console.log("TOTAL", JSON.stringify(sum));
'@ | node --input-type=module -
```

针对小样本的旧观测重加权，仍只读：

```powershell
@'
import fs from "node:fs";
for (const page of ["ideas", "jobs"]) {
  const file = `core/workspace/apify.com/verify/${page}/verify.json`;
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  const weighted = old.viewports.map(v => {
    const union = v.width * Math.max(v.sourceHeight, v.cloneHeight);
    const overlap = v.width * Math.min(v.sourceHeight, v.cloneHeight);
    const score = Math.max(0, 1 - (v.mismatched + union - overlap) / union);
    const weight = v.width === 375 || v.width === 768 ? 0.25 : 0.5;
    return { score, weight };
  });
  const derived = weighted.reduce((n, v) => n + v.score * v.weight, 0);
  console.log(page, "old", old.overall, "derived_from_old_observation", derived.toFixed(4));
}
'@ | node --input-type=module -
```

## 迁移与重算顺序

1. 冻结清单：记录每站 atlas、manifest、旧 `score.json`/`verify.json` 的路径、时间与哈希；旧 `f001` 一类任务行已有身份混写风险，不能作唯一权威。原目录保留，缺页按 URL 生成新目录，不批量重命名。
2. 将待验站点完整复制到独立 `HEIMDALL_DATA_DIR` 的 `workspace/<host>/`，校验文件数与哈希，另起端口。先用单页 `verify <host> <page> --no-interactions` 复验，再按站点分批 `--all`；`--all --max N` 的摘要会将未测页面算作未通过，因此不可把抽样退出码当质量失败。所有新 `verify.json`/`verify-summary.json` 留在隔离目录，旧产物字节不变。
3. 报告同时记录源站抓取时间、克隆生成时间、评分版本、三视口完成数和未测原因。若源站已更新，当前源站与旧克隆的差异是“跨时间差异”，需在授权条件下重锻当前克隆后才能作为当前还原质量。
4. 缺失的 query 页先在隔离区按现行 URL resolver 定向克隆并验证链接；无 manifest 残留目录仅标记、不清理。历史 atlas 只够盘点已发现 URL；要评真实全站覆盖，需重新获授权侦察并明确范围、页数上限和登录态。

本次盘点和旧观测推算不需要外部目标授权。对公网目标重新访问、抓取、重锻或验证登录态，需由项目方确认目标范围与可用账号；在此之前不能声称历史站点 v2 已跑完或端到端验收完成。
