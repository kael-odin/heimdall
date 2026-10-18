import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '../../../..'), OUT = import.meta.dirname;
const SOURCE = resolve(ROOT, 'core/workspace/_runs/defect-ticket-decisions-console-smoke-20261018T093910120');
const FIXTURE = join(OUT, 'ingress-order-unit-fixture');
const verifier = join(ROOT, 'core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = (root, name) => JSON.parse(fs.readFileSync(join(root, name), 'utf8'));
const write = (root, name, value) => fs.writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n');
const lines = (root, name) => fs.readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
function tree(root) {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = join(root, entry.name);
    if (entry.isDirectory()) return Object.entries(tree(file)).map(([name,value]) => [entry.name + '/' + name,value]);
    const bytes = fs.readFileSync(file); return [[entry.name, { bytes: bytes.length, sha256: sha(bytes) }]];
  }));
}
const results = [];
function verify(label, expected) {
  const result = spawnSync(process.execPath, [verifier, FIXTURE], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
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
const names = ['case-A/ingress-prefix.json','case-A/ingress-complete.json','case-A/ingress-at-deny-ack.json','case-B/ingress-at-held-deny.json','ingress.jsonl'];
const originalBytes = new Map(names.map(name => [name, fs.readFileSync(join(SOURCE, name))]));
const prefix = read(SOURCE, names[0]), traceId = prefix[0].traceId, splitAt = prefix.at(-1).bytes;
const events = read(SOURCE, 'case-A/relay-events.json'), event = kind => events.find(value => value.event === kind);
const iso = time => new Date(time).toISOString();
function reset() {
  for (const [name,bytes] of originalBytes) fs.writeFileSync(join(FIXTURE, name), bytes);
  for (const name of ['implementation-inputs-before.json','implementation-inputs-after.json']) write(FIXTURE, name, current);
}
function moveTrace(transform) {
  for (const name of names.slice(0,3)) write(FIXTURE, name, read(FIXTURE, name).map(value => transform(value)));
  fs.writeFileSync(join(FIXTURE, 'ingress.jsonl'), lines(FIXTURE, 'ingress.jsonl').map(value => value.traceId === traceId ? transform(value) : value).map(JSON.stringify).join('\n') + '\n');
}
// These are copied offline artifacts with rebound manifests, solely for verifier
// negative controls. They are not evidence that the current bundle ran in Browser.
reset(); verify('new-order-positive-offline-fixture', 0);
for (const [label, mutate] of [
  ['prefix-snapshot-diverges', () => { const values=read(FIXTURE,names[0]); values.at(-1).at=iso(Date.parse(values.at(-1).at)+1); write(FIXTURE,names[0],values); }],
  ['deny-ack-snapshot-diverges', () => { const values=read(FIXTURE,names[2]); values.at(-1).at=iso(Date.parse(values.at(-1).at)+1); write(FIXTURE,names[2],values); }],
  ['held-deny-snapshot-diverges', () => { const values=read(FIXTURE,names[3]); values.at(-1).at=iso(Date.parse(values.at(-1).at)+1); write(FIXTURE,names[3],values); }],
  ['prefix-year2099', () => moveTrace(value => ['request','data'].includes(value.event) ? {...value,at:'2099-01-01T00:00:00.000Z'} : value)],
  ['prefix-after-controlled-response', () => moveTrace(value => value.event==='data' && value.bytes===splitAt ? {...value,at:iso(Date.parse(event('controlled-http-502').at)+1)} : value)],
  ['end-before-original-tail', () => moveTrace(value => value.event==='end' ? {...value,at:iso(Date.parse(event('original-tail-release').at)-1)} : value)],
  ['end-after-original-response', () => moveTrace(value => ['end','close'].includes(value.event) ? {...value,at:iso(Date.parse(event('original-upstream-response').at)+1)} : value)],
  ['noncanonical-ISO-time', () => moveTrace(value => value.event==='request' ? {...value,at:'2026-10-18 01:39:44Z'} : value)],
  ['stream-time-backwards', () => moveTrace(value => value.event==='data' ? {...value,at:iso(Date.parse(prefix[0].at)-1)} : value)],
]) { reset(); mutate(); verify('new-order-' + label, 1); }
reset();
write(OUT, 'ingress-order-cases-results.json', { evidenceLevel:'offline-artifact-verifier-negative-controls-only', source:SOURCE, fixture:FIXTURE, results });
console.log(JSON.stringify({ evidenceLevel:'offline-artifact-verifier-negative-controls-only', results }, null, 2));
