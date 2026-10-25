/**
 * 能力注册表与 CLI 代理模式（E1-01 ~ E1-03、E1-06、E3-01、E3-03、E3-05、E3-06）
 *
 * 不开浏览器、不需要引擎：用临时数据根跑读类命令。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, annotationsOf, defineCapability, describeCapabilities, getCapability } from '../src/agent/registry/index.mjs';
import { parseArgs, argsFor } from '../src/agent/cli.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const EXPECTED = ['overview', 'site', 'brief', 'artifact', 'compare', 'jobs', 'clone', 'doctor'];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-agent-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  mkdirSync(join(page, 'clone'), { recursive: true });
  writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><body><h1>x</h1></body>');
  writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://example.test/' }));
  return root;
}

const run = (args, root) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 60_000, env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_API: 'http://127.0.0.1:9' },
});

test('registry: the eight core capabilities, in a fixed order, each well formed', () => {
  assert.deepEqual(CAPABILITIES.map(c => c.id), EXPECTED);
  for (const c of describeCapabilities()) {
    assert.equal(c.tool, `heimdall_${c.id}`);
    assert.equal(c.input.type, 'object');
    assert.ok(c.description.length >= 120, `${c.id} has a model-facing description`);
  }
  assert.equal(getCapability('heimdall_brief').id, 'brief');
  assert.equal(getCapability('nope'), null);
});

test('registry: effects map to MCP annotations (readOnly only for pure read)', () => {
  const a = Object.fromEntries(CAPABILITIES.map(c => [c.id, annotationsOf(c)]));
  for (const id of ['overview', 'site', 'brief', 'artifact', 'jobs', 'doctor']) assert.equal(a[id].readOnlyHint, true, id);
  assert.equal(a.compare.readOnlyHint, false);
  assert.equal(a.clone.openWorldHint, true);
  assert.equal(a.clone.destructiveHint, false);
});

test('registry: malformed definitions are rejected', () => {
  const base = { id: 'x_ok', title: 't', description: 'd', effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap', input: { type: 'object' }, handler: () => {} };
  assert.ok(defineCapability(base));
  assert.throws(() => defineCapability({ ...base, effects: ['teleport'] }), /bad effects/);
  assert.throws(() => defineCapability({ ...base, scope: 'root' }), /bad scope/);
  assert.throws(() => defineCapability({ ...base, id: 'Bad-Id' }), /id invalid/);
  assert.throws(() => defineCapability({ ...base, handler: undefined }), /missing handler/);
});

test('cli: argument parsing maps flags to capability inputs', () => {
  assert.deepEqual(argsFor('brief', parseArgs(['example.test', 'home', '--section-id', 'sec-hero-abcdef'])),
    { siteId: 'example.test', page: 'home', detail: 'full', sectionId: 'sec-hero-abcdef' });
  const c = argsFor('compare', parseArgs(['--url', 'http://127.0.0.1:5199/', '--viewports', '375,1440', '--gate']));
  assert.deepEqual(c.candidate, { url: 'http://127.0.0.1:5199/' });
  assert.deepEqual(c.viewports, [375, 1440]);
  assert.equal(c.requireGate, true);
  assert.deepEqual(argsFor('jobs', parseArgs(['wait', 'job_abcdefgh', '--wait-ms', '5000'])), { action: 'wait', jobId: 'job_abcdefgh', waitMs: 5000 });
});

test('cli --json: stdout ends with one envelope line; exit codes follow the table', () => {
  const root = tempRoot();
  try {
    const o = run(['overview', '--json'], root);
    assert.equal(o.status, 0, o.stderr);
    const lines = o.stdout.trim().split('\n');
    const env = JSON.parse(lines.at(-1));
    assert.equal(env.ok, true);
    assert.deepEqual(env.result.sites.map(s => s.siteId), ['example.test']);
    assert.equal(env.result.engine.status, 'unreachable', 'read commands work without an engine');
    assert.ok(env.meta.requestId && env.summary && Array.isArray(env.nextActions));

    const missing = run(['site', 'nope.test', '--json'], root);
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout.trim().split('\n').at(-1)).error.code, 'not_found');

    const bad = run(['brief', 'example.test', 'home', '--detail', 'everything', '--json'], root);
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stdout.trim().split('\n').at(-1)).error.code, 'invalid_args');

    const ref = run(['brief', 'example.test', 'other', '--json'], root);
    assert.equal(ref.status, 2);
    assert.equal(JSON.parse(ref.stdout.trim().split('\n').at(-1)).error.code, 'reference_missing');

    const formal = run(['compare', 'example.test', 'home', '--url', 'http://127.0.0.1:9/', '--mode', 'formal', '--json'], root);
    assert.equal(formal.status, 2, 'formal mode is not delivered in Ph1 and says so');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cli: --help --json lists agent, cli-only and legacy commands', () => {
  const r = spawnSync(process.execPath, [CLI, '--help', '--json'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0);
  const env = JSON.parse(r.stdout.trim());
  assert.deepEqual(env.result.agentCommands.map(c => c.command), EXPECTED);
  assert.ok(env.result.cliOnly.some(c => c.command === 'rebuild'));
  assert.ok(env.result.legacyCommands.some(c => c.command === 'forge'), 'old commands stay available (E3-06)');
  assert.equal(env.result.exitCodes['4'], 'queued, busy or wait timed out');
});
