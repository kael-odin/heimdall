/**
 * deliver — 交付包打包器：把引擎产物整理成"给前端开发改造"的自包含交付包
 *
 * 产出 deliverable/<host>-<date>/
 *   README.md              前端开发第一入口（怎么起、怎么改、边界在哪）
 *   site/                   全部镜像页 + 克隆档案 + 同步对比工具（静态可开）
 *   intel/                  跨页情报 Excel + JSON
 *   fidelity.csv            逐页还原度明细
 *   raw/<page>/             原始原材料（dom.html / cssom.css / 帧截图），改造时参考
 *
 * 用法: node src/deliver.mjs <host> [hostDir]
 */
import { writeFileSync, existsSync, readdirSync, mkdirSync, cpSync, readFileSync } from 'node:fs';
import { requireArg } from './args.mjs';
import { WORKSPACE, DELIVERABLE, localDateStamp } from './paths.mjs';
import { join, basename } from 'node:path';
import { readJson } from './fsutil.mjs';
import { buildEditManifest, renderEditManifestMd } from './deliver/edit-manifest.mjs';
import { collectCssMotion, renderMotionCss } from './crawler/motion-css.mjs';

const host = requireArg(process.argv[2], 'node src/deliver.mjs <host> [hostDir]', '站点 host');
const hostDir = process.argv[3] ?? host;
const BASE = join(WORKSPACE, hostDir);
const PAGES = join(BASE, 'pages');
const OUT = join(DELIVERABLE, `${hostDir}-${localDateStamp()}`);

if (!existsSync(PAGES)) { console.error('no pages:', PAGES); process.exit(1); }

const pages = readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'clone', 'index.html')));

// ---------- 1. site/：镜像站 + 档案 + 对比工具（整目录拷贝，剔除 raw 材料放 raw/） ----------
const siteDir = join(OUT, 'site');
mkdirSync(siteDir, { recursive: true });
for (const f of ['index.html', 'compare.html', 'intel', 'design']) {
  const src = join(BASE, f);
  if (existsSync(src)) cpSync(src, join(siteDir, f), { recursive: true });
}
if (existsSync(join(BASE, 'recon'))) cpSync(join(BASE, 'recon'), join(siteDir, 'recon'), { recursive: true });
for (const name of pages) {
  const src = join(PAGES, name);
  const dst = join(siteDir, 'pages', name);
  mkdirSync(dst, { recursive: true });
  // 镜像页 + 截图 + 评分 + 情报 进 site/；原材料进 raw/
  for (const item of ['clone', 'shot-src.png', 'shot-clone.png', 'diff.png', 'score.json', 'intel']) {
    const s = join(src, item);
    if (existsSync(s)) cpSync(s, join(dst, item), { recursive: true });
  }
  const rawDst = join(OUT, 'raw', name);
  mkdirSync(rawDst, { recursive: true });
  for (const item of ['dom.html', 'cssom.css', 'cssom-refs.json', 'frame-1.png', 'motion.json']) {
    const s = join(src, item);
    if (existsSync(s)) cpSync(s, join(rawDst, item));
  }
}

// ---------- 2. fidelity.csv ----------
const csvRows = [['page', 'total', 'grade', 'pixel', 'dom', 'data', 'refinable', 'pageType']];
let sum = 0, graded = 0;
for (const name of pages) {
  const s = readJson(join(PAGES, name, 'score.json'));
  if (!s) continue;
  sum += s.total; graded++;
  csvRows.push([
    name, s.total, s.grade,
    (s.pixel * 100).toFixed(1) + '%',
    (s.dom?.dom * 100).toFixed(1) + '%',
    s.data ? (s.data.data * 100).toFixed(1) + '%' : '-',
    s.breakdown ? Math.round(s.breakdown.refinable * 100) + '%' : '-',
    readJson(join(PAGES, name, 'intel', 'semantic.json'))?.pageType ?? '-',
  ]);
}
writeFileSync(join(OUT, 'fidelity.csv'), csvRows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
const avg = graded ? (sum / graded).toFixed(1) : '-';

// ---------- 2b. 改站起点清单 ----------
// 用户在包里的第一个真实动作是"把这些内容换成我自己的" —— 域名、图片、文案。
// 这三件事要动哪些文件，本来就散在 asset-map / intel / clone HTML 里，这里汇总成一份。
const manifest = buildEditManifest(hostDir);
writeFileSync(join(OUT, 'edit-manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(OUT, 'edit-manifest.md'), renderEditManifestMd(manifest));

// ---------- 2c. 动效档案 ----------
// 交付包对动效原本只有一句"JS 动画不逐帧复刻"—— 说了没做什么，没说**能做什么**。
// 实际上 CSS 关键帧就在已经存下来的 cssom.css 里，离线就能抽出来直接给人用；
// 而"哪些页在动、谁在驱动"决定了他要不要另外写 JS。两件事都落成文件。
const motionPages = [];
for (const name of pages) {
  const cssPath = join(PAGES, name, 'cssom.css');
  if (!existsSync(cssPath)) continue;
  const domPath = join(PAGES, name, 'dom.html');
  const motion = collectCssMotion(readFileSync(cssPath, 'utf8'), {
    dom: existsSync(domPath) ? readFileSync(domPath, 'utf8') : '',
  });
  const probe = readJson(join(PAGES, name, 'motion.json'));   // 真浏览器采的驱动分类（有才写）
  motionPages.push({ name, motion, probe });
  const rawDst = join(OUT, 'raw', name);
  if (motion.keyframes.length) {
    mkdirSync(rawDst, { recursive: true });
    writeFileSync(join(rawDst, 'motion-css.css'), renderMotionCss(motion, { host: hostDir, page: name }));
    writeFileSync(join(rawDst, 'motion-css.json'), JSON.stringify({
      stats: motion.stats, animations: motion.animations,
    }, null, 2));
  }
}
const motionTotal = motionPages.reduce((acc, p) => {
  acc.rules += p.motion.stats.rules;
  acc.looping += p.motion.stats.looping;
  acc.inline += p.motion.stats.inline;
  acc.keyframes += p.motion.stats.definedKeyframes;
  acc.unused += p.motion.stats.unusedKeyframes.length;
  if (p.motion.stats.rules) acc.pagesWithCss++;
  if (p.probe?.total) acc.pagesWithJs++;
  return acc;
}, { rules: 0, looping: 0, inline: 0, keyframes: 0, unused: 0, pagesWithCss: 0, pagesWithJs: 0 });
writeFileSync(join(OUT, 'motion.json'), JSON.stringify({
  host: hostDir, generated: localDateStamp(), totals: motionTotal,
  pages: motionPages.map(p => ({ page: p.name, css: p.motion.stats, probe: p.probe?.summary ?? null })),
}, null, 2));
const motionRows = motionPages
  .filter(p => p.motion.stats.rules || p.motion.stats.definedKeyframes)
  .sort((a, b) => b.motion.stats.rules - a.motion.stats.rules)
  .slice(0, 20)
  .map(p => `| \`${p.name}\` | ${p.motion.stats.rules} | ${p.motion.stats.looping || '—'} | ${p.motion.stats.inline || '—'} | ${p.motion.stats.definedKeyframes} | ${p.probe?.summary ?? '未采'} |`);
writeFileSync(join(OUT, 'motion.md'), `# ${hostDir} · 动效档案

> 从**已捕获的产物**离线抽出来的，没有再访问一次原站。共 ${motionTotal.keyframes} 组关键帧，
> ${motionTotal.rules} 处引用（其中 ${motionTotal.looping} 处无限循环，${motionTotal.inline} 处靠内联样式挂载），
> 涉及 ${motionTotal.pagesWithCss} 页。

## 先说清楚"动效复刻"到底做到哪一步

| 类型 | 静态镜像（\`site/pages/<page>/clone/\`） | 交互镜像（\`live\`） |
| --- | --- | --- |
| **CSS 动效**（\`@keyframes\` + \`animation\`） | ✅ **是活的** —— 镜像只剥脚本，样式表原样保留，打开就播 | ✅ 活的 |
| **CSS 过渡**（\`:hover\`、\`transition\`） | ✅ 活的 | ✅ 活的 |
| **JS 动效**（打字机 / GSAP / Framer / 轮播） | ❌ 停在捕获的那一帧 | ✅ 活的 —— 原脚本保留、URL 重指到代理 |
| **滚动揭示**（IntersectionObserver 类） | ⚠️ 定格在捕获时的状态 | ✅ 活的 |

所以这份包**不是"动效没做"**，而是：CSS 部分本来就复刻了，JS 部分在镜像里也复刻了，
静态页看不到的那部分，用交互镜像看。

## 逐页账（按引用数排序，最多列 20 行）

| 页面 | CSS 动效 | 循环 | 内联挂载 | 关键帧 | 浏览器采到的驱动 |
| --- | --- | --- | --- | --- | --- |
${motionRows.join('\n') || '| — | — | — | — | — | 未检出 CSS 动效 |'}

\`内联挂载\` 指的是关键帧不在样式表里被引用，而是靠 DOM 上的 \`style="animation:…"\` 挂上去的
（Vue / React 常见做法）。这类动效**不查内联样式就会漏判**，所以单独列一列。

## 直接拿去用

每页的 \`raw/<page>/motion-css.css\` 是**原样抽出的关键帧**，粘到自己样式表里就能用，
分两段：

- **A 段 · 在用的** —— 打开镜像就在播的，照抄即可。
- **B 段 · 定义了但捕获时没被引用的** —— 这一段往往才是重点。入场 / 滚动揭示类动效几乎都长这样：
  关键帧常驻样式表，而引用它的那条规则（\`.fadeInDown-enter-active{animation:…}\`）只在过渡的
  那几百毫秒里存在，静止采样时已经没了。**我们抓不到引用，但代码本身已经在手上。**

\`\`\`css
/* ── A · 在用的 ── */
@keyframes fade-in { 0% { opacity: 0 } 100% { opacity: 1 } }

/* ── B · 定义了但捕获时没被引用（入场 / 揭示类动效） ── */
@keyframes fadeInDown { 0% { opacity: 0; transform: translateY(-8px) } 100% { opacity: 1; transform: none } }
\`\`\`

配套的 \`motion-css.json\` 记着 A 段每条动画**是谁在什么条件下用**（选择器、时长、延迟、缓动、
是否循环），照着重写触发条件即可。完整清单见根目录 \`motion.json\`。
`);

// ---------- 3. README-改造指南 ----------
// 这份文件的目标读者是**接到包的前端**，不是产出包的人。
// 所以它必须回答三个问题：这是什么、从哪看起、怎么变成我自己的代码。
// 原文案是一份"目录说明书"——把文件列了一遍，但没给出手上的活儿怎么干。
const weak = [];
for (const name of pages) {
  const s = readJson(join(PAGES, name, 'score.json'));
  if (s && s.total < 95) weak.push({ name, total: s.total, grade: s.grade, anim: s.breakdown ? Math.round(s.breakdown.dynamicShare * 100) : 0 });
}
weak.sort((a, b) => a.total - b.total);
const weakList = weak.length
  ? weak.slice(0, 12).map(w => `| \`${w.name}\` | ${w.total} | ${w.grade} | ${w.anim}% |`).join('\n')
  : '| — | — | — | 全部 ≥95，无需特别关注 |';

const readMe = `# ${host} · 站点复刻交付包

> Heimdall 产出 · ${localDateStamp()} · ${pages.length} 页 · 平均还原度 ${avg}%

## 一句话

原站公开页面的**高保真静态复刻**：HTML / CSS / 图片 / 字体都是原站的真实文件，
不是照着截图重画的。附还原度评分、竞品情报，以及原站↔镜像的同步对比工具。

**这不是可以直接上线的代码**，是一份**可对齐、可核对、可拆解**的改造素材。
下面三节按"你想拿它做什么"分开写。

## 30 秒上手

\`\`\`bash
cd site && npx serve .        # 起静态服务（双击 index.html 也能看，但起服务更完整）
\`\`\`

打开后看到的是**克隆档案卡片墙**：每页一张卡，带还原度分与页面类型。
点卡片进镜像页，点卡片上的「⇔ 同步对比」进左右对照工具。

## 要换成自己的站？从 \`edit-manifest.md\` 开始

包里那份 [edit-manifest.md](edit-manifest.md) 就是为这件事准备的 —— 它把
"换域名 / 换图片 / 换文案"各要动哪些文件列成了三张表（同名 \`.json\` 是机器可读版）：

- **换域名**：原站域名出现在 ${manifest.counts.domainFiles} 个文件里（${manifest.counts.domainTotal} 处），
  多数是 canonical / og:url / 绝对资源链接。用 Heimdall 控制台的「改站起点 → 预览/替换」
  可以一并换掉（预览不改文件，替换前逐文件备份）
- **换图片 / 图标 / 字体**：${manifest.counts.assets} 个资源，按"被多少页用到"排序
  ${manifest.counts.remoteVisual > 0 ? `；其中 **${manifest.counts.remoteVisual} 个视觉资产仍是外链**，那几个必须处理` : '（没有仍是外链的视觉资产）'}
  ${manifest.gapCoverage?.truncated ? `\n  ⚠ 这张表**只覆盖 ${manifest.gapCoverage.scanned} / ${manifest.gapCoverage.cloned} 页**（资产扫描有 --max 上限，默认 60 页）。\n  剩下的页里可能还有外链视觉资产没被列出来 —— 要完整名单就重跑：\`node core/src/audit/assets.mjs ${manifest.host} --max ${manifest.gapCoverage.cloned}\`` : ''}
- **换文案**：${manifest.counts.copyPages} 页的标题 / H1 / CTA / 价格

**换完之后**，这些产物是"原站的快照"这一点不会改变 —— 要商用请自行确认授权。

## 三种用法

### ① 我要抄视觉（做自己的设计系统）

不要对着截图量尺寸。原站**全部生效 CSS**（含变量、设计 token）就在：

\`\`\`
raw/<page>/cssom.css       原站 CSSOM 的最终计算态 —— 变量的值已经解开
\`\`\`

"最终计算态"是关键：原站的 styled-components / CSS Modules 在运行时注入样式，
直接看源码里的 CSS 文件往往只有一堆哈希类名。\`cssom.css\` 是浏览器把一切都算完之后的样子。

另外还有一份归纳好的设计令牌（色板 / 字阶 / 间距 / 圆角 / 阴影）：

\`\`\`
site/design/tokens.html    可视化色板与字阶（有的话）
\`\`\`

### ② 我要抄结构（复用页面骨架）

\`\`\`
raw/<page>/dom.html        渲染后的完整 DOM（含原站类名体系）
site/pages/<page>/clone/   可直接打开的镜像页 —— 拿它当"活的线框图"
\`\`\`

镜像页是纯静态的（无构建、无依赖），可以直接编辑试改。
但注意原站类名多半是哈希（\`sc-a54b2c-0\`、\`_abc123\`），
**长期改造建议以镜像为视觉基准重建组件**，而不是在哈希类上堆样式 ——
后者会在你换掉原站样式表的那一刻全部失效。

### ③ 我要读竞品（理解它为什么这么做）

\`\`\`
intel/${hostDir}-intel.xlsx              跨页汇总：概览 / 语义情报 / 定价与 CTA
site/pages/<page>/intel/semantic.json    单页：页面类型 / 价值主张 / 套餐结构 / 官方宣称
\`\`\`

## 推荐流程：从这份包到你能上线的代码

1. **先看 \`fidelity.csv\`**，按 total 排序，找出还原度最低的几页 —— 那些是需要你手工确认的地方
2. **对每一页**：打开同步对比，逐个 section 看。视觉对齐的地方可以直接照搬结构，
   对不齐的地方看该页的 \`diff.png\`（差异热图）定位到具体区域
3. **抽设计令牌**：从 \`raw/<page>/cssom.css\` 里提取你的项目要用的那一小撮变量
   （颜色、字号、间距、圆角），不要整份搬
4. **重建组件**：用你自己的技术栈重写，以镜像页为视觉基准逐屏比对
5. **回灌校验**：改完之后把你的页面和镜像页并排 —— 这就是那份同步对比工具的用法

## 需要优先手工确认的页面

还原度 <95 的页（按差距从大到小）。\`动效占比\` 是这一页里"无法静态复刻"的部分有多大 ——
它高不代表做得差，而是说明这页有较多动画，需要你另外处理。

| 页面 | 还原度 | 评级 | 动效占比 |
| --- | --- | --- | --- |
${weakList}

## 还原度怎么读

\`\`\`
total = 0.5 × 像素（多帧最优匹配，动画噪声已排除）
      + 0.3 × DOM 结构相似度
      + 0.2 × 数据字段覆盖率（标题/价格/CTA/链接/表格）
\`\`\`

评级 A ≥95 / B ≥85 / C <85。逐页明细见 \`fidelity.csv\` 与各页 \`score.json\`。

**像素分是唯一可对外核验的口径**，结构分与数据分是与捕获 DOM 的同源比对（自证辅助项），
不构成独立证据。这一点在 \`score.json\` 的 \`dataNote\` 里也写着。

## 目录速查

\`\`\`
site/
  index.html                  克隆档案卡片墙（入口）
  compare.html                原站快照 ↔ 镜像，同屏同步滚动
  pages/<page>/clone/         镜像页（纯静态、可直接开）
  pages/<page>/score.json     该页还原度三维明细
  pages/<page>/diff.png       原站 vs 镜像差异热图
  pages/<page>/intel/         该页结构化抽取 + 语义情报
  recon/atlas.json            全站路由结构（哪些页面、怎么互链）
intel/                        跨页情报 Excel
edit-manifest.md              改站起点：换域名 / 图片 / 文案各要动什么
edit-manifest.json            同上，机器可读
motion.md                     动效档案：哪些页在动、CSS 还是 JS、怎么复用
motion.json                   同上，机器可读（逐页动效账）
fidelity.csv                  逐页还原度明细
raw/<page>/                   原始材料：dom.html / cssom.css / 帧截图
raw/<page>/motion-css.css     该页原样抽出的 @keyframes，可直接粘进自己的样式表
README.md                     本文件
\`\`\`

## 诚实边界

- **静态复刻**：无登录、无后端交互、无搜索。表单能看出结构但不会真的提交。
- **动效**：分三层，别一概而论 —— 见 [motion.md](motion.md)。
  **CSS 动画与过渡在镜像里是活的**（只剥脚本，样式表原样保留）；
  **JS 动效（打字机 / 轮播 / GSAP）在交互镜像里是活的**（原脚本保留、URL 重指到代理）；
  只有**静态页**看不到 JS 动效，它停在被捕获的那一帧。
  每页可复用的关键帧已抽成 \`raw/<page>/motion-css.css\`。
  \`canvas\` 绘制的内容**已光栅化为静态图**（保留尺寸与位置），同样是某一帧的快照。
  每页 \`score.json\` 的 \`breakdown.dynamicShare\` 是这个缺口的量化。
- **跨页链接**：已克隆页之间互相跳转；未克隆的链接会新标签打开原站。
- **公开页面**：登录后区域不在范围内。
- 原站改版后这份包就过期了 —— 重新跑一次会生成带新日期的包，旧的可以删
  （\`heimdall deliver-prune\` 有保留策略）。

## 这份包怎么产生的

\`\`\`bash
cd core
node src/cli.mjs recon ${host} 60        # 1. 侦察全站，得到路由图
node src/cli.mjs queue ${host}           # 2. 批量克隆（断点续跑）
node src/cli.mjs deliver ${host}         # 3. 打包成本目录
\`\`\`

同一条命令跑两次结果一致，可以直接 diff 两个日期的包看站点改了什么。
`;
writeFileSync(join(OUT, 'README.md'), readMe);

// ---------- 4. xlsx 也拷进来（若已在 site/intel 则无需重复） ----------
console.log(`\nDELIVERABLE -> ${OUT}`);
console.log(`  pages: ${pages.length}, avg fidelity: ${avg}%`);
console.log(`  site/ + intel/ + fidelity.csv + raw/ + README.md + edit-manifest.md`);
