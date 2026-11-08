import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectConsole, inspectDependencies, inspectMcp, openExternal,
} from '../src/agent/installation.mjs';
import { executeSetup } from '../src/agent/commands/setup.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

const readyDependencies = () => [
  { id: 'core', root: 'core', ready: true, missing: [], checked: 5 },
  { id: 'console', root: 'console', ready: true, missing: [], checked: 5 },
  { id: 'mcp', root: 'mcp', ready: true, missing: [], checked: 3 },
];
const readyConsole = { ready: true, reason: 'ready', dist: '/repo/console/dist' };
const readyMcp = { ready: true, missing: [], server: '/repo/packages/mcp/bin/heimdall-mcp.mjs', artifact: '/repo/plugin/server/heimdall-mcp.mjs' };
const readyEngineProbe = () => ({ base: 'http://127.0.0.1:8912', reachable: true, sameRoot: true, status: { ok: true } });
const readyUi = async () => ({ ok: true, status: 200, text: async () => '<title>Heimdall · Site Atlas</title>' });

function fakePnpm(calls) {
  return (args) => {
    calls.push(args);
    if (args[0] === '--version') return { status: 0, stdout: '11.28.10\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('setup dependencies are checked by direct package, not by a stale node_modules directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-deps-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { alpha: '1.0.0', '@scope/beta': '1.0.0' },
      devDependencies: { gamma: '1.0.0' },
    }));
    let states = inspectDependencies({ roots: [{ id: 'sample', root }] });
    assert.deepEqual(states[0].missing, ['@scope/beta', 'alpha', 'gamma']);
    mkdirSync(join(root, 'node_modules', '@scope', 'beta'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'gamma'), { recursive: true });
    states = inspectDependencies({ roots: [{ id: 'sample', root }] });
    assert.equal(states[0].ready, true);
    assert.deepEqual(states[0].missing, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('console and MCP checks distinguish ready, stale and missing artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-artifacts-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<div id="app"></div>');
    writeFileSync(join(root, 'vite.config.js'), 'export default {}');
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    writeFileSync(join(root, 'src', 'main.js'), 'console.log(1)');
    writeFileSync(join(dist, 'index.html'), '<title>Heimdall</title>');
    const old = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-01-02T00:00:00Z');
    for (const file of ['index.html', 'vite.config.js', 'package.json', 'pnpm-lock.yaml', 'src/main.js']) utimesSync(join(root, file), old, old);
    utimesSync(join(dist, 'index.html'), newer, newer);
    assert.equal(inspectConsole({ root, dist }).ready, true);
    utimesSync(join(root, 'src', 'main.js'), new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
    assert.equal(inspectConsole({ root, dist }).reason, 'stale');

    const server = join(root, 'heimdall-mcp.mjs');
    const artifact = join(root, 'plugin.mjs');
    assert.equal(inspectMcp({ server, artifact }).ready, false);
    writeFileSync(server, '');
    writeFileSync(artifact, '');
    assert.equal(inspectMcp({ server, artifact }).ready, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('openExternal uses a direct platform launcher without shell interpolation', () => {
  let invocation = null;
  const child = new EventEmitter();
  child.unref = () => { invocation.unref = true; };
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    return child;
  };
  openExternal('http://127.0.0.1:8900/', { platform: 'win32', spawnProcess });
  assert.equal(invocation.command, 'explorer.exe');
  assert.deepEqual(invocation.args, ['http://127.0.0.1:8900/']);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.unref, true);
});

test('setup is idempotent when every component is healthy', async () => {
  const calls = [];
  const io = {
    runPnpm: fakePnpm(calls),
    inspectDependencies: readyDependencies,
    inspectChromium: async () => ({ ready: true, reason: 'ready', executable: 'C:/chrome.exe' }),
    inspectConsole: () => readyConsole,
    inspectMcp: () => readyMcp,
    exists: () => true,
    probeEngine: readyEngineProbe,
    fetch: readyUi,
    readEngineState: () => null,
    log: () => {},
  };
  const first = await executeSetup({ port: 8912, noConnect: true, open: false }, io);
  const second = await executeSetup({ port: 8912, noConnect: true, open: false }, io);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.result.engine.status, 'reused');
  assert.equal(second.result.engine.status, 'reused');
  assert.match(first.result.note, /直连 MCP 可在没有常驻引擎时执行 QA/);
  assert.match(first.result.note, /代理式 MCP 和控制台需要本机 :8912 引擎/);
  assert.deepEqual(calls, [['--version'], ['--version']]);
  assert.ok(first.result.steps.every(step => step.status === 'reused' || step.status === 'skipped'));
});

test('setup installs only the dependency tree reported missing', async () => {
  const calls = [];
  let checks = 0;
  const io = {
    runPnpm: fakePnpm(calls),
    inspectDependencies: () => (++checks === 1
      ? [{ id: 'core', root: 'core', ready: false, missing: ['playwright'], checked: 5 }, ...readyDependencies().slice(1)]
      : readyDependencies()),
    inspectChromium: async () => ({ ready: true, reason: 'ready', executable: 'C:/chrome.exe' }),
    inspectConsole: () => readyConsole,
    inspectMcp: () => readyMcp,
    exists: () => true,
    probeEngine: readyEngineProbe,
    fetch: readyUi,
    readEngineState: () => null,
    log: () => {},
  };
  const env = await executeSetup({ port: 8912, noConnect: true, open: false, registry: 'https://registry.npmjs.org/' }, io);
  assert.equal(env.ok, true);
  assert.deepEqual(calls, [
    ['--version'],
    ['install', '--frozen-lockfile', '--registry', 'https://registry.npmjs.org'],
  ]);
  assert.equal(env.result.steps.find(step => step.id === 'dependencies').status, 'installed');
});

test('setup trusts the installed Claude Code plugin and connects tier-one clients by default', async () => {
  const calls = [];
  const io = {
    runPnpm: fakePnpm([]),
    inspectDependencies: readyDependencies,
    inspectChromium: async () => ({ ready: true, reason: 'ready', executable: 'C:/chrome.exe' }),
    inspectConsole: () => readyConsole,
    inspectMcp: () => readyMcp,
    exists: () => true,
    probeEngine: readyEngineProbe,
    fetch: readyUi,
    readEngineState: () => null,
    inspectClientConfigs: () => [
      { client: 'claude-code', label: 'Claude Code', installed: true, configured: true, pluginVersion: '0.2.2' },
      { client: 'claude-desktop', label: 'Claude Desktop', installed: true, configured: true },
      { client: 'codex', label: 'Codex', installed: true, configured: true },
      { client: 'cursor', label: 'Cursor', installed: true, configured: false },
    ],
    connectClient: async argv => { calls.push(argv[0]); return { ok: true, result: { changed: false, selfTest: { engine: 'ok' } } }; },
    log: () => {},
  };
  const env = await executeSetup({ port: 8912, open: false }, io);
  assert.equal(env.ok, true);
  assert.deepEqual(calls, ['claude-desktop', 'codex']);
  assert.equal(env.result.clients.find(client => client.client === 'claude-code').managedBy, 'plugin');
  assert.equal(env.result.steps.find(step => step.id === 'clients').status, 'configured');
});

test('setup refuses an occupied port that is not the matching Heimdall engine', async () => {
  const io = {
    runPnpm: fakePnpm([]),
    inspectDependencies: readyDependencies,
    inspectChromium: async () => ({ ready: true, reason: 'ready', executable: 'C:/chrome.exe' }),
    inspectConsole: () => readyConsole,
    inspectMcp: () => readyMcp,
    exists: () => true,
    probeEngine: () => null,
    portAvailable: async () => false,
    readEngineState: () => null,
    log: () => {},
  };
  const env = await executeSetup({ port: 8912, noConnect: true, open: false }, io);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'engine_unreachable');
  assert.match(env.error.message, /其它程序占用/);
});

test('setup --json rejects bad input with one final envelope and exit 2', () => {
  const result = spawnSync(process.execPath, [CLI, 'setup', '--port', '1', '--json', '--no-open', '--no-connect'], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 2);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).error.code, 'invalid_args');
});
