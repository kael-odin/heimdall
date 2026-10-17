import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseCatalogMaintenanceArgs } from '../src/acceptance/catalog-maintenance-cli.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';

const CLI = fileURLToPath(new URL('../src/acceptance/catalog-maintenance-cli.mjs', import.meta.url));
const generation = 'ag-' + randomUUID(), digest = 'a'.repeat(64);
const flags = preview => ['--apply', '--target-schema', '4', '--expected-generation-id', preview.source.generationId,
  '--expected-revision', String(preview.source.revision), '--expected-head-sha256', preview.source.headSha256,
  '--expected-previous-sha256', preview.source.previousSha256 ?? 'none', '--expected-plan-digest', preview.planDigest];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-catalog-maintenance-cli-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function call(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error); return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : JSON.parse(result.stderr) };
}
function facts(root) {
  return Object.fromEntries(readdirSync(root).sort().map(name => { const path = join(root, name), stat = lstatSync(path, { bigint: true }); return [name, { bytes: readFileSync(path), ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }]; }));
}

test('maintenance CLI parses only explicit, complete, unique flags and canonical numeric confirmations', () => {
  assert.deepEqual(parseCatalogMaintenanceArgs(['--preview', '--target-schema', '4']), { action: 'preview', input: { targetSchemaVersion: 4 } });
  assert.deepEqual(parseCatalogMaintenanceArgs(['--create', '--target-schema', '3', '--root', 'a folder']), { action: 'create', input: { targetSchemaVersion: 3 }, root: 'a folder' });
  const source = { generationId: generation, revision: 27, headSha256: digest, previousSha256: null }, good = flags({ source, planDigest: digest });
  assert.equal(parseCatalogMaintenanceArgs(good).input.expectedPreviousSha256, null);
  const invalid = [[], ['--preview'], ['--run', 'anything'], ['--preview', '--target-schema', '3'], ['--preview', '--target-schema', '04'],
    ['--create', '--target-schema', '1'], ['--preview', '--target-schema', '4', '--target-schema', '4'], ['--preview', '--target-schema', '4', '--force', 'true'],
    ['--preview', '--target-schema', '4', '--root'], ['--preview', '--target-schema', '4', '--root', ' '], ['--apply', '--target-schema', '4'],
    ['--preview', '--target-schema', '4', '--expected-head-sha256', digest]];
  for (const value of ['-1', '+1', '01', '1e2', '9007199254740992', '1.0']) { const args = [...good]; args[args.indexOf('--expected-revision') + 1] = value; invalid.push(args); }
  for (const key of ['--expected-generation-id', '--expected-head-sha256', '--expected-plan-digest', '--expected-previous-sha256']) { const args = [...good]; args[args.indexOf(key) + 1] = 'invalid'; invalid.push(args); }
  for (const args of invalid) assert.throws(() => parseCatalogMaintenanceArgs(args), { code: 'INVALID_INPUT', status: 400 });
});

test('real CLI explicitly creates formats 3/4, never overwrites existing metadata and releases only its lock', t => {
  for (const version of [3, 4]) {
    const root = fixture(t), created = call(root, ['--create', '--target-schema', String(version)]);
    assert.equal(created.status, 0); assert.equal(created.value.schemaVersion, version); assert.equal(created.value.executionReady, false); assert.equal(created.stderr, '');
    assert.deepEqual(readdirSync(root), ['catalog.json']); const before = facts(root);
    const rejected = call(root, ['--create', '--target-schema', '4']); assert.equal(rejected.status, 1); assert.equal(rejected.value.code, 'CATALOG_ALREADY_INITIALIZED'); assert.deepEqual(facts(root), before);
  }
});

test('real preview/apply preserves legacy bytes, confirms each published step and never replays a stale confirmation', t => {
  const root = fixture(t), value = { schemaVersion: 1, generationId: 'ag-' + randomUUID(), revision: 0, projects: {}, releases: {}, runBindings: {}, events: [] };
  const raw = Buffer.from(JSON.stringify(value)); writeFileSync(join(root, 'catalog.json'), raw); const before = facts(root);
  const preview = call(root, ['--preview', '--target-schema', '4']); assert.equal(preview.status, 0); assert.equal(preview.value.steps.length, 3); assert.deepEqual(facts(root), before);
  const again = call(root, ['--preview', '--target-schema', '4']); assert.deepEqual(again.value, preview.value);
  const applied = call(root, flags(preview.value)); assert.equal(applied.status, 0); assert.equal(applied.value.schemaVersion, 4); assert.equal(applied.value.completedSteps.length, 3);
  assert.equal(Object.hasOwn(applied.value, 'catalog'), false); assert.equal(applied.value.executionReady, false); assert.equal(JSON.stringify(applied.value).includes('targetUrl'), false);
  const source = readdirSync(root).find(name => name.startsWith('catalog.v1.')); assert.deepEqual(readFileSync(join(root, source)), raw); const final = facts(root);
  const stale = call(root, flags(preview.value)); assert.equal(stale.status, 1); assert.equal(stale.value.code, 'STALE_REVISION'); assert.deepEqual(facts(root), final);
  const noopPreview = call(root, ['--preview', '--target-schema', '4']), noop = call(root, flags(noopPreview.value));
  assert.equal(noop.status, 0); assert.equal(noop.value.changed, false); assert.deepEqual(noop.value.completedSteps, []); assert.deepEqual(facts(root), final);
  assert.equal(readdirSync(root).some(name => /owner|recovery|dispatch|jobs|^ac-/.test(name)), false);
});

test('a live engine owner refuses every maintenance action without touching its lock or metadata', t => {
  const root = fixture(t), owner = acquireAcceptanceOwner({ root }); t.after(() => owner.release()); const before = facts(root);
  for (const action of ['--preview', '--create']) {
    const result = call(root, [action, '--target-schema', '4']); assert.equal(result.status, 1); assert.equal(result.value.code, 'ACCEPTANCE_OWNER_UNAVAILABLE'); assert.deepEqual(facts(root), before);
  }
});

test('invalid commands acquire nothing and malformed metadata errors contain no private path, parser text or stack', t => {
  const parent = fixture(t), missing = join(parent, 'not-created'); const invalid = call(missing, ['--preview', '--target-schema', '3']);
  assert.equal(invalid.status, 1); assert.equal(invalid.value.code, 'INVALID_INPUT'); assert.equal(existsSync(missing), false);
  const root = fixture(t); writeFileSync(join(root, 'catalog.json'), '{PRIVATE_CORRUPT_SOURCE'); const before = facts(root), failed = call(root, ['--preview', '--target-schema', '4']);
  assert.equal(failed.status, 1); assert.equal(failed.value.code, 'CATALOG_UNAVAILABLE'); assert.deepEqual(facts(root), before);
  for (const secret of [root, 'PRIVATE_CORRUPT_SOURCE', 'SyntaxError', ' at ', 'ENOENT']) assert.equal(failed.stderr.includes(secret), false);
});
