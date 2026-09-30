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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { llmEnabled, llmVision } from '../llm.mjs';
import { getEnv } from '../env.mjs';
import { parse } from 'parse5';

const ENV = getEnv();
const MIN_STATIC = Number(ENV.FIXUP_MIN_STATIC ?? 0.002);      // 静态差异像素占视口比低于此 = 没有可修内容
const MIN_REFINABLE = Number(ENV.FIXUP_MIN_REFINABLE ?? 0.3);  // 静态差异占全部差异比低于此 = 主要是动画噪声

const DIR = process.argv[2] ?? join('workspace', 'apify.com', 'pages', 'home');
const MAX_ROUNDS = Number(process.argv[3] ?? 2);
const CLONE_PORT = process.argv[4] ?? 8900;
const CLONE_HTML = join(DIR, 'clone', 'index.html');
// clone 页由 engine-server 常驻静态服务提供（/static/<workspace 相对路径>）
const CLONE_REL = DIR.replace(/^[\\/]/, '').replace(/^workspace[\\/]/, '');
const CLONE_URL = `http://127.0.0.1:${CLONE_PORT}/static/${CLONE_REL.split(/[\\/]/).join('/')}/clone/index.html`;
const FIXES_CSS = join(DIR, 'clone', 'styles', 'fixes.css');
const FIXES_LINK = '<link rel="stylesheet" href="styles/fixes.css">';

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

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const before = readScore();
    log(`\n[fixup] round ${round} (current ${before.total}%)`);
    let css = '';
    try {
      const out = await llmVision(
        `你是像素级 CSS 修复专家。两张图依次是：1) 原站目标截图 2) 当前克隆页截图。\n` +
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

    if (kept) { best = after; bestCss = css; }
    else {
      writeFileSync(FIXES_CSS, '');
      // 状态对齐：回滚后 shot-clone.png 残留的是"带补丁"的截图，必须重截恢复基线，否则污染后续轮次
      try {
        await run('crawler/shot_clone.mjs', [CLONE_URL, join(DIR, 'shot-clone.png')]);
        await run('differ/diff.mjs', [DIR]);
      } catch {}
      break;
    }   // 回滚并停止
    if (after.total >= 99.5) { log('  close enough, stop'); break; }
  }

  writeFileSync(join(DIR, 'fixup-history.json'), JSON.stringify({ best, rounds: history }, null, 2));
  // 最终以最佳状态重截一次（若最后一轮被回滚）
  const final = readScore();
  if (final.total < best.total && bestCss) {
    writeFileSync(FIXES_CSS, bestCss);
    try { await run('crawler/shot_clone.mjs', [CLONE_URL, join(DIR, 'shot-clone.png')]); await run('differ/diff.mjs', [DIR]); } catch {}
  }
  log(`[fixup] best ${best.total}%`);
}

main().catch(e => { log('[fixup] fatal', String(e)); process.exit(0); });   // 修复失败不阻塞流水线
