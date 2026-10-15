import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationDependencyEvidence, compareOperationDependencyEvidence } from '../src/crawler/operation-dependency-parity.mjs';

function request(url, resourceType, category, extra = {}) {
  return {
    url, method: 'GET', resourceType, category, outcome: 'complete', status: 200,
    mime: resourceType === 'fetch' ? 'application/json' : 'text/javascript', ...extra,
  };
}

test('operation dependencies distinguish script, style, image, media and API targets without publishing paths', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  const dependencies = [
    request('https://source.test/assets/a.js?build=secret', 'script', 'asset'),
    request('https://source.test/assets/a.css', 'stylesheet', 'asset', { mime: 'text/css' }),
    request('https://source.test/assets/a.png', 'image', 'asset', { mime: 'image/png' }),
    request('https://source.test/assets/a.mp4', 'media', 'asset', { mime: 'video/mp4' }),
    request('https://source.test/api/list?page=1', 'fetch', 'dynamic-data'),
  ];
  for (const item of dependencies) source.observe(0, item);
  for (const item of dependencies) {
    const changed = new URL(item.url);
    changed.host = '127.0.0.1:8910';
    if (item.resourceType === 'script') changed.pathname = '/assets/b.js';
    if (item.resourceType === 'stylesheet') changed.pathname = '/assets/b.css';
    if (item.resourceType === 'image') changed.pathname = '/assets/b.png';
    if (item.resourceType === 'media') changed.pathname = '/assets/b.mp4';
    if (item.resourceType === 'fetch') changed.search = '?page=2';
    bundle.observe(0, { ...item, url: changed.href });
  }
  const report = compareOperationDependencyEvidence(source, bundle, 1);
  assert.equal(report.mismatchedFlows, 1);
  assert.equal(report.missing, 5);
  assert.equal(report.unexpected, 5);
  for (const kind of ['script', 'stylesheet', 'image', 'media', 'api']) {
    assert.equal(report.flows[0].classes[kind].missing, 1);
    assert.equal(report.flows[0].classes[kind].unexpected, 1);
  }
  assert.doesNotMatch(JSON.stringify(report), /assets\/|api\/|secret|page=|[a-f0-9]{64}/);
});

test('operation dependency parity checks response status, MIME and duplicate requests', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  const js = request('https://source.test/app.js', 'script', 'asset', { mime: 'application/javascript' });
  source.observe(0, js);
  source.observe(0, js);
  bundle.observe(0, { ...js, url: 'http://127.0.0.1:8910/app.js', mime: 'text/javascript' });
  let report = compareOperationDependencyEvidence(source, bundle, 1);
  assert.equal(report.responseMismatch, 1);
  assert.equal(report.variantMismatch, 1);
  bundle.observe(0, { ...js, url: 'http://127.0.0.1:8910/app.js', mime: 'text/javascript' });
  report = compareOperationDependencyEvidence(source, bundle, 1);
  assert.equal(report.mismatchedFlows, 0, 'equivalent JavaScript MIME labels should match');

  const changed = createOperationDependencyEvidence('http://127.0.0.1:8910');
  changed.observe(0, { ...js, url: 'http://127.0.0.1:8910/app.js', status: 206 });
  changed.observe(0, { ...js, url: 'http://127.0.0.1:8910/app.js', mime: 'text/plain' });
  report = compareOperationDependencyEvidence(source, changed, 1);
  assert.equal(report.responseMismatch, 2);
  assert.equal(report.variantMismatch, 2);
  assert.equal(report.mismatchedFlows, 1);
});

test('single response mismatch reports whether status or MIME changed', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  source.observe(0, request('https://source.test/style.css', 'stylesheet', 'asset', { mime: 'text/css' }));
  bundle.observe(0, request('http://127.0.0.1:8910/style.css', 'stylesheet', 'asset',
    { status: 206, mime: 'text/plain' }));
  const report = compareOperationDependencyEvidence(source, bundle, 1);
  assert.equal(report.statusMismatch, 1);
  assert.equal(report.mimeMismatch, 1);
  assert.equal(report.flows[0].classes.stylesheet.responseMismatch, 1);
});

test('unmapped and external dependencies cannot silently pass comparison', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  source.observe(0, request('https://cdn.test/private.js?token=secret', 'script', 'asset'));
  bundle.observe(0, request('http://127.0.0.1:8910/static/private.js', 'script', 'asset'));
  source.observe(0, request('data:text/javascript,secret', 'script', 'asset'));
  const report = compareOperationDependencyEvidence(source, bundle, 1);
  assert.equal(report.sourceExternal, 1);
  assert.equal(report.unverified, 1);
  assert.equal(report.mismatchedFlows, 1);
  assert.doesNotMatch(JSON.stringify(report), /cdn\.test|private\.js|token=|secret/);
});

test('exact mapping reconciles localized CDN assets while preserving response checks', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  const cdn = 'https://cdn.test/assets/app.js?v=secret';
  const local = '/_ext/cdn.test/assets/app~42.js';
  source.observe(0, request(cdn, 'script', 'asset'));
  bundle.observe(0, request(bundle.origin + local, 'script', 'asset'));
  const assetUrlMap = new Map([[cdn, local]]);
  let report = compareOperationDependencyEvidence(source, bundle, 1, { assetUrlMap });
  assert.equal(report.mismatchedFlows, 0);
  assert.equal(report.sourceExternal, 1);
  assert.equal(report.localizedExternal, 1);
  assert.equal(report.unmappedExternal, 0);
  assert.doesNotMatch(JSON.stringify(report), /cdn\.test|secret|app~/);

  const changed = createOperationDependencyEvidence(bundle.origin);
  changed.observe(0, request(bundle.origin + local, 'script', 'asset', { mime: 'text/plain' }));
  report = compareOperationDependencyEvidence(source, changed, 1, { assetUrlMap });
  assert.equal(report.mismatchedFlows, 1);
  assert.equal(report.mimeMismatch, 1);
});

test('mirror-root alias applies only to listed external static assets', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  const cdn = 'https://cdn.test/assets/app.js';
  const local = '/lm/source.test/_ext/cdn.test/assets/app.js';
  source.observe(0, request(cdn, 'script', 'asset'));
  bundle.observe(0, request(bundle.origin + '/_ext/cdn.test/assets/app.js', 'script', 'asset'));
  const assetUrlMap = new Map([[cdn, local]]);
  let report = compareOperationDependencyEvidence(source, bundle, 1, { assetUrlMap });
  assert.equal(report.mismatchedFlows, 0);
  assert.equal(report.localizedExternal, 1);

  const wrongAsset = createOperationDependencyEvidence(bundle.origin);
  wrongAsset.observe(0, request(bundle.origin + '/_ext/cdn.test/assets/other.js', 'script', 'asset'));
  report = compareOperationDependencyEvidence(source, wrongAsset, 1, { assetUrlMap });
  assert.equal(report.missing, 1);
  assert.equal(report.unexpected, 1);

  const wrongMime = createOperationDependencyEvidence(bundle.origin);
  wrongMime.observe(0, request(bundle.origin + '/_ext/cdn.test/assets/app.js', 'script', 'asset', { mime: 'text/plain' }));
  report = compareOperationDependencyEvidence(source, wrongMime, 1, { assetUrlMap });
  assert.equal(report.mimeMismatch, 1);

  report = compareOperationDependencyEvidence(source, bundle, 1, {
    assetUrlMap: new Map([[cdn, '/lm/source.test/assets/app.js']]),
  });
  assert.equal(report.mismatchedFlows, 1, 'non-_ext paths have no mirror-root alias');
});

test('asset mapping never reconciles API requests or unlisted CDN URLs', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  const cdn = 'https://cdn.test/data.json';
  const local = '/_ext/cdn.test/data.json';
  source.observe(0, request(cdn, 'fetch', 'dynamic-data'));
  bundle.observe(0, request(bundle.origin + local, 'fetch', 'dynamic-data'));
  let report = compareOperationDependencyEvidence(source, bundle, 1, {
    assetUrlMap: new Map([[cdn, local]]),
  });
  assert.equal(report.mismatchedFlows, 1);
  assert.equal(report.localizedExternal, 0);
  assert.equal(report.unmappedExternal, 1);

  const staticSource = createOperationDependencyEvidence(source.origin);
  staticSource.observe(0, request('https://cdn.test/other.js', 'script', 'asset'));
  report = compareOperationDependencyEvidence(staticSource, bundle, 1, {
    assetUrlMap: new Map([[cdn, local]]),
  });
  assert.equal(report.unmappedExternal, 1);
  assert.equal(report.mismatchedFlows, 1);
});

test('asset mapping rejects a target outside the bundle origin', () => {
  const source = createOperationDependencyEvidence('https://source.test');
  const bundle = createOperationDependencyEvidence('http://127.0.0.1:8910');
  assert.throws(() => compareOperationDependencyEvidence(source, bundle, 0, {
    assetUrlMap: new Map([['https://cdn.test/a.js', 'https://another.test/a.js']]),
  }), /invalid asset URL mapping/);
});
