/**
 * handoff 交接说明 —— 只钉一件事：**没做到的要写在最前面**。
 *
 * 这份文字是整个交付包里唯一"承诺了这个包证明了什么"的地方。如果它把
 * 未测到的页写成"完成"，下游就会拿着没有测量结论的复刻件去开工。
 * 所以这里测的不是文案措辞，而是几种覆盖状态下的信息缺口有没有被如实说出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHandoff } from '../src/handoff-report.mjs';

const base = {
  siteId: 'example.test',
  origin: 'https://example.test',
  target: 'https://example.test/',
  gaps: null,
  delivered: 'example.test-2026-10-24',
};

test('handoff: 有未测页时，第一段就写明"没有测量结论"并列出卡点', () => {
  const md = renderHandoff({
    ...base,
    summary: {
      targetTotal: 120, measured: 96, bounded: 0, untested: 24, average: 0.9123,
      worst: { page: 'checkout', name: '375x812', score: 0.6 },
      blockers: { '还有请求一直没结束（长轮询 / 埋点 / 统计心跳）': 31, '滚动后页高还在增长（无限滚动 / 懒加载）': 5 },
    },
  });
  assert.match(md, /已发现 120 页/);
  assert.match(md, /完整测到 96 页/);
  assert.match(md, /没测到 24 页/);
  assert.match(md, /24 页没有数字/);
  assert.match(md, /不等于它们看起来没问题/);
  assert.match(md, /31 个视口/);
  assert.match(md, /滚动后页高还在增长/);
  assert.match(md, /91\.2%/);
  assert.match(md, /最差：`checkout` @ 375x812 60\.0%/);
  // 有未测页时，不能宣称"覆盖完整"
  assert.ok(!/覆盖完整，可以直接进人工检查/.test(md));
});

test('handoff: 有界置信度单独说明，不能被当成"完整测到"', () => {
  const md = renderHandoff({
    ...base,
    summary: { targetTotal: 10, measured: 10, bounded: 4, untested: 0, average: 0.8, blockers: {} },
  });
  assert.match(md, /其中有界置信度 4 页/);
  assert.match(md, /版面在观察窗口内已经定住/);
  assert.match(md, /背地里还在跑东西/);
});

test('handoff: --skip-verify 时明确说没有还原度数字', () => {
  const md = renderHandoff({ ...base, summary: null, skippedVerify: true });
  assert.match(md, /没有跑验证/);
  assert.match(md, /没有任何还原度数字/);
  // 必须给出补跑的命令，而不是让人干瞪眼
  assert.match(md, /verify <host> --all --resume/);
  assert.ok(!/站均还原度/.test(md));
});

test('handoff: 验证结果缺失但没标 skip 时，也说清数字不存在', () => {
  const md = renderHandoff({ ...base, summary: null });
  assert.match(md, /没有验证结果/);
  assert.ok(!/站均还原度：\*\*—/.test(md), '缺少结果时不该伪造一个破折号分数');
  assert.doesNotMatch(md, /覆盖完整，可以直接进人工检查/);
});

test('handoff: 失败步骤不能把旧的通过摘要当成本次结果', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-handoff-stale-'));
  const site = join(dir, 'workspace', 'fixture.test');
  mkdirSync(join(site, 'verify'), { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin: 'https://fixture.test' }));
  const old = JSON.stringify({ mode: 'all', scoreVersion: 2, passed: true, targetTotal: 1,
    measured: 1, untested: 0, average: 0.99, pages: [] });
  writeFileSync(join(site, 'verify', 'verify-summary.json'), old);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ dataRoot: dir }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const preload = `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original = cp.spawn;
    cp.spawn = (cmd, args, opts) => original(cmd, ['-e', 'process.exit(' +
      (String(args[0]).replaceAll('\\\\', '/').endsWith('/verify/verify.mjs') ? '1' : '0') + ')'], opts);
    syncBuiltinESMExports();`;
  const script = fileURLToPath(new URL('../src/handoff.mjs', import.meta.url));
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), script,
      'https://fixture.test/', ...args], { env: { ...process.env, HEIMDALL_DATA_DIR: dir,
      HEIMDALL_API: `http://127.0.0.1:${server.address().port}` } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  try {
    const failed = await run([]);
    assert.equal(failed.code, 1, failed.output);
    const report = readFileSync(join(site, 'handoff', 'README.md'), 'utf8');
    assert.match(report, /没有验证结果/);
    assert.doesNotMatch(report, /99\.0%|覆盖完整，可以直接进人工检查/);
    assert.equal(readFileSync(join(site, 'verify', 'verify-summary.json'), 'utf8'), old);
    const skipped = await run(['--skip-verify']);
    assert.equal(skipped.code, 0, skipped.output);
    assert.match(skipped.output, /本次跳过验证/);
    assert.doesNotMatch(skipped.output, /验证门禁通过/);
    assert.match(readFileSync(join(site, 'handoff', 'README.md'), 'utf8'), /没有跑验证/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff: 失败时即使有部分结果也不能声称覆盖完整', () => {
  const md = renderHandoff({ ...base, verifyFailed: true,
    summary: { targetTotal: 1, measured: 1, untested: 0, average: 1 } });
  assert.match(md, /本次验证未通过或执行失败/);
  assert.doesNotMatch(md, /覆盖完整，可以直接进人工检查/);
});

test('handoff: 视觉结果存在但证据不完整时，保留测量并列出未确认页面', () => {
  const md = renderHandoff({
    ...base,
    summary: { targetTotal: 2, measured: 2, bounded: 0, untested: 0, average: 0.997, blockers: {} },
    summaryEvidence: { status: 'incomplete', invalidPages: [{ page: 'docs', status: 'stale' }, { page: 'blog', status: 'missing' }] },
    verifyFailed: true,
  });
  assert.match(md, /视觉测量已生成，但当前证据完整性核对未通过/);
  assert.match(md, /完整测到 2 页/);
  assert.match(md, /证据未确认的页面/);
  assert.match(md, /docs：stale/);
  assert.match(md, /blog：missing/);
  assert.doesNotMatch(md, /没有验证结果/);
  assert.doesNotMatch(md, /覆盖完整，可以直接进人工检查/);
});

test('handoff: 资产报告被截断时必须写明扫了多少页', () => {
  const md = renderHandoff({
    ...base,
    summary: { targetTotal: 3, measured: 3, bounded: 0, untested: 0, average: 0.9, blockers: {} },
    gaps: { summary: { refs: 500, localized: 420, localizationRate: 0.84, visual: 12, visualOrigin: 9, visualThird: 3, pages: 60, clonedPages: 74, truncated: true } },
  });
  assert.match(md, /只扫了 60 页，磁盘上共 74 页/);
  assert.match(md, /84\.0%/);
});

test('handoff: 交付包缺失时不假装成功', () => {
  const md = renderHandoff({
    ...base, delivered: null,
    summary: { targetTotal: 1, measured: 1, bounded: 0, untested: 0, average: 1, blockers: {} },
  });
  assert.match(md, /交付包没有生成成功/);
  assert.ok(!/deliverable\/example\.test-/.test(md));
});

test('handoff: 被 --max-pages 截断时说清只覆盖了前 N 页', () => {
  const md = renderHandoff({
    ...base, maxPages: 40,
    summary: { targetTotal: 120, measured: 24, bounded: 0, untested: 96, average: 0.9, blockers: {} },
  });
  assert.match(md, /--max-pages 40/);
  assert.match(md, /只覆盖了前 40 页/);
  assert.match(md, /其余 80 页没克隆也没测/);
});

test('handoff: 没触到上限时不画蛇添足', () => {
  const md = renderHandoff({
    ...base, maxPages: 40,
    summary: { targetTotal: 12, measured: 12, bounded: 0, untested: 0, average: 0.9, blockers: {} },
  });
  assert.ok(!/max-pages/.test(md), md);
});

test('handoff: 交付包中的 fidelity.csv 明确是历史辅助评分', () => {
  const md = renderHandoff({ ...base, summary: { targetTotal: 1, measured: 1, bounded: 0, untested: 0, average: 1, blockers: {} } });
  assert.match(md, /fidelity\.csv.*历史辅助评分/);
  assert.match(md, /不是 v2 多视口门禁分数/);
});

test('handoff: --strict 把离线交付结果写入交接说明', () => {
  const md = renderHandoff({
    ...base,
    strictRequested: true,
    live: {
      status: 'blocked', published: false, blockingCount: 3,
      blockers: { externalRuntime: 2, missingLivePages: 1 },
      healthReport: 'deliverable/.candidate-example.test-x/health.json',
    },
  });
  assert.match(md, /独立离线交付门禁/);
  assert.match(md, /严格.*阻断/);
  assert.match(md, /externalRuntime=2/);
  assert.match(md, /正式包没有被覆盖/);
  assert.match(md, /health\.json/);
  assert.match(md, /handoff <url> --strict/);
});

test('handoff: --strict 通过时需要 live 导出器写入 passed 结果', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-handoff-strict-'));
  const site = join(dir, 'workspace', 'fixture.test');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin: 'https://fixture.test' }));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ dataRoot: dir }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const liveReport = {
    schema: 'heimdall.live-export/1', siteId: 'fixture.test', status: 'passed', published: true,
    offline: true, strict: true, blockingCount: 0, blockers: {}, browser: { checked: 1, failed: 0, untested: 0 },
  };
  const livePath = JSON.stringify(join(site, 'live-export.json'));
  const liveBody = Buffer.from(JSON.stringify(liveReport), 'utf8').toString('base64');
  const liveCommand = `require('node:fs').writeFileSync(${livePath}, Buffer.from(${JSON.stringify(liveBody)}, 'base64')); process.exit(0)`;
  const preload = `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const original = cp.spawn;
    cp.spawn = (cmd, args, opts) => {
      const target = String(args[0]).replaceAll('\\\\', '/');
      const child = target.endsWith('/live/export.mjs')
        ? (process.env.HEIMDALL_TEST_LIVE_MODE === 'pass' ? ${JSON.stringify(liveCommand)} : 'process.exit(1)')
        : 'process.exit(0)';
      return original(cmd, ['-e', child], opts);
    };
    syncBuiltinESMExports();`;
  const script = fileURLToPath(new URL('../src/handoff.mjs', import.meta.url));
  const run = (args, mode) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), script,
      'https://fixture.test/', ...args], { env: { ...process.env, HEIMDALL_DATA_DIR: dir,
      HEIMDALL_API: `http://127.0.0.1:${server.address().port}`, HEIMDALL_TEST_LIVE_MODE: mode } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  try {
    const result = await run(['--skip-verify', '--strict'], 'pass');
    assert.equal(result.code, 0, result.output);
    assert.match(readFileSync(join(site, 'handoff', 'README.md'), 'utf8'), /live --offline --strict.*通过/);
    const stale = await run(['--skip-verify', '--strict'], 'fail');
    assert.equal(stale.code, 1, stale.output);
    assert.match(readFileSync(join(site, 'handoff', 'README.md'), 'utf8'), /没有得到有效结果/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
