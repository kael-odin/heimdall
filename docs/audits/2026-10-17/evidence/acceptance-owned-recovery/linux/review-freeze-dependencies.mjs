import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(new URL('../../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const target = join(root, 'core/workspace/_runs/owned-recovery-20261017/review-frozen-dependencies');
if (fs.existsSync(target)) throw Error('Dependency snapshot already exists');
const packages = [
  { name: 'parse5', source: 'core/node_modules/.pnpm/parse5@8.0.1/node_modules/parse5' },
  { name: 'entities', source: 'core/node_modules/.pnpm/entities@8.1.0/node_modules/entities' }
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function walk(path) {
  return fs.readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const next = path + '/' + entry.name;
    if (entry.isDirectory()) return walk(next);
    if (!entry.isFile()) throw Error('Nonregular dependency input: ' + next);
    return [next];
  });
}
const enumerate = () => packages.flatMap(pkg => walk(pkg.source));
const paths = enumerate(), captured = paths.map(source => {
  const pkg = packages.find(item => source.startsWith(item.source + '/'));
  const path = 'core/node_modules/' + pkg.name + source.slice(pkg.source.length);
  const bytes = fs.readFileSync(join(root, source));
  return { source, path, bytes, sha256: hash(bytes) };
});
fs.mkdirSync(target);
fs.writeFileSync(join(target, 'pins.json'), JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(),
  packages, files: captured.map(({ bytes, ...item }) => ({ ...item, bytes: bytes.length })) }, null, 2) + '\n');
fs.writeFileSync(join(target, 'pins.sha256'), captured.map(item => item.sha256 + '  ' + item.path).join('\n') + '\n');
for (const item of captured) {
  const path = join(target, 'payload', item.path); fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, item.bytes);
}
if (JSON.stringify(enumerate()) !== JSON.stringify(paths)) throw Error('Dependency inventory changed');
for (const item of captured) if (hash(fs.readFileSync(join(root, item.source))) !== item.sha256
  || hash(fs.readFileSync(join(target, 'payload', item.path))) !== item.sha256) throw Error('Dependency bytes changed: ' + item.source);
const result = { ok: true, files: captured.length, bytes: captured.reduce((total, item) => total + item.bytes.length, 0) };
fs.writeFileSync(join(target, 'verified.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
