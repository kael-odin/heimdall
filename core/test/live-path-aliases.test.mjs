import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probePublicPathAliases, rewritePathAliasLinks } from '../src/live/path-aliases.mjs';

const HOST = 'x.test';
const ORIGIN = `https://${HOST}`;

test('path aliases preserve source 404 and resolve verified local redirects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-path-aliases-'));
  const liveDir = join(dir, 'live');
  try {
    mkdirSync(join(liveDir, 'guide', 'features'), { recursive: true });
    writeFileSync(join(liveDir, 'guide', 'features', 'index.html'), '<!doctype html><title>Features</title>');
    writeFileSync(join(liveDir, 'index.html'), '<!doctype html><head><base href="/lm/x.test/">'
      + '</head><body><a href="./features">Features</a><a href="/missing#gone">Missing</a></body>');
    const requests = [];
    const fetchImpl = async url => {
      requests.push(url);
      const path = new URL(url).pathname;
      if (path === '/features') {
        return new Response(null, { status: 301, headers: { location: '/guide/features/' } });
      }
      if (path === '/missing') return new Response('not found', { status: 404 });
      if (path === '/external') {
        return new Response(null, { status: 301, headers: { location: 'https://other.test/page' } });
      }
      throw new Error('unexpected URL');
    };
    const { report, rewriteMap } = await probePublicPathAliases({
      liveDir, host: HOST, origin: ORIGIN,
      targets: ['/features', '/missing', '/missing', '/external'], fetchImpl,
    });
    assert.equal(report.status, 'unexpected-detected');
    assert.equal(report.targets, 3);
    assert.equal(report.checked, 3);
    assert.equal(report.resolvedLocal, 1);
    assert.equal(report.expectedMissing, 1);
    assert.equal(report.expectedMissingReferences, 2);
    assert.equal(report.unexpected, 1);
    assert.equal(report.unexpectedReferences, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.untested, 0);
    assert.deepEqual(report.details.map(item => item.disposition).sort(),
      ['expected-missing', 'external-redirect', 'resolved-local']);
    assert.equal(rewriteMap.get('/features'), '/lm/x.test/guide/features/');
    assert.equal(rewriteMap.get('/missing'), '/lm/x.test/missing');
    assert.equal(rewriteMap.get('/external'), '/lm/x.test/external');

    const rewritten = rewritePathAliasLinks({ liveDir, host: HOST, origin: ORIGIN, map: rewriteMap });
    assert.equal(rewritten.files, 1);
    assert.equal(rewritten.rewrites, 2);
    const html = readFileSync(join(liveDir, 'index.html'), 'utf8');
    assert.match(html, /href="\/lm\/x\.test\/guide\/features\/"/);
    assert.match(html, /href="\/lm\/x\.test\/missing#gone"/);
    assert.deepEqual(requests.map(url => new URL(url).pathname), ['/features', '/missing', '/external']);
    assert.doesNotMatch(JSON.stringify(report), /other\.test|\/page/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
