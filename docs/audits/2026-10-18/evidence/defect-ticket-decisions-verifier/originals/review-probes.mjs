import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SOURCE = resolve(ROOT, 'core/workspace/_runs/defect-ticket-decisions-console-smoke-20261018T093910120');
const OUT = import.meta.dirname;
const verifier = join(OUT, 'verifier-before-current-inputs.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = (root, name) => JSON.parse(fs.readFileSync(join(root, name), 'utf8'));
const write = (root, name, value) => fs.writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n');
const lines = (root, name) => fs.readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const writeLines = (root, name, value) => fs.writeFileSync(join(root, name), value.map(JSON.stringify).join('\n') + '\n');
function tree(root) {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(root, entry.name);
    if (entry.isDirectory()) return Object.entries(tree(file)).map(([name,value]) => [entry.name + '/' + name,value]);
    const bytes = fs.readFileSync(file); return [[entry.name, { bytes: bytes.length, sha256: sha(bytes) }]];
  }));
}
const results = [];
function verify(label, root) {
  const result = spawnSync(process.execPath, [verifier, root], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  fs.writeFileSync(join(OUT, label + '.stdout.log'), result.stdout ?? '');
  fs.writeFileSync(join(OUT, label + '.stderr.log'), result.stderr ?? '');
  return { label, exitCode: result.status, signal: result.signal, passed: result.status === 0, artifact: root };
}
function probe(label, mutate) {
  const root = join(OUT, label); assert(!fs.existsSync(root), 'Each probe must use a fresh artifact copy.');
  fs.cpSync(SOURCE, root, { recursive: true, filter: source => !relative(SOURCE, source).split(sep).includes('chromium-profile') });
  mutate(root); const result = verify(label, root); results.push(result); return result;
}
results.push(verify('original', SOURCE));
const inputs = read(SOURCE, 'implementation-inputs-after.json');
const currentInputs = { sources: Object.fromEntries(Object.keys(inputs.sources).map(name => {
  const bytes = fs.readFileSync(resolve(ROOT, 'core', name)); return [name, { bytes: bytes.length, sha256: sha(bytes) }];
})), consoleBundle: tree(join(ROOT, 'console/dist')) };
write(OUT, 'current-inputs-recomputed.json', currentInputs);
assert.deepEqual(currentInputs.sources, inputs.sources, 'The actual run source inputs match current source at review time.');
const currentConsoleBundleMatch = isDeepStrictEqual(currentInputs.consoleBundle, inputs.consoleBundle);
probe('stale-input-hash', root => {
  for (const name of ['implementation-inputs-before.json', 'implementation-inputs-after.json']) {
    const value = read(root, name); value.sources['src/acceptance/defect-ticket-store.mjs'].sha256 = '0'.repeat(64); write(root, name, value);
  }
});
probe('ordinary-request-network-reset', root => {
  const requests = read(root, 'browser-requests.json');
  const request = requests.find(value => value.path.endsWith('/browser-executions') && value.failed?.errorText === 'net::ERR_ABORTED');
  assert(request); request.failed.errorText = 'net::ERR_CONNECTION_RESET'; write(root, 'browser-requests.json', requests);
  const completions = read(root, 'playwright-completions.json');
  const completion = completions.find(value => value.requestId === request.id && value.event === 'failed');
  assert(completion); completion.failure.errorText = 'net::ERR_CONNECTION_RESET'; write(root, 'playwright-completions.json', completions);
  const cdp = read(root, 'cdp-network.json');
  const failed = cdp.find(value => value.event === 'failed' && value.url === request.url && value.errorText === 'net::ERR_ABORTED');
  assert(failed); failed.errorText = 'net::ERR_CONNECTION_RESET'; failed.canceled = false; write(root, 'cdp-network.json', cdp);
});
probe('prefix-observed-after-response', root => {
  const prefix = read(root, 'case-A/ingress-prefix.json'), traceId = prefix[0].traceId;
  const move = values => values.map(value => value.traceId === traceId && ['request','data'].includes(value.event) ? { ...value, at: '2099-01-01T00:00:00.000Z' } : value);
  for (const name of ['case-A/ingress-prefix.json', 'case-A/ingress-complete.json', 'case-A/ingress-at-deny-ack.json']) write(root, name, move(read(root, name)));
  writeLines(root, 'ingress.jsonl', move(lines(root, 'ingress.jsonl')));
});
write(OUT, 'probe-results.json', { source: SOURCE, currentSourcesMatch: true, currentConsoleBundleMatch, results });
console.log(JSON.stringify({ source: SOURCE, currentSourcesMatch: true, currentConsoleBundleMatch, results }, null, 2));
