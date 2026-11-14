/**
 * deliver — 交付包打包器：把引擎产物整理成"给前端开发改造"的自包含交付包
 *
 * 产出 deliverable/<host>-<date>/
 *   README.md              前端开发第一入口（怎么起、怎么改、边界在哪）
 *   site/                   全部镜像页 + 克隆档案 + 同步对比工具（静态可开）
 *   intel/                  跨页情报 Excel + JSON
 *   fidelity.csv            逐页历史辅助评分明细
 *   raw/<page>/             原始原材料（dom.html / cssom.css / 帧截图），改造时参考
 *
 * 用法: node src/deliver.mjs <host> [hostDir]
 */
import { writeFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, cpSync, readFileSync, lstatSync } from 'node:fs';
import { requireArg } from './args.mjs';
import { WORKSPACE, DELIVERABLE, localDateStamp } from './paths.mjs';
import { join, basename } from 'node:path';
import { readJson } from './fsutil.mjs';
import { buildEditManifest, renderEditManifestMd } from './deliver/edit-manifest.mjs';
import { collectCssMotion, renderMotionCss } from './crawler/motion-css.mjs';
import { availableCloneVariantWidths } from './clone-doc.mjs';
import { isStaticCloneChooserHtml, sanitizeStaticHtml, staticCloneChooserHtml } from './static-html-safety.mjs';
import { assertExportTarget, promoteCandidate } from './live/export-path.mjs';

const host = requireArg(process.argv[2], 'node src/deliver.mjs <host> [hostDir]', '站点 host');
const hostDir = process.argv[3] ?? host;
const safeHost = value => /^[a-z0-9.-]+$/i.test(value) && value !== '.' && value !== '..';
if (!safeHost(host) || !safeHost(hostDir)) {
  console.error('host and hostDir must be single safe directory names');
  process.exit(2);
}
const BASE = join(WORKSPACE, hostDir);
const PAGES = join(BASE, 'pages');
const FINAL_OUT = join(DELIVERABLE, `${hostDir}-${localDateStamp()}`);

if (!existsSync(PAGES)) { console.error('no pages:', PAGES); process.exit(1); }

const pages = readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'clone', 'index.html')));
if (!pages.length) { console.error('no clone pages:', PAGES); process.exit(1); }
mkdirSync(DELIVERABLE, { recursive: true });
assertExportTarget(DELIVERABLE, FINAL_OUT);
const OUT = mkdtempSync(join(DELIVERABLE, `.candidate-${hostDir}-`));
console.log('[deliver] candidate ->', OUT);

function copySafe(src, dst) {
  cpSync(src, dst, { recursive: true, filter: path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error('refusing to package symlink or special file: ' + path);
    }
    return true;
  } });
}

function sanitizeCloneTree(cloneDir) {
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) { visit(file); continue; }
      if (!stat.isFile()) throw new Error('unexpected clone entry: ' + file);
      if (!/\.html?$/i.test(name)) continue;
      const original = readFileSync(file, 'utf8');
      if (file === join(cloneDir, 'index.html') && isStaticCloneChooserHtml(original)) {
        const widths = availableCloneVariantWidths(cloneDir);
        if (!widths.length) throw new Error('viewport chooser has no available variant: ' + cloneDir);
        writeFileSync(file, staticCloneChooserHtml(widths));
      } else writeFileSync(file, sanitizeStaticHtml(original));
    }
  };
  visit(cloneDir);
}

function validateCandidate() {
  for (const name of ['README.md', 'fidelity.csv', 'edit-manifest.json']) {
    if (!lstatSync(join(OUT, name)).isFile()) throw new Error('candidate missing ' + name);
  }
  for (const name of pages) {
    const cloneDir = join(OUT, 'site', 'pages', name, 'clone');
    const entry = join(cloneDir, 'index.html');
    if (!lstatSync(entry).isFile()) throw new Error('candidate missing clone entry: ' + name);
    const html = readFileSync(entry, 'utf8');
    if (isStaticCloneChooserHtml(html) && !availableCloneVariantWidths(cloneDir).length) {
      throw new Error('candidate chooser has no available variant: ' + name);
    }
  }
}

// ---------- 1. site/：镜像站 + 档案 + 对比工具（整目录拷贝，剔除 raw 材料放 raw/） ----------
const siteDir = join(OUT, 'site');
mkdirSync(siteDir, { recursive: true });
for (const f of ['index.html', 'compare.html', 'intel', 'design']) {
  const src = join(BASE, f);
  if (existsSync(src)) copySafe(src, join(siteDir, f));
}
if (existsSync(join(BASE, 'recon'))) copySafe(join(BASE, 'recon'), join(siteDir, 'recon'));
for (const name of pages) {
  const src = join(PAGES, name);
  const dst = join(siteDir, 'pages', name);
  mkdirSync(dst, { recursive: true });
  // 镜像页 + 截图 + 评分 + 情报 进 site/；原材料进 raw/
  for (const item of ['clone', 'shot-src.png', 'shot-clone.png', 'diff.png', 'score.json', 'intel']) {
    const s = join(src, item);
    if (existsSync(s)) copySafe(s, join(dst, item));
  }
  sanitizeCloneTree(join(dst, 'clone'));
  const rawDst = join(OUT, 'raw', name);
  mkdirSync(rawDst, { recursive: true });
  for (const item of ['dom.html', 'cssom.css', 'cssom-refs.json', 'frame-1.png', 'motion.json']) {
    const s = join(src, item);
    if (existsSync(s)) copySafe(s, join(rawDst, item));
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
    s.scoreFormulaVersion !== 2 ? '未重算' : Number.isFinite(s.data?.data) ? (s.data.data * 100).toFixed(1) + '%' : '未测',
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
| **揭示 / 登场类**（滚动揭示、Framer 登场） | ✅ **已改写回 CSS**（\`clone/motion-replay.css\`，\`view()\` 滚动时间线，纯 CSS 无脚本） | ✅ 活的（原脚本） |
| **脚本创建的动画**（\`Element.animate()\` —— 一部分打字机 / 轮播 / 入场） | ✅ **已改写回 CSS** —— 关键帧是捕获时从 \`Element.animate()\` 记下来的，原样重写 | ✅ 活的（原脚本） |
| **走行内样式 / setInterval 的 JS 动效**（Swiper 类轮播、手写打字机、GSAP 时间线） | ❌ 停在捕获的那一帧 | ✅ 活的 —— 原脚本保留、URL 重指到代理 |

所以这份包**不是"动效没做"**：能靠静态证据确定的（CSS 关键帧、揭示类、\`Element.animate()\`
的关键帧）在静态镜像里就复刻了；**只在运行时才存在的那一类**（每帧长什么样没有任何静态证据）
用交互镜像看。分辨一条动效属于哪一类，看每页的 \`motion.json\` —— 它记的是"谁在驱动"。

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
  if (s && s.total < 95) weak.push({
    name, total: s.total, grade: s.grade,
    anim: Number.isFinite(s.breakdown?.dynamicShare) ? Math.round(s.breakdown.dynamicShare * 100) + '%' : '-',
  });
}
weak.sort((a, b) => a.total - b.total);
const weakList = weak.length
  ? weak.slice(0, 12).map(w => `| \`${w.name}\` | ${w.total} | ${w.grade} | ${w.anim} |`).join('\n')
  : graded ? '| — | — | — | 旧评分均 ≥95，仍需多视口与人工复核 |'
    : '| — | — | — | 本包没有旧评分，需逐页复核 |';
const hasSiteIndex = existsSync(join(siteDir, 'index.html'));
const siteEntry = hasSiteIndex ? 'index.html' : 'pages/' + pages[0] + '/clone/index.html';
const siteStartNote = hasSiteIndex
  ? '站点汇总页列出已打包页面。逐页打开镜像和差异证据，核对覆盖情况。'
  : '当前包没有站点汇总页；从该镜像页开始，其他页面在 `site/pages/<page>/clone/`。';

const readMe = `# ${host} · 站点复刻交付包

> Heimdall 产出 · ${localDateStamp()} · ${pages.length} 页 · 旧口径平均分 ${avg}%

## 一句话

仅供**自有或获授权站点**的页面接手验收：汇集已捕获的 HTML、CSS、图片和字体，
并附旧口径辅助评分、结构化资料和源站↔快照的同步对比工具。

**这不是可以直接上线的代码**，是一份待核对的改造素材。
部分文件取决于本次捕获结果，以包内实际内容为准。

## 30 秒上手

\`\`\`bash
cd site && npx serve .
\`\`\`

启动后打开 \`/${siteEntry}\`。${siteStartNote}

## 迁移到自己的代码库：从 \`edit-manifest.md\` 开始

包里那份 [edit-manifest.md](edit-manifest.md) 就是为这件事准备的 —— 它把
"换域名 / 换图片 / 换文案"各要动哪些文件列成了三张表（同名 \`.json\` 是机器可读版）：

- **换域名**：清单在 ${manifest.counts.domainFiles} 个文件里检出 ${manifest.counts.domainTotal} 处。
  另请检查 canonical、og:url、绝对资源链接及运行时生成的地址；控制台提供预览/替换。
- **换图片 / 图标 / 字体**：${manifest.counts.assets} 个资源，按"被多少页用到"排序
  ${manifest.counts.remoteVisual > 0 ? `；其中 **${manifest.counts.remoteVisual} 个视觉资产仍是外链**，需逐项核对` : '（已扫描范围未检出外链视觉资产）'}
  ${manifest.gapCoverage?.truncated ? `\n  ⚠ 这张表**只覆盖 ${manifest.gapCoverage.scanned} / ${manifest.gapCoverage.cloned} 页**（资产扫描有 --max 上限，默认 60 页）。\n  剩下的页里可能还有外链视觉资产没被列出来 —— 要完整名单就重跑：\`node core/src/audit/assets.mjs ${manifest.host} --max ${manifest.gapCoverage.cloned}\`` : ''}
- **换文案**：${manifest.counts.copyPages} 页的标题 / H1 / CTA / 价格

这些产物仍包含捕获时的站点内容，截图和原始材料可能包含个人信息或凭据。
\`raw/<page>/dom.html\` 保留捕获到的原始内容，可能含脚本，不能当作安全页面直接打开或公开。
迁移和交付前应逐项核对授权范围、资源来源、截图与个人信息。

## 三类接手材料

### ① 检查视觉与样式

\`cssom.css\` 保存了捕获时提取的样式证据，可用于核对变量、布局和字体：

\`\`\`
raw/<page>/cssom.css       捕获时提取的 CSSOM 样式（若已采集）
\`\`\`

运行时注入的规则也可能被收录，但样式结果仍受视口、状态和浏览器环境影响；
不要把此文件视为每个元素的完整计算样式。

另外还有一份归纳好的设计令牌（色板 / 字阶 / 间距 / 圆角 / 阴影）：

\`\`\`
site/design/tokens.html    可视化色板与字阶（有的话）
\`\`\`

### ② 检查页面结构

\`\`\`
raw/<page>/dom.html        渲染后的完整 DOM（含原站类名体系）
site/pages/<page>/clone/   可直接打开的静态镜像页
\`\`\`

镜像页是静态 HTML，可以直接编辑试改；仍需检查未打包的外链资源。
但注意原站类名多半是哈希（\`sc-a54b2c-0\`、\`_abc123\`），
**长期改造建议以镜像为视觉基准重建组件**，而不是在哈希类上堆样式 ——
后者会在你换掉原站样式表的那一刻全部失效。

### ③ 查看站点资料

\`\`\`
intel/${hostDir}-intel.xlsx              跨页汇总（若已生成）
site/pages/<page>/intel/semantic.json    单页结构化资料（若已生成）
\`\`\`

## 推荐流程：从这份包到你能上线的代码

1. **先看 \`fidelity.csv\`**，按旧口径 total 排序，优先人工核对分数较低的页面
2. **对每一页**：核对镜像与源站证据。有 \`compare.html\` 时做同步对比，
   有 \`diff.png\` 时用差异热图定位未对齐的区域
3. **抽设计令牌**：从 \`raw/<page>/cssom.css\` 里提取你的项目要用的那一小撮变量
   （颜色、字号、间距、圆角），不要整份搬
4. **重建组件**：用你自己的技术栈重写，以镜像页为视觉基准逐屏比对
5. **回灌校验**：改完之后把你的页面和镜像页并排 —— 这就是那份同步对比工具的用法

## 需要优先手工确认的页面

以下是旧口径 total <95 的页（按分数排序）。\`动效占比\` 提示静态快照可能遗漏的运行态，
不能替代真实浏览器里的多视口及交互验收。

| 页面 | 旧口径分 | 旧等级 | 动效占比 |
| --- | --- | --- | --- |
${weakList}

## 历史评分怎么读

\`\`\`
total = 0.5 × 像素（取最接近的采样帧，动态区域仍计入）
      + 0.3 × DOM 结构相似度
      + 0.2 × 数据字段覆盖率（标题/价格/CTA/链接/表格；无可抽取字段时不计入，前两项归一）
\`\`\`

以上是 \`score.json\` 的历史辅助口径；A ≥95 / B ≥85 / C <85 也是这一旧口径的等级。
逐页数据见 \`fidelity.csv\` 与 \`score.json\`，不能据此判定多视口或交互已经通过。

交付前还需运行 v2 多视口验证，并核对每页是否完整测量、最差视口和差异证据；
结构分与数据分来自同源捕获，只能作为定位线索，不能单独证明还原效果。

## 目录速查

\`\`\`
site/
  index.html                  站点汇总页（若已生成）
  compare.html                同屏对比工具（若已生成）
  pages/<page>/clone/         镜像页（纯静态、可直接开）
  pages/<page>/score.json     该页历史辅助评分明细
  pages/<page>/diff.png       差异热图（若已生成）
  pages/<page>/intel/         该页结构化资料（若已生成）
  recon/atlas.json            路由结构（若已生成）
intel/                        跨页资料（若已生成）
edit-manifest.md              改站起点：换域名 / 图片 / 文案各要动什么
edit-manifest.json            同上，机器可读
motion.md                     动效档案：哪些页在动、CSS 还是 JS、怎么复用
motion.json                   同上，机器可读（逐页动效账）
fidelity.csv                  逐页历史辅助评分明细
raw/<page>/                   捕获时的原始材料（内容因页而异）
raw/<page>/motion-css.css     提取的 @keyframes（若已生成，需检查依赖）
README.md                     本文件
\`\`\`

## 诚实边界

- **静态复刻**：无登录、无后端交互、无搜索。新构建或重新导出的静态镜像保留表单元素，但禁用表单与通过 \`form\` 关联的控件；表单属性和可访问性变化可能影响外观，须逐页检查。旧的工作区文件与已交付包不会自动更新。
- **网络边界**：禁用表单不是断网沙箱；链接、图片、样式、字体和嵌入内容仍可能访问外部地址，分享前须另行检查。
- **动效**：保留的 CSS 动画与过渡可能运行；依赖脚本、运行时状态或远程资源的动效需逐页检查。
  若生成了 \`motion-replay.css\`，它重演的是捕获到的形态，不保证原脚本行为一致。
  \`motion.md\`、\`motion.json\` 和 \`score.json\` 的 \`breakdown.dynamicShare\`（若存在）
  只能帮助定位待验区域，不能替代浏览器交互验收。\`canvas\` 快照也只代表捕获时的一帧。
- **跨页链接**：检查已克隆页之间的导航，也要检查指向未捕获页面和原站的链接。
- **授权范围**：仅处理自有或明确获授权站点；登录后区域需另行取得授权并单独验收。
- 源站内容、浏览器环境和抓取时机都会影响结果；同日重跑会保留上一个正式包为
  \`.backup-*\`。旧包先盘点用途和证据，再隔离归档，不直接删除。

## 这份包怎么产生的

\`\`\`bash
cd core
node src/cli.mjs recon ${host} 60        # 1. 侦察全站，得到路由图
node src/cli.mjs queue ${host}           # 2. 批量克隆（断点续跑）
node src/cli.mjs deliver ${host}         # 3. 打包成本目录
\`\`\`

重跑结果可能因源站或环境变化而不同。比较包时同时核对抓取时间、验证版本和缺口清单。
`;
writeFileSync(join(OUT, 'README.md'), readMe);

// ---------- 4. xlsx 也拷进来（若已在 site/intel 则无需重复） ----------
validateCandidate();
const committed = promoteCandidate(DELIVERABLE, FINAL_OUT, OUT);
console.log(`\nDELIVERABLE -> ${committed.out}`);
if (committed.backup) console.log(`[deliver] previous bundle retained -> ${committed.backup}`);
console.log(`  pages: ${pages.length}, avg historical fidelity: ${avg}%`);
console.log(`  site/ + intel/ + fidelity.csv + raw/ + README.md + edit-manifest.md`);
