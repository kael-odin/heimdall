import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveSnapshotCandidates, liveSnapshotPath } from '../src/live/live-path.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const BUILD = fileURLToPath(new URL('../src/crawler/build_live.mjs', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

test('live snapshot paths preserve legacy pages and isolate query variants', () => {
  assert.equal(liveSnapshotPath('/', ''), 'index.html');
  assert.equal(liveSnapshotPath('/list/', ''), 'list/index.html');
  assert.equal(liveSnapshotPath('/list/', '?page=1'), liveSnapshotPath('/list', '?page=1'));
  assert.notEqual(liveSnapshotPath('/list', '?page=1'), liveSnapshotPath('/list', '?page=2'));
  assert.deepEqual(liveSnapshotCandidates('/list', '?page=3'), [liveSnapshotPath('/list', '?page=3')]);
  assert.deepEqual(liveSnapshotCandidates('/app.js', '?v=1'), [liveSnapshotPath('/app.js', '?v=1'), 'app.js']);
});

async function startBundle(out) {
  const child = spawn(process.execPath, [join(out, 'serve.mjs'), '--port', '0', '--host', '127.0.0.1', '--offline'], {
    cwd: out, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bundle startup timed out')), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('bundle exited: ' + code)); });
      child.on('message', message => {
        if (message?.kind !== 'heimdall-live-ready') return;
        clearTimeout(timer);
        resolve(message.port);
      });
    });
  } catch (error) { child.kill(); throw error; }
  return { child, base: `http://127.0.0.1:${port}` };
}

test('build, export and offline server keep query pages distinct and gate missing variants', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-live-query-'));
  const host = 'fixture.test';
  const site = join(dir, 'workspace', host);
  const out = join(dir, 'deliverable', 'fixture-live');
  let child;
  try {
    const page = (name, url, marker, link = '') => {
      const base = join(site, 'pages', name);
      mkdirSync(join(base, 'clone', 'styles'), { recursive: true });
      writeFileSync(join(base, 'manifest.json'), JSON.stringify({ target: url }));
      writeFileSync(join(base, 'dom.html'), `<html><head></head><body>${marker}${link ? `<a href="${link}">next</a>` : ''}</body></html>`);
      writeFileSync(join(base, 'clone', 'index.html'), '<html>clone</html>');
      writeFileSync(join(base, 'clone', 'styles', 'cssom.css'), 'body{}');
    };
    page('home', 'https://fixture.test/', 'HOME');
    page('list', 'https://fixture.test/list', 'PLAIN');
    page('page1', 'https://fixture.test/list?page=1', 'PAGE_ONE', '/list?page=2');
    page('page2', 'https://fixture.test/list?page=2', 'PAGE_TWO', '/list?page=1');
    page('encoded', 'https://fixture.test/caf%C3%A9?lang=fr', 'ENCODED_PATH');
    const env = { ...process.env, HEIMDALL_DATA_DIR: dir, HEIMDALL_SELF_URL: 'http://127.0.0.1:1' };
    const run = (script, ...args) => spawnSync(process.execPath, [script, host, ...args], { cwd: CORE, env, encoding: 'utf8', timeout: 20_000 });

    const built = run(BUILD);
    assert.equal(built.status, 0, built.stderr + built.stdout);
    const queryOne = join(site, 'live', liveSnapshotPath('/list', '?page=1'));
    const queryTwo = join(site, 'live', liveSnapshotPath('/list', '?page=2'));
    assert.match(readFileSync(queryOne, 'utf8'), /PAGE_ONE/);
    assert.match(readFileSync(queryTwo, 'utf8'), /PAGE_TWO/);
    assert.match(readFileSync(join(site, 'live', 'list', 'index.html'), 'utf8'), /PLAIN/);
    writeFileSync(join(site, 'live', 'app.js'), 'local-script');

    const exported = run(EXPORT, '--offline', '--strict', '--root', 'mirror', '--out', out);
    assert.equal(exported.status, 0, exported.stderr + exported.stdout);
    const health = JSON.parse(readFileSync(join(out, 'health.json'), 'utf8'));
    assert.equal(health.pages, 5);
    assert.equal(health.liveMissing, 0);
    assert.equal(health.links.missing, 0);

    const bundle = await startBundle(out);
    child = bundle.child;
    for (const [suffix, marker] of [['', 'PLAIN'], ['?page=1', 'PAGE_ONE'], ['?page=2', 'PAGE_TWO']]) {
      const response = await fetch(bundle.base + '/lm/' + host + '/list' + suffix);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(marker));
    }
    assert.equal((await fetch(bundle.base + '/lm/' + host + '/list?page=3')).status, 404);
    assert.match(await (await fetch(bundle.base + '/list?page=2')).text(), /PAGE_TWO/);
    assert.match(await (await fetch(bundle.base + '/list/?page=2')).text(), /PAGE_TWO/);
    assert.equal((await fetch(bundle.base + '/list?page=3')).status, 404);
    assert.match(await (await fetch(bundle.base + '/caf%C3%A9?lang=fr')).text(), /ENCODED_PATH/);
    assert.equal(await (await fetch(bundle.base + '/lm/' + host + '/app.js?v=1')).text(), 'local-script');

    rmSync(queryTwo);
    const strict = run(EXPORT, '--offline', '--strict', '--out', out);
    assert.equal(strict.status, 1, strict.stderr + strict.stdout);
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const failedHealth = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.deepEqual(failedHealth.missingLivePages, ['page2']);
    assert.equal(failedHealth.strictBlockers.missingLivePages, 1);
    assert.ok(failedHealth.strictBlockers.missingLinks >= 1);
    assert.ok(existsSync(join(out, 'site', 'live', liveSnapshotPath('/list', '?page=2'))), 'previous bundle remains intact');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
