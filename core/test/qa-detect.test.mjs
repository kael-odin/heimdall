/**
 * qa：无参照物检测与跨运行回归（纯函数 / 文件层，不开浏览器）
 *
 * 浏览器里的检测器由 benchmark-qa 的固定夹具评测；这里验证它们的元数据、
 * 发现形状、差异判定与基线比对逻辑，保证不依赖 Chromium 也能守住约定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { DETECTOR_META, DETECTOR_IDS, DETECT_DEFAULTS, detectInPage } from '../src/qa/detect.mjs';
import { KINDS, normalizeFinding, fingerprintOf } from '../src/qa/findings.mjs';
import { diffSnapshots, skipReason } from '../src/qa/explore.mjs';
import { writeBaseline, readBaseline, compareWithBaseline, comparablePairs, describeBaseline, baselineFile, clearBaseline } from '../src/qa/baseline.mjs';
import { renderReport, renderBugs, fileable } from '../src/qa/report.mjs';
import { loadWorkspace } from '../src/qa/workspace.mjs';
import { assertBenchmarkCoverage, assertInteractionBenchmarkCoverage, benchmarkQa, matchBenchmarkFinding } from '../scripts/benchmark-qa.mjs';

const png = (width, height, [r, g, b]) => {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) { image.data[i] = r; image.data[i + 1] = g; image.data[i + 2] = b; image.data[i + 3] = 255; }
  return PNG.sync.write(image);
};

test('qa benchmark: incomplete detection cannot count as a clean result', () => {
  const coverage = { pages: [{ path: '/clean' }], detection: { enabled: true, pages: 1, failedPages: [] } };
  assert.doesNotThrow(() => assertBenchmarkCoverage(coverage, '/clean'));
  assert.throws(() => assertBenchmarkCoverage({ ...coverage, detection: { ...coverage.detection, pages: 0, failedPages: [{}] } }), /检测未完成/);
  assert.throws(() => assertBenchmarkCoverage({ ...coverage, detection: { ...coverage.detection, enabled: false } }), /检测未完成/);
  assert.throws(() => assertBenchmarkCoverage({ ...coverage, detection: { ...coverage.detection, pages: 0 } }), /检测未完成/);
  assert.throws(() => assertBenchmarkCoverage({ ...coverage, detection: { enabled: true, pages: 1 } }), /检测未完成/);
  assert.throws(() => assertBenchmarkCoverage({ ...coverage, pages: [{ path: '/clean', navError: 'failed' }] }), /检测未完成/);
  assert.throws(() => assertBenchmarkCoverage(coverage, '/other'), /检测未完成/);
});

test('qa benchmark: matching requires the expected target, kind and problem evidence', () => {
  const target = { detector: 'a11y-form-label', kind: 'a11y', target: '#expected' };
  const other = { detector: target.detector, kind: target.kind, target: '#other' };
  const right = { ...other, target: target.target };
  assert.equal(matchBenchmarkFinding(target, [other]), undefined);
  assert.equal(matchBenchmarkFinding(target, [{ ...right, kind: 'layout' }]), undefined);
  assert.equal(matchBenchmarkFinding(target, [other, right]), right);
  const heading = { detector: 'a11y-heading', kind: 'a11y', target: 'h1', observedIncludes: '没有 h1' };
  assert.equal(matchBenchmarkFinding(heading, [{ ...heading, observed: '两个 h1' }]), undefined);
  assert.ok(matchBenchmarkFinding(heading, [{ ...heading, observed: '其中没有 h1' }]));

  const noOp = { kind: 'interaction', target: '#button', basis: 'wrong', evidenceType: 'unchanged' };
  assert.equal(matchBenchmarkFinding(noOp, [{ kind: 'interaction', target: '#button', basis: 'failed', evidence: { status: 404 } }]), undefined);
  assert.equal(matchBenchmarkFinding(noOp, [{ kind: 'interaction', target: '#button', basis: 'wrong', evidence: { before: {}, after: null } }]), undefined);
  const snapshot = { url: 'http://fixture/', title: 'fixture', textLength: 1, textHash: 1, visibleElements: 1, bodyHeight: 1, overlays: 0, expanded: '' };
  assert.equal(matchBenchmarkFinding(noOp, [{ kind: 'interaction', target: '#button', basis: 'wrong', evidence: { before: {}, after: {} } }]), undefined);
  assert.ok(matchBenchmarkFinding(noOp, [{ kind: 'interaction', target: '#button', basis: 'wrong', evidence: { before: snapshot, after: snapshot } }]));
  const brokenLink = { kind: 'interaction', target: '#link', basis: 'failed', evidenceType: 'http', status: 404, failedPath: '/gone' };
  assert.equal(matchBenchmarkFinding(brokenLink, [{ kind: 'interaction', target: '#link', basis: 'failed', evidence: { status: 500, failedUrl: 'http://localhost/gone' } }]), undefined);
  assert.ok(matchBenchmarkFinding(brokenLink, [{ kind: 'interaction', target: '#link', basis: 'failed', evidence: { status: 404, failedUrl: 'http://localhost/gone' } }]));
  const error = { kind: 'interaction', target: '#throw', basis: 'failed', evidenceType: 'error', errorIncludes: 'fixture failure' };
  assert.equal(matchBenchmarkFinding(error, [{ kind: 'interaction', target: '#throw', basis: 'failed', evidence: { errors: ['different error'] } }]), undefined);
  assert.ok(matchBenchmarkFinding(error, [{ kind: 'interaction', target: '#throw', basis: 'failed', evidence: { errors: ['fixture failure'] } }]));
});

test('qa benchmark: interaction coverage requires every declared fixture click', () => {
  const coverage = { explore: { enabled: true, pages: [{ path: '/interact', controls: 2, clicked: 2, skipped: {}, budgetExhausted: false }] } };
  const targets = ['#bad', '#good'];
  assert.doesNotThrow(() => assertInteractionBenchmarkCoverage(coverage, ['#bad', '#good'], targets));
  assert.throws(() => assertInteractionBenchmarkCoverage(coverage, ['#bad', '#bad'], targets), /探索未完成/);
  assert.throws(() => assertInteractionBenchmarkCoverage(coverage, ['#bad', '#other'], targets), /探索未完成/);
  assert.throws(() => assertInteractionBenchmarkCoverage({ explore: { ...coverage.explore, enabled: false } }, targets, targets), /探索未完成/);
  assert.throws(() => assertInteractionBenchmarkCoverage({ explore: { ...coverage.explore, pages: [{ ...coverage.explore.pages[0], budgetExhausted: true }] } }, targets, targets), /探索未完成/);
  assert.throws(() => assertInteractionBenchmarkCoverage({ explore: { ...coverage.explore, pages: [{ ...coverage.explore.pages[0], skipped: { 'step-failed': 1 } }] } }, targets, targets), /探索未完成/);
});

test('qa benchmark: an interrupted run cannot leave an older pass as latest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-benchmark-status-'));
  try {
    mkdirSync(join(root, 'earlier'));
    writeFileSync(join(root, 'earlier', 'benchmark.json'), '{"passed":true}');
    writeFileSync(join(root, 'latest.json'), '{"runDir":"earlier","passed":true}');
    let rejectFixture;
    const pending = benchmarkQa({ outputDir: root, startFixture: () => new Promise((resolve, reject) => { rejectFixture = reject; }) });
    const running = JSON.parse(readFileSync(join(root, 'latest.json'), 'utf8'));
    assert.equal(running.status, 'running');
    assert.equal(running.passed, null);
    rejectFixture(new Error('fixture failed'));
    await assert.rejects(pending, /fixture failed/);
    const latest = JSON.parse(readFileSync(join(root, 'latest.json'), 'utf8'));
    assert.equal(latest.status, 'incomplete');
    assert.equal(latest.passed, null);
    assert.notEqual(latest.runDir, 'earlier');
    assert.equal(JSON.parse(readFileSync(join(root, 'earlier', 'benchmark.json'), 'utf8')).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-detect-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'Detect', sites: { web: { url: 'http://127.0.0.1:1/', pages: ['/'], environment: 'test' } }, ...config,
  }));
  return root;
}

test('detect: every detector reports a known finding kind and defaults are sane', () => {
  assert.ok(DETECTOR_IDS.length >= 20, 'detector catalog should cover the documented checks');
  for (const id of DETECTOR_IDS) {
    const meta = DETECTOR_META[id];
    assert.ok(KINDS.includes(meta.kind), `${id} uses unknown kind ${meta.kind}`);
    assert.ok(meta.label && meta.label.length > 2);
  }
  for (const key of ['lcpMs', 'cls', 'maxPerDetector', 'tapTargetPx', 'mobileTapTargetPx', 'oversizedImageRatio', 'textClippedRatio']) {
    assert.equal(typeof DETECT_DEFAULTS[key], 'number', `default ${key}`);
  }
  assert.equal(typeof detectInPage, 'function');
});

test('findings: new kinds survive normalization and keep the detector id', () => {
  const { finding } = normalizeFinding({
    kind: 'a11y', title: '图片缺少替代文字', target: 'img:nth-of-type(1)', basis: 'wrong', tier: 'degrade',
    loss: '读屏用户无法知道这张图的内容', observed: '<img> 没有 alt', detector: 'a11y-image-alt',
    evidence: { url: 'http://x/', viewport: '1440x900' },
  }, { site: 'web', runId: 'qa-1' });
  assert.equal(finding.kind, 'a11y');
  assert.equal(finding.detector, 'a11y-image-alt');
  assert.equal(finding.tier, 'degrade');
  assert.ok(fileable({ ...finding, triage: { status: 'new' } }));
  // 指纹只取稳定部分：同一元素同类问题跨运行一致，数字变化不影响
  assert.equal(fingerprintOf({ site: 'web', path: '/', kind: 'a11y', target: 'img:nth-of-type(1)', text: '图片缺少替代文字' }),
    fingerprintOf({ site: 'web', path: '/', kind: 'a11y', target: 'img:nth-of-type(1)', text: '图片缺少替代文字' }));
});

test('explore: snapshot diff notices url, text, height and state changes', () => {
  const base = { url: 'http://x/', title: 't', textLength: 100, textHash: 1, visibleElements: 20, bodyHeight: 900, overlays: 0, expanded: 'a:false' };
  assert.deepEqual(diffSnapshots(base, { ...base }), []);
  assert.deepEqual(diffSnapshots(base, { ...base, url: 'http://x/next' }), ['url']);
  assert.ok(diffSnapshots(base, { ...base, textHash: 2 }).includes('text'));
  assert.ok(diffSnapshots(base, { ...base, bodyHeight: 1200 }).includes('height'));
  assert.ok(diffSnapshots(base, { ...base, overlays: 1 }).includes('overlay'));
  assert.ok(diffSnapshots(base, { ...base, expanded: 'a:true' }).includes('state'));
});

test('explore: destructive, external, download and submit controls are skipped', () => {
  const origin = 'http://127.0.0.1:1';
  assert.equal(skipReason({ tag: 'button', label: '删除账号', href: null }, origin), 'destructive');
  assert.equal(skipReason({ tag: 'button', label: '立即支付', href: null }, origin), 'destructive');
  assert.equal(skipReason({ tag: 'a', label: '文档', href: 'https://other.example/x' }, origin), 'external');
  assert.equal(skipReason({ tag: 'a', label: '报表', href: '/x.pdf' }, origin), 'download');
  assert.equal(skipReason({ tag: 'a', label: '邮件', href: 'mailto:a@b.c' }, origin), 'non-web-scheme');
  assert.equal(skipReason({ tag: 'button', label: '提交', href: null, inForm: true, type: 'submit' }, origin), 'submit-control');
  assert.equal(skipReason({ tag: 'button', label: '展开', href: null }, origin), null);
  assert.equal(skipReason({ tag: 'a', label: '详情', href: '/detail' }, origin), null);
});

test('baseline: register, compare identical and changed screenshots, respect site and threshold', () => {
  const root = workspace();
  try {
    const ws = loadWorkspace(root);
    const baseRunId = 'qa-20260101-000000-aaaa';
    const nowRunId = 'qa-20260102-000000-bbbb';
    const baseDir = join(ws.dataDir, 'runs', baseRunId);
    const nowDir = join(ws.dataDir, 'runs', nowRunId);
    mkdirSync(join(baseDir, 'shots'), { recursive: true });
    mkdirSync(join(nowDir, 'shots'), { recursive: true });
    const same = png(40, 40, [240, 240, 240]);
    writeFileSync(join(baseDir, 'shots', 'home-1440x900.png'), same);
    writeFileSync(join(nowDir, 'shots', 'home-1440x900.png'), same);
    writeFileSync(join(baseDir, 'run.json'), JSON.stringify({ runId: baseRunId, site: 'web', environment: 'test' }));
    writeFileSync(join(nowDir, 'run.json'), JSON.stringify({ runId: nowRunId, site: 'web', environment: 'test' }));

    const baseRun = { runId: baseRunId, site: 'web', environment: 'test', siteUrl: 'http://127.0.0.1:1/' };
    const nowRun = { runId: nowRunId, site: 'web', environment: 'test', siteUrl: 'http://127.0.0.1:1/' };
    const pages = [{ path: '/', viewport: '1440x900', screenshot: 'shots/home-1440x900.png', url: 'http://127.0.0.1:1/' }];
    const registered = writeBaseline(ws, baseRun, pages);
    assert.equal(registered.pages.length, 1);
    assert.equal(readBaseline(ws).runId, baseRunId);
    assert.equal(describeBaseline(ws).exists, true);
    assert.throws(() => writeBaseline(ws, nowRun, [{ path: '/', viewport: '1440x900', screenshot: null }]), /没有可登记/);
    assert.equal(readBaseline(ws).runId, baseRunId, 'an empty run cannot erase a valid baseline');
    assert.throws(() => writeBaseline(ws, nowRun, [...pages, { ...pages[0], path: '/private', unavailableReason: 'login-expired' }]), /不完整基线/);
    assert.equal(readBaseline(ws).runId, baseRunId, 'one failed page cannot erase the existing baseline');
    const before = readFileSync(baselineFile(ws), 'utf8');
    assert.throws(() => writeBaseline(ws, nowRun, [...pages, { ...pages[0], path: '/missing', screenshot: null }]), /不完整基线/);
    assert.equal(readFileSync(baselineFile(ws), 'utf8'), before, 'a partially captured run cannot replace an approved baseline');
    writeFileSync(join(nowDir, 'shots', 'broken.png'), 'not a PNG');
    assert.throws(() => writeBaseline(ws, nowRun, [...pages, { ...pages[0], path: '/broken', screenshot: 'shots/broken.png' }]), /不完整基线/);
    assert.equal(readFileSync(baselineFile(ws), 'utf8'), before, 'a corrupt capture cannot replace an approved baseline');

    // 同一张图：相似度 100%，不产生发现
    const identical = compareWithBaseline(ws, nowRun, pages, { threshold: 0.98 });
    assert.equal(identical.compared, 1);
    assert.equal(identical.status, 'compared');
    assert.equal(identical.findings.length, 0);
    const missingShot = compareWithBaseline(ws, nowRun, [{ ...pages[0], screenshot: 'shots/missing.png' }]);
    assert.equal(missingShot.compared, 0, 'missing screenshots are not counted as comparisons');
    assert.equal(missingShot.status, 'incomplete');
    assert.match(missingShot.skipped[0].reason, /截图缺失/);
    const noShot = compareWithBaseline(ws, nowRun, [{ ...pages[0], screenshot: null }]);
    assert.equal(noShot.status, 'incomplete');
    assert.match(noShot.skipped[0].reason, /截图/);

    // 不同站点：跳过并说明原因
    const otherSite = compareWithBaseline(ws, { ...nowRun, site: 'app' }, pages, { threshold: 0.98 });
    assert.equal(otherSite.findings.length, 0);
    assert.equal(otherSite.status, 'not_applicable');
    assert.match(otherSite.skipped[0].reason, /站点/);
    for (const changed of [{ environment: 'production' }, { siteUrl: 'http://127.0.0.1:2/' }]) {
      const mismatch = compareWithBaseline(ws, { ...nowRun, ...changed }, pages);
      assert.equal(mismatch.status, 'incomplete', 'the same site name cannot hide an environment or origin change');
      assert.equal(mismatch.compared, 0);
    }
    const newPage = compareWithBaseline(ws, nowRun, [...pages, { ...pages[0], path: '/new' }]);
    assert.equal(newPage.status, 'partial');
    assert.equal(newPage.compared, 1);
    assert.ok(newPage.skipped.some(item => /未登记/.test(item.reason)));
    const onlyNew = compareWithBaseline(ws, nowRun, [{ ...pages[0], path: '/new' }]);
    assert.equal(onlyNew.status, 'unmatched');
    assert.equal(onlyNew.compared, 0);

    // 本次截图变了：产生一条回归发现，带证据与差异图
    writeFileSync(join(nowDir, 'shots', 'home-1440x900.png'), png(40, 40, [10, 10, 10]));
    const result = compareWithBaseline(ws, nowRun, pages, { threshold: 0.98, diffDir: join(nowDir, 'shots') });
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0];
    assert.equal(finding.kind, 'regression');
    assert.equal(finding.tier, 'degrade');
    assert.ok(finding.evidence.score < 0.98);
    assert.match(finding.title, /1440x900/);
    assert.ok(finding.evidence.diff, 'diff image is written next to the run');
    assert.ok(readFileSync(join(nowDir, finding.evidence.diff)).length > 0);

    // 基线与本次页面/视口对不上时，不算回归
    assert.equal(comparablePairs(readBaseline(ws), []).length, 0);

    // 空文件既可能是旧版清除，也可能是损坏；不应当作已明确清除。
    writeFileSync(baselineFile(ws), '');
    assert.equal(describeBaseline(ws).status, 'invalid');
    assert.equal(compareWithBaseline(ws, nowRun, pages).status, 'incomplete');
    clearBaseline(ws);
    assert.equal(readBaseline(ws), null);
    assert.equal(describeBaseline(ws).status, 'cleared');
    assert.equal(compareWithBaseline(ws, nowRun, pages).status, 'unconfigured');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('baseline: legacy source metadata and partially registered pages must remain auditable', () => {
  const root = workspace();
  try {
    const ws = loadWorkspace(root);
    const runId = 'qa-20260101-000000-aaaa';
    const current = { runId: 'qa-20260102-000000-bbbb', site: 'web', environment: 'test', siteUrl: 'http://127.0.0.1:1/' };
    const page = { path: '/', viewport: '1440x900', screenshot: 'shots/home.png' };
    for (const id of [runId, current.runId]) {
      mkdirSync(join(ws.dataDir, 'runs', id, 'shots'), { recursive: true });
      writeFileSync(join(ws.dataDir, 'runs', id, page.screenshot), png(2, 2, [255, 255, 255]));
    }
    const legacy = { schema: 'heimdall.qa-baseline/1', runId, site: 'web', environment: 'test',
      pages: [{ ...page, runId }], missing: [{ path: '/missing', viewport: '1440x900', reason: '没有截图' }] };
    writeFileSync(baselineFile(ws), JSON.stringify(legacy));
    assert.equal(compareWithBaseline(ws, current, [page]).status, 'incomplete', 'missing historical source cannot be guessed');
    writeFileSync(join(ws.dataDir, 'runs', runId, 'run.json'), JSON.stringify({ runId, site: 'web', environment: 'test', siteUrl: current.siteUrl }));
    assert.equal(compareWithBaseline(ws, current, [page]).status, 'compared');
    const partial = compareWithBaseline(ws, current, [page, { ...page, path: '/missing' }]);
    assert.equal(partial.status, 'incomplete', 'a known previously missing baseline image cannot masquerade as a new page');
    assert.ok(partial.skipped.some(item => item.path === '/missing' && item.incomplete));
    legacy.pages.push({ ...legacy.pages[0], screenshot: '../private.png' });
    writeFileSync(baselineFile(ws), JSON.stringify(legacy));
    assert.equal(describeBaseline(ws).status, 'invalid');
    assert.equal(compareWithBaseline(ws, current, [page]).status, 'incomplete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report: detection summary groups findings by kind and keeps tolerable ones out of bugs.md', () => {
  const ws = { project: 'Demo' };
  const run = {
    runId: 'qa-20260101-000000-abcd', project: 'Demo', site: 'web', siteUrl: 'http://127.0.0.1:1/', environment: 'test',
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    coverage: { pages: [], checks: [], viewports: ['1440x900'], detection: { enabled: true, findings: 2 }, explore: { enabled: false }, baseline: { enabled: false } },
    summary: { total: 2, fileable: 1, knownBug: 0, suppressed: 0, tolerable: 1, environment: 0, checkNeedsFix: 0, new: 2, reopened: 0 },
  };
  const findings = [
    { ...normalizeFinding({ kind: 'a11y', title: '图片缺少替代文字', target: 'img', basis: 'wrong', tier: 'degrade', loss: '读屏用户无法知道内容', detector: 'a11y-image-alt', evidence: {} }, { site: 'web' }).finding, id: 'F1', triage: { status: 'new' } },
    { ...normalizeFinding({ kind: 'layout', title: '点击目标过小', target: 'a', basis: 'friction', tier: 'tolerable', detector: 'layout-tap-target', evidence: {} }, { site: 'web' }).finding, id: 'F2', triage: { status: 'new' } },
  ];
  const report = renderReport({ ws, run, findings, hits: [] });
  assert.match(report, /无参照物检测（2 条）/);
  assert.match(report, /无障碍 \| 1 \| 1/);
  assert.match(report, /布局与响应式 \| 1 \| 0/);
  assert.match(report, /a11y-image-alt/);
  const bugs = renderBugs({ ws, run, findings });
  assert.match(bugs, /图片缺少替代文字/);
  assert.doesNotMatch(bugs, /点击目标过小/);
});
