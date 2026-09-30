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
import { parse } from 'parse5';

const DIR = process.argv[2] ?? join('workspace', 'apify.com', 'pages', 'home');
const MAX_ROUNDS = Number(process.argv[3] ?? 2);
const CLONE_PORT = process.argv[4] ?? 8961;
const CLONE_HTML = join(DIR, 'clone', 'index.html');
const FIXES_CSS = join(DIR, 'clone', 'styles', 'fixes.css');
const FIXES_LINK = '<link rel="stylesheet" href="styles/fixes.css">';

const emit = (obj) => process.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
const log = (...a) => console.error(...a);

const readScore = () => {
  const s = JSON.parse(readFileSync(join(DIR, 'score.json'), 'utf8'));
  return { total: s.total, pixel: +(s.pixel * 100).toFixed(1) };
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
        `你是像素级 CSS 修复专家。三张图依次是：1) 原站目标截图 2) 当前克隆页截图 3) 两者差异热图（高亮处=差异）。\n` +
        `分析克隆与原站的视觉差异（布局/间距/颜色/字号/圆角/显隐），输出一个 JSON：{"analysis":"简述差异","css":"追加到克隆页的 CSS 补丁"}。\n` +
        `约束：只输出 CSS 规则，不要 HTML；可用的类名清单（前 100 个）如下，选择器必须从中挑选或使用标签/结构选择器：\n${inventory}\n` +
        `差异热图中最亮的区域优先修复。CSS 力求精准克制，不要整页重排。`,
        [join(DIR, 'shot-src.jpg'), join(DIR, 'shot-clone.jpg')],
        { json: true, timeout: 300_000, fast: true },
      );
      css = (out.css ?? '').trim();
      log(`  analysis: ${(out.analysis ?? '').slice(0, 120)}`);
      if (!css) { log('  empty css, stop'); break; }
    } catch (e) { log('  LLM call failed:', String(e).slice(0, 150)); break; }

    // 应用 → 重截 → 重打分
    writeFileSync(FIXES_CSS, `/* heimdall fixup round ${round} */\n` + css);
    injectFixLink();
    try {
      await run('crawler/shot_clone.mjs', [`http://127.0.0.1:${CLONE_PORT}/index.html`, join(DIR, 'shot-clone.png')]);
      await run('differ/diff.mjs', [DIR]);
    } catch (e) { log('  rerun failed:', String(e).slice(0, 120)); break; }

    const after = readScore();
    const kept = after.total > before.total;
    log(`  ${before.total}% -> ${after.total}%  ${kept ? 'KEEP' : 'ROLLBACK'}`);
    history.push({ round, before: before.total, after: after.total, kept, cssBytes: css.length });
    emit({ kind: 'fixup-round', round, before: before.total, after: after.total, kept });

    if (kept) { best = after; bestCss = css; }
    else { writeFileSync(FIXES_CSS, ''); break; }   // 回滚并停止
    if (after.total >= 99.5) { log('  close enough, stop'); break; }
  }

  writeFileSync(join(DIR, 'fixup-history.json'), JSON.stringify({ best, rounds: history }, null, 2));
  // 最终以最佳状态重截一次（若最后一轮被回滚）
  const final = readScore();
  if (final.total < best.total && bestCss) {
    writeFileSync(FIXES_CSS, bestCss);
    try { await run('crawler/shot_clone.mjs', [`http://127.0.0.1:${CLONE_PORT}/index.html`, join(DIR, 'shot-clone.png')]); await run('differ/diff.mjs', [DIR]); } catch {}
  }
  log(`[fixup] best ${best.total}%`);
}

main().catch(e => { log('[fixup] fatal', String(e)); process.exit(0); });   // 修复失败不阻塞流水线
