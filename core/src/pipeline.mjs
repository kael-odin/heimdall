/**
 * pipeline — 一条命令跑完整还原流水线（事件化，供 engine-server 转发 SSE）
 *
 *   node src/pipeline.mjs <url> <pageName>
 *   例: node src/pipeline.mjs https://apify.com/pricing pricing
 *
 * 事件（@@EVENT@@ 行）:
 *   {kind:'forge-stage', stage, status:'running'|'done'}
 *   {kind:'forge-score', score}
 * 产物: workspace/<host>/pages/<pageName>/
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEnv } from './env.mjs';
import { requireArg } from './args.mjs';
import { sourceFingerprint } from './fingerprint.mjs';
import { WORKSPACE } from './paths.mjs';
import { asUrl, pageNameOfUrl } from './url-canon.mjs';
import { emit } from './emit.mjs';
const ENV = getEnv();

const USAGE = 'node src/pipeline.mjs <url> [pageName]';
const RAW_URL = requireArg(process.argv[2], USAGE, '目标 URL');
const URL_ = asUrl(RAW_URL);   // `forge example.com home` 这种不带协议的写法同样可用
if (!URL_) { console.error(`不是有效的网址：${RAW_URL}`); process.exit(2); }
const NAME = process.argv[3] ?? pageNameOfUrl(URL_);

const log = (...a) => console.error(...a);

const host = new URL(URL_).hostname.replace(/^www\./, '');
const DIR = join(WORKSPACE, host, 'pages', NAME);
mkdirSync(DIR, { recursive: true });

const run = (script, args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join('src', script), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  p.on('error', reject);
});

// 克隆页静态服务由 engine-server 常驻提供（/static/...）。
// 引擎不在时回退 file:// —— 克隆页资产已全部本地化（相对路径），实测 0 失败请求。
// 这条回退是「工具能独立跑」的关键：`heimdall forge` 不该要求用户先起引擎。
//
// **回退成立的前提是构建阶段把本地引用上的 `crossorigin` 摘干净了。**
// 留着的话 file:// 下会以 CORS 模式取本地文件而全部失败（裂图占位框），
// 而 http 下完全正常 —— 于是"两条路口径相同"这句话就只在构建正确时才成立。
// 实测 apify.com/home：file:// 截图 84.8%、/static 截图 100%（见 dom-refs.mjs）。
const SELF_URL = process.env.HEIMDALL_SELF_URL ?? `http://127.0.0.1:${process.env.HEIMDALL_PORT ?? 8900}`;

async function resolveCloneUrl() {
  try {
    const r = await fetch(`${SELF_URL}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return { url: `${SELF_URL}/static/${host}/pages/${NAME}/clone/index.html`, via: 'engine' };
  } catch { /* 引擎未启动 */ }
  return { url: pathToFileURL(join(DIR, 'clone', 'index.html')).href, via: 'file' };
}

const STAGES = [
  ['capture', 'crawler/capture.mjs', [URL_, DIR]],
  ['build', 'crawler/build_clone.mjs', [DIR]],
];

let failed = null;
try {
  for (const [stage, script, args] of STAGES) {
    emit({ kind: 'forge-stage', stage, status: 'running' });
    log(`\n==== [${stage}] ====`);
    await run(script, args);
    emit({ kind: 'forge-stage', stage, status: 'done' });
  }

  // 记录源站指纹：一次普通 fetch，供后续 `queue --incremental` 判断该页是否变过。
  // 失败不影响本次锻造（拿不到指纹只意味着下次会重跑这一页）。
  try {
    const fp = await sourceFingerprint(URL_);
    writeFileSync(join(DIR, 'fingerprint.json'), JSON.stringify(fp, null, 2));
  } catch { /* 指纹只是优化，缺了不影响产物 */ }

  // shot 阶段——引擎可达走 /static，否则 file://（两者截图口径相同）
  const clone = await resolveCloneUrl();
  log(`\n==== [shot] (via ${clone.via}) ====`);
  emit({ kind: 'forge-stage', stage: 'shot', status: 'running', via: clone.via });
  emit({ kind: 'forge-note', note: clone.via === 'file' ? '引擎未运行，克隆截图走 file://' : '引擎在线，克隆截图走 /static' });
  await run('crawler/shot_clone.mjs', [clone.url, join(DIR, 'shot-clone.png')]);
  emit({ kind: 'forge-stage', stage: 'shot', status: 'done', via: clone.via });

  emit({ kind: 'forge-stage', stage: 'diff', status: 'running' });
  log(`\n==== [diff] ====`);
  await run('differ/diff.mjs', [DIR]);
  const score = JSON.parse(readFileSync(join(DIR, 'score.json'), 'utf8'));
  emit({ kind: 'forge-score', score });
  emit({ kind: 'forge-stage', stage: 'diff', status: 'done' });

  // AI 校准：fixup 内部按"可修性信号"（静态差异占比）自判是否值得跑（动画噪声页自动豁免）
  emit({ kind: 'forge-stage', stage: 'fixup', status: 'running' });
  log(`\n==== [fixup] ====`);
  await run('differ/fixup.mjs', [DIR, '2']);
  emit({ kind: 'forge-stage', stage: 'fixup', status: 'done' });

  // fixup 可能提升分数：以最终 score.json 为准再发一次（UI 必须显示最终值）
  try {
    const finalScore = JSON.parse(readFileSync(join(DIR, 'score.json'), 'utf8'));
    emit({ kind: 'forge-score', score: finalScore, final: true });
  } catch {}

  emit({ kind: 'forge-stage', stage: 'harvest', status: 'running' });
  log(`\n==== [harvest] ====`);
  await run('harvest/harvest.mjs', [DIR]);
  emit({ kind: 'forge-stage', stage: 'harvest', status: 'done' });

  // 跨页情报汇总 + 站点级接线 + 全站克隆索引页。
  // 批量队列传入 HEIMDALL_SKIP_HOST_POST=1：整批只在最后跑一次，避免 60 页做 60 次全站汇总。
  if (ENV.HEIMDALL_SKIP_HOST_POST === '1') {
    log('\n[host-post] skipped (batch queue runs it once at the end)');
  } else {
    await run('harvest/xlsx.mjs', [host]);
    await run('crawler/linker.mjs', [host]);
    await run('crawler/index-page.mjs', [host]);
  }
  log(`\nPIPELINE DONE -> ${DIR}`);
} catch (e) {
  failed = String(e);
  emit({ kind: 'forge-error', error: failed });
}
process.exit(failed ? 1 : 0);
