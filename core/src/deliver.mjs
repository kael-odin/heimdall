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
import { writeFileSync, existsSync, readdirSync, mkdirSync, cpSync } from 'node:fs';
import { requireArg } from './args.mjs';
import { WORKSPACE, DELIVERABLE, localDateStamp } from './paths.mjs';
import { join, basename } from 'node:path';
import { readJson } from './fsutil.mjs';

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
  for (const item of ['dom.html', 'cssom.css', 'cssom-refs.json', 'frame-1.png']) {
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
fidelity.csv                  逐页还原度明细
raw/<page>/                   原始材料：dom.html / cssom.css / 帧截图
README.md                     本文件
\`\`\`

## 诚实边界

- **静态复刻**：无登录、无后端交互、无搜索。表单能看出结构但不会真的提交。
- **动效**：JS 驱动的动画（打字机、自动轮播、滚动触发）不逐帧复刻。
  \`canvas\` 绘制的内容**已光栅化为静态图**（保留尺寸与位置），但它是某一帧的快照，
  不是活的。每页 \`score.json\` 的 \`breakdown.dynamicShare\` 是这个缺口的量化。
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
console.log(`  site/ + intel/ + fidelity.csv + raw/ + README.md`);
