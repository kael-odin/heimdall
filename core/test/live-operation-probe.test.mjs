import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readOperationPlan } from '../src/live/operation-plan.mjs';
import { launchOfflineBrowser } from '../src/live/probe.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

test('offline browser launch retries transient closure without hiding permanent failures', async () => {
  let calls = 0;
  const browser = { marker: 'browser' };
  const launched = await launchOfflineBrowser(async () => {
    calls++;
    if (calls === 1) throw new Error('browserType.launch: Target page, context or browser has been closed');
    return browser;
  }, { sleep: async () => {} });
  assert.equal(launched.browser, browser);
  assert.equal(launched.attempts, 2);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(launchOfflineBrowser(async () => {
    calls++;
    throw new Error("browserType.launch: Executable doesn't exist");
  }, { sleep: async () => {} }), /Executable doesn't exist/);
  assert.equal(calls, 1, 'permanent launch failures must fail closed without a retry');

  calls = 0;
  await assert.rejects(launchOfflineBrowser(async () => {
    calls++;
    throw new Error('browserType.launch: Browser closed');
  }, { sleep: async () => {} }), /Browser closed/);
  assert.equal(calls, 2, 'the retry budget is bounded');
});

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

test('operation plan accepts a safe named session and rejects path-like names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-plan-session-'));
  try {
    const read = plan => {
      writeFileSync(join(dir, 'operation-plan.json'), JSON.stringify(plan));
      return readOperationPlan(dir, 'https://fixture.test', ['/']);
    };
    const good = read({
      version: 1,
      flows: [{ path: '/', sessionName: 'admin', actions: [], expect: [{ type: 'visible', selector: '#x' }] }],
    });
    assert.equal(good.status, 'ok');
    assert.equal(good.flows[0].sessionName, 'admin');
    const bad = read({
      version: 1,
      flows: [{ path: '/', sessionName: '../escape', actions: [], expect: [{ type: 'visible', selector: '#x' }] }],
    });
    assert.equal(bad.status, 'invalid');
    assert.equal(bad.issue, 'invalid-session-name');
    const switched = read({
      version: 1,
      flows: [{ path: '/', sessionName: 'admin',
        actions: [{ type: 'useSession', sessionName: 'guest' }, { type: 'useSession', sessionName: null }],
        expect: [{ type: 'visible', selector: '#x' }] }],
    });
    assert.equal(switched.status, 'ok');
    const badSwitch = read({
      version: 1,
      flows: [{ path: '/', actions: [{ type: 'useSession', sessionName: '../escape' }],
        expect: [{ type: 'visible', selector: '#x' }] }],
    });
    assert.equal(badSwitch.status, 'invalid');
    assert.equal(badSwitch.issue, 'invalid-actions');
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

test('offline operations support anonymous in-flow session switches and fail named sessions', { timeout: 90_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-session-switch-'));
  try {
    const host = 'session-switch.test';
    const site = join(dir, 'workspace', host);
    const live = join(site, 'live');
    const page = join(site, 'pages', 'home');
    const out = join(dir, 'deliverable', 'session-switch');
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `https://${host}/` }));
    writeFileSync(join(live, 'index.html'), '<!doctype html><p id="result">Ready</p>');
    const plan = sessionName => writeFileSync(join(site, 'operation-plan.json'), JSON.stringify({
      version: 1,
      flows: [{ path: '/', actions: [{ type: 'useSession', sessionName }],
        expect: [{ type: 'visible', selector: '#result' }] }],
    }));
    const run = () => spawnSync(process.execPath, [EXPORT, host, '--offline', '--strict', '--root', 'mirror', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 60_000,
    });

    plan(null);
    const anonymous = run();
    assert.equal(anonymous.status, 0, anonymous.stderr + anonymous.stdout);
    const health = JSON.parse(readFileSync(join(out, 'health.json'), 'utf8'));
    assert.equal(health.operationProbe.failed, 0);
    assert.equal(health.operationProbe.flows[0].plannedActions, 3);
    assert.equal(health.operationProbe.flows[0].executedActions, 3);
    assert.deepEqual(health.operationProbe.flows[0].sessionSwitches, [{
      actionIndex: 1, sessionName: null, supported: true,
    }]);

    const accepted = readFileSync(join(out, 'health.json'));
    plan('admin');
    const named = run();
    assert.equal(named.status, 1, named.stderr + named.stdout);
    assert.deepEqual(readFileSync(join(out, 'health.json')), accepted);
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const failure = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(failure.operationProbe.failed, 1);
    assert.ok(failure.operationProbe.failures.some(issue => issue.kind === 'sessionUnsupported' && issue.sessionName === 'admin'));
    assert.equal(failure.strictBlockers.operationFailed, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline operations fail closed for flow-level named sessions', { timeout: 90_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-flow-session-'));
  try {
    const host = 'flow-session.test';
    const site = join(dir, 'workspace', host);
    const live = join(site, 'live');
    const page = join(site, 'pages', 'home');
    const out = join(dir, 'deliverable', 'flow-session');
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `https://${host}/` }));
    writeFileSync(join(live, 'index.html'), '<!doctype html><p id="result">Ready</p>');
    writeFileSync(join(site, 'operation-plan.json'), JSON.stringify({
      version: 1,
      flows: [{ path: '/', sessionName: 'admin', actions: [],
        expect: [{ type: 'visible', selector: '#result' }] }],
    }));
    const run = spawnSync(process.execPath, [EXPORT, host, '--offline', '--strict', '--root', 'mirror', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 60_000,
    });
    assert.equal(run.status, 1, run.stderr + run.stdout);
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(health.operationProbe.failed, 1);
    assert.ok(health.operationProbe.failures.some(issue => issue.kind === 'sessionUnsupported' && issue.sessionName === 'admin'));
    assert.equal(health.strictBlockers.operationFailed, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline operation probe fails when an action opens an untracked popup', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-popup-'));
  try {
    const host = 'popup-fixture.test';
    const site = join(dir, 'workspace', host);
    const page = join(site, 'pages', 'home');
    const out = join(dir, 'deliverable', 'popup-live');
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(join(site, 'live'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `https://${host}/` }));
    writeFileSync(join(site, 'live', 'index.html'), `<!doctype html><button id="open">Open</button>
      <p id="result">Ready</p><script>
      document.querySelector('#open').onclick = () => window.open('/popup', '_blank');
      </script>`);
    writeFileSync(join(site, 'operation-plan.json'), JSON.stringify({
      version: 1, flows: [{ path: '/', actions: [{ type: 'click', selector: '#open' }],
        expect: [{ type: 'text-includes', selector: '#result', value: 'Ready' }] }],
    }));
    const run = spawnSync(process.execPath, [EXPORT, host, '--offline', '--strict', '--root', 'mirror', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 60_000,
    });
    assert.equal(run.status, 1, run.stderr + run.stdout);
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(health.operationProbe.checked, 1);
    assert.equal(health.operationProbe.failed, 1);
    assert.ok(health.operationProbe.failures.some(issue => issue.kind === 'popupUntested'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
