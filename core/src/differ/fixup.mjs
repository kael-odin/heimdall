/**
 * fixup — L3 视觉修复循环（AI 看图改 CSS，自我校准）
 *
 * 每轮：三图喂 LLM（原站/克隆/diff 热图）+ 克隆页类名清单 → CSS 补丁 →
 *       写 clone/styles/fixes.css → 重截图 → 重 diff → 分数提升保留、下降回滚。
 * 全程事件化：{kind:'fixup-round', round, before, after, kept}
 *
 * 产物：fixup-history.json（轮次分数曲线）；score.json 更新为最佳轮。
 *
 * 用法: node src/differ/fixup.mjs <pageDir> [maxRounds=2] [clonePort=8961]
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { llmEnabled, llmVision } from '../llm.mjs';
import { probeStyleDiff } from './style-probe.mjs';
import { getEnv } from '../env.mjs';
import { parse } from 'parse5';
import { WORKSPACE } from '../paths.mjs';

const ENV = getEnv();
const MIN_STATIC = Number(ENV.FIXUP_MIN_STATIC ?? 0.002);      // 静态差异像素占视口比低于此 = 没有可修内容
const MIN_REFINABLE = Number(ENV.FIXUP_MIN_REFINABLE ?? 0.3);  // 静态差异占全部差异比低于此 = 主要是动画噪声

const DIR = process.argv[2] ?? join(WORKSPACE, 'apify.com', 'pages', 'home');
const MAX_ROUNDS = Number(process.argv[3] ?? 2);
const CLONE_PORT = Number(process.argv[4] ?? process.env.HEIMDALL_PORT ?? 8900);
const CLONE_HTML = join(DIR, 'clone', 'index.html');
// clone 页由 engine-server 常驻静态服务提供（/static/<workspace 相对路径>）
// 兼容绝对/相对 DIR：CLONE_REL 始终相对 workspace（HEIMDALL_DATA_DIR 迁移后 DIR 变为绝对路径）
const CLONE_REL = relative(WORKSPACE, resolve(DIR)).split(sep).join('/');
const CLONE_URL = `http://127.0.0.1:${CLONE_PORT}/static/${CLONE_REL}/clone/index.html`;
const FIXES_CSS = join(DIR, 'clone', 'styles', 'fixes.css');
const FIXES_LINK = '<link rel="stylesheet" href="styles/fixes.css">';
// 基线备份：回滚时直接还原截图/分数/热图，避免"清补丁→重截"过程中再遇渲染/缓存异常
const BASE_SHOT = join(DIR, 'shot-clone.png');
const BASE_SHOT_BAK = join(DIR, 'shot-clone.base.png');
const BASE_SCORE_BAK = join(DIR, 'score.base.json');
const BASE_DIFF_BAK = join(DIR, 'diff.base.png');

const emit = (obj) => process.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
const log = (...a) => console.error(...a);

const readScore = () => {
  const s = JSON.parse(readFileSync(join(DIR, 'score.json'), 'utf8'));
  const [w, h] = (s.viewport ?? '0x0').split('x').map(Number);
  return { total: s.total, pixel: +(s.pixel * 100).toFixed(1), score: s, viewportPx: w * h };
};

const run = (script, args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join('src', script), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', c => c === 0 ? resolve() : reject(new Error(`${script} exited ${c}`)));
  p.on('error', reject);
});

/** 克隆页类名清单（供 LLM 选择器参考） */
function classInventory() {
  const html = readFileSync(CLONE_HTML, 'utf8');
  const tokens = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) for (const t of m[1].split(/\s+/)) if (t) tokens.add(t);
  return [...tokens].slice(0, 100).join(', ');
}

function injectFixLink() {
  let html = readFileSync(CLONE_HTML, 'utf8');
  if (!html.includes('styles/fixes.css')) html = html.replace('</head>', FIXES_LINK + '</head>');
  writeFileSync(CLONE_HTML, html);
}

async function main() {
  if (!llmEnabled()) { log('[fixup] LLM disabled (.env / HEIMDALL_LLM!=1) — skip'); return; }
  if (!existsSync(CLONE_HTML) || !existsSync(join(DIR, 'shot-clone.png'))) { log('[fixup] missing clone artifacts — skip'); return; }

  // 可修性门控（替代废弃的 pixel 单维门控）：静态差异太少 = 分数损失主要是动画噪声，AI 改 CSS 救不了
  const sc0 = readScore();
  const b0 = sc0.score.breakdown ?? {};
  const staticShare = sc0.viewportPx ? (b0.staticPx ?? 0) / sc0.viewportPx : 1;
  const refinable0 = b0.refinable ?? 1;
  if (staticShare < MIN_STATIC || refinable0 < MIN_REFINABLE) {
    log(`[fixup] skip: static ${(staticShare * 100).toFixed(2)}% of viewport (min ${(MIN_STATIC * 100).toFixed(2)}%), refinable ${(refinable0 * 100).toFixed(0)}% (min ${(MIN_REFINABLE * 100).toFixed(0)}%) — remaining diff is animation noise`);
    emit({ kind: 'fixup-skip', reason: 'noise', staticShare, refinable: refinable0 });
    return;
  }
  log(`[fixup] refinable ${(refinable0 * 100).toFixed(0)}% (static ${b0.staticPx}px) — worth calibrating`);

  const history = [];
  let best = readScore();
  let bestCss = '';
  const inventory = classInventory();
  // 保存基线（初始最佳状态）
  try {
    copyFileSync(BASE_SHOT, BASE_SHOT_BAK);
    copyFileSync(join(DIR, 'score.json'), BASE_SCORE_BAK);
    if (existsSync(join(DIR, 'diff.png'))) copyFileSync(join(DIR, 'diff.png'), BASE_DIFF_BAK);
  } catch (e) { log('[fixup] baseline backup failed:', String(e).slice(0, 100)); }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const before = readScore();
    log(`\n[fixup] round ${round} (current ${before.total}%)`);
    let css = '';
    // computed style 精确差异（原站 vs 克隆逐元素 DOM 路径配对）——AI 补丁的弹药，不再猜选择器
    let styleDiffs = [];
    try {
      const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
      if (!manifest.target) throw new Error('manifest has no target (old capture)');
      styleDiffs = await probeStyleDiff(manifest.target, CLONE_URL, { maxPairs: 25 });
      log(`  style-probe: ${styleDiffs.length} elements with computed diffs`);
    } catch (e) { log('  style-probe failed:', String(e).slice(0, 100)); }
    const styleHint = styleDiffs.length
      ? `已量化的逐元素样式差异清单（path 中 .token 是可直接使用的类选择器，:N 是兄弟序号不可用于选择器；propDiffs 里 src=原站值 clone=克隆值），补丁必须逐条精确消除这些差异（优先级最高）：\n` +
        JSON.stringify(styleDiffs).slice(0, 6000) + `\n`
      : '';
    try {
      const out = await llmVision(
        `你是像素级 CSS 修复专家。两张图依次是：1) 原站目标截图 2) 当前克隆页截图。\n` +
        (styleHint ? `另有已量化的逐元素样式差异清单，补丁必须逐条精确消除这些差异（优先级最高）：\n${styleHint}` : '') +
        `注意：差异中的动画噪声（打字机/轮播的瞬时帧不同）已被评分体系排除，不要试图修复任何动画；只修静态差异（布局/间距/颜色/字号/圆角/显隐）。\n` +
        `输出一个 JSON：{"analysis":"简述静态差异","css":"追加到克隆页的 CSS 补丁"}。\n` +
        `约束：只输出 CSS 规则，不要 HTML；可用的类名清单（前 100 个）如下，选择器必须从中挑选或使用标签/结构选择器：\n${inventory}\n` +
        `硬性规则：① 页面是深色主题，禁止修改全局背景色/文字颜色主题 ② 禁止 body/html/*/通配符级规则 ③ 最多 6 条规则，每条选择器尽量窄 ④ 所有大括号必须闭合 ⑤ CSS 力求精准克制，不要整页重排。`,
        [join(DIR, 'shot-src.jpg'), join(DIR, 'shot-clone.jpg')],
        { json: true, timeout: 300_000, fast: true },
      );
      css = (out.css ?? '').trim();
      log(`  analysis: ${(out.analysis ?? '').slice(0, 120)}`);
      if (!css) { log('  empty css, stop'); break; }
      // 补丁卫生检查：括号平衡、体量上限、禁主题级/通配符规则（防整页破坏——曾有一次 -47 分的教训）
      const open = (css.match(/{/g) ?? []).length, close = (css.match(/}/g) ?? []).length;
      if (open !== close || open > 12) { log(`  reject unbalanced/oversized css (braces ${open}/${close})`); break; }
      if (/body\s*\{|html\s*\{|\*\s*\{/.test(css)) { log('  reject: theme-level or wildcard rule'); break; }
    } catch (e) { log('  LLM call failed:', String(e).slice(0, 150)); break; }

    // 应用 → 重截 → 重打分
    writeFileSync(FIXES_CSS, `/* heimdall fixup round ${round} */\n` + css);
    injectFixLink();
    try {
      await run('crawler/shot_clone.mjs', [CLONE_URL, join(DIR, 'shot-clone.png')]);
      await run('differ/diff.mjs', [DIR]);
    } catch (e) { log('  rerun failed:', String(e).slice(0, 120)); break; }

    const after = readScore();
    const kept = after.total > before.total;
    log(`  ${before.total}% -> ${after.total}%  ${kept ? 'KEEP' : 'ROLLBACK'}`);
    history.push({ round, before: before.total, after: after.total, kept, cssBytes: css.length, css });
    emit({ kind: 'fixup-round', round, before: before.total, after: after.total, kept });

    if (kept) {
      best = after; bestCss = css;
      // 保留状态即新基线：后续轮次回滚时还原到这里
      try {
        copyFileSync(BASE_SHOT, BASE_SHOT_BAK);
        copyFileSync(join(DIR, 'score.json'), BASE_SCORE_BAK);
        if (existsSync(join(DIR, 'diff.png'))) copyFileSync(join(DIR, 'diff.png'), BASE_DIFF_BAK);
      } catch {}
    } else {
      writeFileSync(FIXES_CSS, '');
      // 直接还原基线产物（截图/分数/热图），比"重截"更确定
      try {
        copyFileSync(BASE_SHOT_BAK, BASE_SHOT);
        copyFileSync(BASE_SCORE_BAK, join(DIR, 'score.json'));
        if (existsSync(BASE_DIFF_BAK)) copyFileSync(BASE_DIFF_BAK, join(DIR, 'diff.png'));
      } catch {}
      break;
    }   // 回滚并停止
    if (after.total >= 99.5) { log('  close enough, stop'); break; }
  }

  writeFileSync(join(DIR, 'fixup-history.json'), JSON.stringify({ best, rounds: history }, null, 2));
  // 最终状态必须与 best 一致：优先还原基线产物（确定性），不再重截
  const final = readScore();
  if (final.total < best.total) {
    writeFileSync(FIXES_CSS, bestCss);
    try {
      copyFileSync(BASE_SHOT_BAK, BASE_SHOT);
      copyFileSync(BASE_SCORE_BAK, join(DIR, 'score.json'));
      if (existsSync(BASE_DIFF_BAK)) copyFileSync(BASE_DIFF_BAK, join(DIR, 'diff.png'));
    } catch {}
  }
  // 清理基线备份（除非显式保留）
  if (process.env.HEIMDALL_KEEP_BASELINE !== '1') {
    for (const f of [BASE_SHOT_BAK, BASE_SCORE_BAK, BASE_DIFF_BAK]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  }
  log(`[fixup] best ${best.total}%`);
}

main().catch(e => { log('[fixup] fatal', String(e)); process.exit(0); });   // 修复失败不阻塞流水线
