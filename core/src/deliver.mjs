/**
 * deliver — 交付包打包器：把引擎产物整理成"给前端开发改造"的自包含交付包
 *
 * 产出 deliverable/<host>-<date>/
 *   README-改造指南.md      前端开发第一入口（怎么起、怎么改、边界在哪）
 *   site/                   全部镜像页 + 克隆档案 + 同步对比工具（静态可开）
 *   intel/                  跨页情报 Excel + JSON
 *   fidelity.csv            逐页还原度明细
 *   raw/<page>/             原始原材料（dom.html / cssom.css / 帧截图），改造时参考
 *
 * 用法: node src/deliver.mjs <host> [hostDir]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, cpSync } from 'node:fs';
import { requireArg } from './args.mjs';
import { WORKSPACE, DELIVERABLE } from './paths.mjs';
import { join, basename } from 'node:path';

const host = requireArg(process.argv[2], 'node src/deliver.mjs <host> [hostDir]', '站点 host');
const hostDir = process.argv[3] ?? host;
const BASE = join(WORKSPACE, hostDir);
const PAGES = join(BASE, 'pages');
const OUT = join(DELIVERABLE, `${hostDir}-${new Date().toISOString().slice(0, 10)}`);

if (!existsSync(PAGES)) { console.error('no pages:', PAGES); process.exit(1); }

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const pages = readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'clone', 'index.html')));

// ---------- 1. site/：镜像站 + 档案 + 对比工具（整目录拷贝，剔除 raw 材料放 raw/） ----------
const siteDir = join(OUT, 'site');
mkdirSync(siteDir, { recursive: true });
for (const f of ['index.html', 'compare.html', `intel`]) {
  const src = join(BASE, f === 'intel' ? 'intel' : f);
  if (existsSync(src)) cpSync(src, join(siteDir, f === 'intel' ? 'intel' : f), { recursive: true });
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
const readMe = `# ${host} 竞品复刻交付包

> Heimdall 站点复刻引擎产出 · ${new Date().toISOString().slice(0, 10)} · ${pages.length} 页 · 平均还原度 ${avg}%

## 这是什么

竞品站点 ${host} 的**完整静态复刻**：原站公开页面的视觉与结构 1:1 搬运（HTML/CSS/图片/字体），
附带还原度评分、竞品语义情报、以及原站↔镜像同步对比工具。

**定位：给前端开发的高保真改造素材**——不是可直接上线的代码，而是：
1. **像素级视觉参考**：镜像页与原站逐像素可对齐（还原度明细见 fidelity.csv）
2. **可交互原型**：每页可直接在浏览器打开浏览
3. **情报底稿**：定价、套餐结构、价值主张、CTA 全部结构化

## 快速浏览

1. 打开 \`site/index.html\` —— 克隆档案卡片墙（每页还原度/语义标签）
2. 点任意卡片 —— 打开该页活体镜像
3. 卡片上「⇔ 同步对比」—— 原站快照 vs 镜像 同屏同步滚动
4. \`intel/${hostDir}-intel.xlsx\` —— 情报包（概览/语义情报/定价与CTA）

## 本地起服务（推荐）

镜像页资源全部相对路径，双击 index.html 也能开；起静态服务体验更完整：

\`\`\`
cd site
npx serve .          # 或 python -m http.server 8080
\`\`\`

## 目录结构

\`\`\`
site/
  index.html            克隆档案入口（卡片墙）
  compare.html          同步滚动对比工具
  pages/<page>/clone/   活体镜像页（独立可开）
  pages/<page>/score.json   该页还原度（像素/结构/数据三维）
  pages/<page>/intel/   该页结构化抽取 + LLM 语义情报
  pages/<page>/diff.png 原站 vs 镜像差异热图
  recon/atlas.json      全站路由结构（节点/边/类型）
intel/                  跨页情报 Excel
fidelity.csv            逐页还原度明细
raw/<page>/             原始捕获材料（渲染后 DOM、CSSOM 全量、帧截图）——改造时的原子参考
\`\`\`

## 改造建议路径

- **要视觉规范**：直接读 \`raw/<page>/cssom.css\`——那是原站全部生效 CSS（含设计 token / 变量），比截图量尺寸快得多
- **要页面结构**：\`raw/<page>/dom.html\` 是渲染后完整 DOM（含原站类名体系）
- **要竞品理解**：\`site/pages/<page>/intel/semantic.json\`（页面类型/价值主张/套餐结构/官方宣称）
- **改镜像页**：镜像 DOM 可直接编辑（纯静态、无构建）；但注意原站类名多为 styled-components 哈希（如 \`sc-a54b2c-0\`），长期改造建议以镜像为视觉基准重建组件，而不是在哈希类上堆样式

## 已知边界（诚实清单）

- 静态复刻：无登录、无后端交互、无搜索；JS 驱动的动效（打字机/轮播自动播放/滚动触发）未复刻
  ——每页 \`score.json\` 的 \`breakdown.dynamicShare\` 标出了动画噪声占比，即是动效缺失的量化
- 未克隆的站内链接会新标签打开原站（linker 已全量接线已克隆页的互相跳转）
- 仅覆盖公开页面；登录后区域不在范围内

## 还原度口径

total = 0.5×像素（多帧最优匹配，动画噪声已排除） + 0.3×DOM结构 + 0.2×数据字段覆盖
评级 A ≥95 / B ≥85 / C <85。逐页明细见 fidelity.csv 与各页 score.json。
`;
writeFileSync(join(OUT, 'README-改造指南.md'), readMe);

// ---------- 4. xlsx 也拷进来（若已在 site/intel 则无需重复） ----------
console.log(`\nDELIVERABLE -> ${OUT}`);
console.log(`  pages: ${pages.length}, avg fidelity: ${avg}%`);
console.log(`  site/ + intel/ + fidelity.csv + raw/ + README-改造指南.md`);
