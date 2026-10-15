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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnv } from './env.mjs';
import { requireArg } from './args.mjs';
import { sourceFingerprint } from './fingerprint.mjs';
import { WORKSPACE } from './paths.mjs';
import { assertSiteOrigin, siteIdForOrigin } from './site-origin.mjs';
import { assertPageName } from './page-name.mjs';
import { asUrl, resolvePageNameOfUrl } from './url-canon.mjs';
import { runScript } from './child-run.mjs';
import { resolveCloneUrl } from './clone-doc.mjs';
import { emit } from './emit.mjs';
const ENV = getEnv();

const USAGE = 'node src/pipeline.mjs <url> [pageName]';
const RAW_URL = requireArg(process.argv[2], USAGE, '目标 URL');
const URL_ = asUrl(RAW_URL);   // `forge example.com home` 这种不带协议的写法同样可用
if (!URL_) { console.error(`不是有效的网址：${RAW_URL}`); process.exit(2); }
const log = (...a) => console.error(...a);

const host = siteIdForOrigin(WORKSPACE, URL_);
const NAME = assertPageName(process.argv[3] ?? resolvePageNameOfUrl(URL_, join(WORKSPACE, host)));
const DIR = join(WORKSPACE, host, 'pages', NAME);
assertSiteOrigin(join(WORKSPACE, host), URL_, { pageName: NAME });

// 阶段脚本统一走 child-run：失败时会带上子进程 stderr 的尾巴（理由见那个模块）
const run = (script, args) => runScript(script, args);

// shot_clone 会把当前 workspace 的本地克隆文件经临时回环 HTTP 服务截图。
const cloneUrlFor = () => resolveCloneUrl(host, NAME, DIR);

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

  // shot 阶段使用当前工作区的克隆文件。
  const clone = await cloneUrlFor();
  log(`\n==== [shot] (via ${clone.via}) ====`);
  emit({ kind: 'forge-stage', stage: 'shot', status: 'running', via: clone.via });
  emit({ kind: 'forge-note', note: '克隆截图使用当前工作区的临时回环静态服务' });
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
  // 动效重演：把捕获到的"揭示类"与"脚本关键帧"改写成纯 CSS，让静态镜像里也有动效。
  // 放在最后 —— 它读 motion.json，且必须在 clone/index.html 定稿之后再注入。
  // **失败不影响本次锻造**（与源站指纹那一步同一原则）：这是"锦上添花"的一层，
  // 没有它镜像照样是完整的，没理由因为一次重演失败把一整页的产物判死。
  // 不单独发 forge-stage：它不是用户视角的一个阶段，而是 build 的收尾。
  try {
    log('\n==== [motion-replay] ====');
    await run('crawler/motion-replay.mjs', [DIR]);
  } catch (e) {
    log('[motion-replay] skipped: ' + String(e).slice(0, 160));
  }

  log(`\nPIPELINE DONE -> ${DIR}`);
} catch (e) {
  failed = String(e);
  emit({ kind: 'forge-error', error: failed });
}
process.exit(failed ? 1 : 0);
