import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(new URL('../../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const artifact = join(root, 'core/workspace/_runs/owned-recovery-20261017');
const snapshot = join(artifact, 'review-frozen');
if (fs.existsSync(snapshot)) throw Error('Frozen snapshot already exists; refusing to mix inputs');
const roots = ['core/src', 'core/test', 'core/scripts'];
const exact = ['package.json', 'core/package.json',
  'docs/audits/2026-10-17/evidence/acceptance-managed-store/managed-preparation/prepared-record.json',
  'docs/audits/2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json'];
const runtimeSource = 'core/workspace/_runs/managed-linux-final-20261017/node-v22.23.3-linux-x64.tar.xz';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function walk(relative) {
  return fs.readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = relative + '/' + entry.name;
    if (entry.isDirectory()) return walk(path);
    if (!entry.isFile()) throw Error('Nonregular snapshot input: ' + path);
    return [path];
  });
}
const enumerate = () => [...roots.flatMap(walk), ...exact].sort();
const paths = enumerate();
const captured = paths.map(path => {
  const bytes = fs.readFileSync(join(root, path));
  return { path, bytes, sha256: hash(bytes) };
});
const runtimeBytes = fs.readFileSync(join(root, runtimeSource)), runtimeHash = hash(runtimeBytes);
fs.mkdirSync(snapshot);
const manifest = { schemaVersion: 1, capturedAt: new Date().toISOString(), sourceRoot: root,
  files: captured.map(({ path, bytes, sha256 }) => ({ path, bytes: bytes.length, sha256 })),
  runtime: { source: runtimeSource, bytes: runtimeBytes.length, sha256: runtimeHash } };
// Persist the original pins before any payload is written. Only captured bytes
// are then copied, never a later live read of a file that may have changed.
fs.writeFileSync(join(snapshot, 'pins.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(join(snapshot, 'pins.sha256'), captured.map(item => item.sha256 + '  ' + item.path).join('\n') + '\n');
for (const item of captured) {
  const target = join(snapshot, 'payload', item.path);
  fs.mkdirSync(dirname(target), { recursive: true }); fs.writeFileSync(target, item.bytes);
}
fs.mkdirSync(join(snapshot, 'runtime'));
fs.writeFileSync(join(snapshot, 'runtime/node-v22.23.3-linux-x64.tar.xz'), runtimeBytes);
if (JSON.stringify(enumerate()) !== JSON.stringify(paths)) throw Error('Source file inventory changed while freezing');
for (const item of captured) {
  if (hash(fs.readFileSync(join(root, item.path))) !== item.sha256) throw Error('Source changed while freezing: ' + item.path);
  if (hash(fs.readFileSync(join(snapshot, 'payload', item.path))) !== item.sha256) throw Error('Frozen copy differs: ' + item.path);
}
if (hash(fs.readFileSync(join(root, runtimeSource))) !== runtimeHash
  || hash(fs.readFileSync(join(snapshot, 'runtime/node-v22.23.3-linux-x64.tar.xz'))) !== runtimeHash) throw Error('Runtime archive changed while freezing');
const result = { ok: true, checkedAt: new Date().toISOString(), files: captured.length,
  bytes: captured.reduce((total, item) => total + item.bytes.length, 0), runtimeSha256: runtimeHash };
fs.writeFileSync(join(snapshot, 'verified.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
