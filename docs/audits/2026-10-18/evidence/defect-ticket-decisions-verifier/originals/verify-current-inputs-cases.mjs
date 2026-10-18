import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '../../../..'), OUT = import.meta.dirname;
const SOURCE = resolve(ROOT, 'core/workspace/_runs/defect-ticket-decisions-console-smoke-20261018T093910120');
const FIXTURE = join(OUT, 'current-inputs-unit-fixture-v2');
const verifier = join(ROOT, 'core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = (root, name) => JSON.parse(fs.readFileSync(join(root, name), 'utf8'));
const write = (root, name, value) => fs.writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n');
function tree(root) {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = join(root, entry.name);
    if (entry.isDirectory()) return Object.entries(tree(file)).map(([name,value]) => [entry.name + '/' + name,value]);
    const bytes = fs.readFileSync(file); return [[entry.name, { bytes: bytes.length, sha256: sha(bytes) }]];
  }));
}
const results = [];
function verify(label, root, expected) {
  const result = spawnSync(process.execPath, [verifier, root], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  fs.writeFileSync(join(OUT, label + '.stdout.log'), result.stdout ?? ''); fs.writeFileSync(join(OUT, label + '.stderr.log'), result.stderr ?? '');
  const value = { label, exitCode: result.status, expected, matched: result.status === expected };
  results.push(value); assert.equal(result.status, expected, label + ': ' + result.stderr); return value;
}
assert(!fs.existsSync(FIXTURE), 'Use a fresh offline fixture directory.');
fs.cpSync(SOURCE, FIXTURE, { recursive: true, filter: source => !relative(SOURCE, source).split(sep).includes('chromium-profile') });
const prior = read(SOURCE, 'implementation-inputs-before.json');
const current = { sources: Object.fromEntries(Object.keys(prior.sources).map(name => {
  const bytes = fs.readFileSync(resolve(ROOT, 'core', name)); return [name, { bytes: bytes.length, sha256: sha(bytes) }];
})), consoleBundle: tree(join(ROOT, 'console/dist')) };
const manifests = ['implementation-inputs-before.json','implementation-inputs-after.json'];
const reset = () => manifests.forEach(name => write(FIXTURE, name, current));
// This artificial fixture exercises the input validator only. Rebinding these
// copies is not a real Browser run and must never be reported as current D6 smoke.
reset(); verify('new-offline-current-inputs-positive', FIXTURE, 0);
verify('new-real-run-stale-inputs', SOURCE, 1);
for (const [label, mutate] of [
  ['stale-source-sha', value => { value.sources['src/acceptance/defect-ticket-store.mjs'].sha256 = '0'.repeat(64); }],
  ['stale-source-bytes', value => { value.sources['src/acceptance/defect-ticket-store.mjs'].bytes += 1; }],
  ['same-count-wrong-source-path', value => { value.sources['src/acceptance/not-real.mjs'] = value.sources['src/acceptance/defect-ticket-store.mjs']; delete value.sources['src/acceptance/defect-ticket-store.mjs']; }],
  ['malformed-source-sha', value => { value.sources['src/acceptance/defect-ticket-store.mjs'].sha256 = 'not-a-sha'; }],
  ['negative-source-bytes', value => { value.sources['src/acceptance/defect-ticket-store.mjs'].bytes = -1; }],
  ['fractional-source-bytes', value => { value.sources['src/acceptance/defect-ticket-store.mjs'].bytes = 1.5; }],
  ['unexpected-source-record-field', value => { value.sources['src/acceptance/defect-ticket-store.mjs'].extra = true; }],
  ['stale-bundle-sha', value => { value.consoleBundle['index.html'].sha256 = '0'.repeat(64); }],
  ['missing-bundle-file', value => { delete value.consoleBundle['index.html']; }],
  ['empty-bundle', value => { value.consoleBundle = {}; }],
  ['mismatched-before-after', value => { value.sources['src/acceptance/defect-ticket-store.mjs'].bytes += 1; }],
]) {
  reset(); const value = structuredClone(current); mutate(value);
  write(FIXTURE, manifests[0], value);
  if (label !== 'mismatched-before-after') write(FIXTURE, manifests[1], value);
  verify('new-' + label, FIXTURE, 1);
}
reset();
write(OUT, 'current-inputs-cases-results.json', { evidenceLevel: 'offline-artifact-input-validator-only', source: SOURCE, fixture: FIXTURE, results });
console.log(JSON.stringify({ evidenceLevel: 'offline-artifact-input-validator-only', results }, null, 2));
