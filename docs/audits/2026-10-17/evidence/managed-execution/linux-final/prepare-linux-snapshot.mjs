import * as fs from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const out = dirname(fileURLToPath(import.meta.url)), repo = fs.realpathSync(process.cwd());
const snapshot = join(out, 'snapshot'), manifestPath = join(out, 'snapshot-manifest.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv.includes('--verify-current')) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const changed = manifest.files.filter(file => !fs.existsSync(file.source) || sha(fs.readFileSync(file.source)) !== file.sha256)
    .map(file => file.path);
  fs.writeFileSync(join(out, 'current-input-verification-after.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
    count: manifest.files.length, changed, manifestSha256: sha(fs.readFileSync(manifestPath)) }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ count: manifest.files.length, changed }) + '\n');
  process.exit(changed.length ? 1 : 0);
}
if (!fs.existsSync(join(repo, 'core', 'src', 'engine-server.mjs')) || fs.existsSync(snapshot)) throw Error('Expected a current repository and a new snapshot directory.');
fs.mkdirSync(snapshot);
const files = [];
function capture(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) capture(join(source, name), join(target, name));
    return;
  }
  if (!stat.isFile()) throw Error('Only regular fixture source files may be copied.');
  const bytes = fs.readFileSync(source);
  fs.mkdirSync(dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  files.push({ path: relative(snapshot, target).replaceAll('\\', '/'), source, bytes: bytes.length, sha256: sha(bytes) });
}
capture(join(repo, 'core', 'src'), join(snapshot, 'core', 'src'));
capture(join(repo, 'core', 'package.json'), join(snapshot, 'core', 'package.json'));
capture(join(repo, 'core', 'test', 'acceptance-execution-http-lifecycle.test.mjs'), join(snapshot, 'core', 'test', 'acceptance-execution-http-lifecycle.test.mjs'));
capture(join(repo, 'core', 'scripts', 'fixtures', 'managed-execution.mjs'), join(snapshot, 'core', 'scripts', 'fixtures', 'managed-execution.mjs'));
for (const name of ['parse5', 'entities', 'pngjs', 'pixelmatch', 'playwright', 'playwright-core']) {
  const versions = fs.readdirSync(join(repo, 'core', 'node_modules', '.pnpm')).filter(entry => entry.startsWith(name + '@'));
  if (versions.length !== 1) throw Error('Expected exactly one already installed dependency version: ' + name);
  const source = join(repo, 'core', 'node_modules', '.pnpm', versions[0], 'node_modules', name);
  capture(fs.realpathSync(source), join(snapshot, 'core', 'node_modules', name));
}
const changed = files.filter(file => sha(fs.readFileSync(file.source)) !== file.sha256).map(file => file.path);
if (changed.length) throw Error('Source changed while capturing snapshot: ' + changed.join(', '));
fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), files }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  manifestSha256: sha(fs.readFileSync(manifestPath)), snapshot }) + '\n');
