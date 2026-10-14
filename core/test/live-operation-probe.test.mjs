import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readOperationPlan } from '../src/live/operation-plan.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

test('operation plan requires bundled paths and observable postconditions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-plan-'));
  try {
    const read = () => readOperationPlan(dir, 'https://fixture.test', ['/']);
    assert.equal(read().status, 'missing');
    writeFileSync(join(dir, 'operation-plan.json'), JSON.stringify({
      version: 1, flows: [{ path: '/unknown', actions: [], expect: [{ type: 'visible', selector: '#done' }] }],
    }));
    assert.deepEqual(read(), { status: 'invalid', issue: 'unbundled-route', flows: [] });
    writeFileSync(join(dir, 'operation-plan.json'), JSON.stringify({
      version: 1, flows: [{ path: '/', actions: [{ type: 'click', selector: '#load' }], expect: [] }],
    }));
    assert.deepEqual(read(), { status: 'invalid', issue: 'invalid-assertions', flows: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict export replays declared operations offline and preserves accepted bundle on failure', { timeout: 90_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-export-'));
  try {
    const host = 'fixture.test';
    const site = join(dir, 'workspace', host);
    const live = join(site, 'live');
    const page = join(site, 'pages', 'home');
    const out = join(dir, 'deliverable', 'fixture-live');
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://fixture.test/' }));
    writeFileSync(join(live, 'index.html'), `<!doctype html><input id="query"><button id="load">Load</button>
      <p id="result" hidden>Loaded</p><script>
      document.querySelector('#load').onclick = () => fetch('/api/data').then(r => {
        if (!r.ok) throw Error('missing data'); return r.json();
      }).then(() => { document.querySelector('#result').hidden = false; }).catch(() => {});
      </script>`);
    const run = () => spawnSync(process.execPath, [EXPORT, host, '--offline', '--strict', '--root', 'mirror', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 60_000,
    });

    const browsingOnly = run();
    assert.equal(browsingOnly.status, 0, browsingOnly.stderr + browsingOnly.stdout);
    const first = JSON.parse(readFileSync(join(out, 'health.json'), 'utf8'));
    assert.equal(first.operationPlan.status, 'missing');
    assert.equal(first.operationProbe.status, 'not-configured');
    const accepted = readFileSync(join(out, 'health.json'));

    writeFileSync(join(site, 'operation-plan.json'), JSON.stringify({
      version: 1,
      flows: [{
        path: '/',
        actions: [
          { type: 'fill', selector: '#query', value: 'private-search-value' },
          { type: 'click', selector: '#load' },
        ],
        expect: [{ type: 'visible', selector: '#result' }],
      }],
    }));
    const failed = run();
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    assert.deepEqual(readFileSync(join(out, 'health.json')), accepted);
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const failure = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(failure.browserProbe.failed, 0);
    assert.equal(failure.operationProbe.checked, 1);
    assert.equal(failure.operationProbe.failed, 1);
    assert.equal(failure.strictBlockers.operationFailed, 1);
    assert.ok(failure.operationProbe.failures.some(item => item.kind === 'http' && item.status === 404));
    assert.doesNotMatch(JSON.stringify(failure), /private-search-value|#query|#load|#result/);

    mkdirSync(join(live, 'api'), { recursive: true });
    writeFileSync(join(live, 'api', 'data'), '{"ok":true}');
    const succeeded = run();
    assert.equal(succeeded.status, 0, succeeded.stderr + succeeded.stdout);
    const health = JSON.parse(readFileSync(join(out, 'health.json'), 'utf8'));
    assert.equal(health.operationProbe.checked, 1);
    assert.equal(health.operationProbe.failed, 0);
    assert.equal(health.operationProbe.untested, 0);
    assert.equal(health.operationProbe.flows[0].categories['dynamic-data'], 1);
    assert.equal(health.strictBlockers.operationFailed, 0);
    assert.ok(existsSync(join(out, 'site', 'live', 'api', 'data')));
    assert.equal(existsSync(join(out, 'operation-plan.json')), false);
    assert.doesNotMatch(readFileSync(join(out, 'health.json'), 'utf8'), /private-search-value|#query|#load|#result/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
