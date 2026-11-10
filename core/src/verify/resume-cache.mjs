import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSecretFile } from '../paths.mjs';
import { sessionPath } from '../session/store.mjs';
import { TILE_HEIGHT } from './tiled-compare.mjs';

function hashFile(hash, file, name) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
  hash.update(JSON.stringify([name, stat.size])).update('\0');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { closeSync(fd); }
}

function hashTree(hash, dir, name) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a regular directory');
  hash.update(JSON.stringify([name, 'directory'])).update('\0');
  for (const entry of readdirSync(dir).sort()) {
    const file = join(dir, entry);
    if (isSecretFile(file)) throw new Error('secret file in clone');
    const child = lstatSync(file);
    if (child.isDirectory() && !child.isSymbolicLink()) hashTree(hash, file, name + '/' + entry);
    else hashFile(hash, file, name + '/' + entry);
  }
}

export function resumeIdentity(dir, options, verifier) {
  if (!verifier || options.interactions) return null;
  try {
    const manifest = join(dir, 'manifest.json');
    const target = new URL(JSON.parse(readFileSync(manifest, 'utf8')).target);
    if (!['http:', 'https:'].includes(target.protocol) || existsSync(sessionPath(target.hostname))) return null;
    const hash = createHash('sha256');
    hashFile(hash, manifest, 'manifest.json');
    hashTree(hash, join(dir, 'clone'), 'clone');
    return { version: 1, verifier, inputs: hash.digest('hex'), options };
  } catch { return null; }
}

export function evidenceSha256(result, outDir, keepScreenshots) {
  try {
    const files = [];
    for (const vp of result.viewports) {
      if (!/^\d+x\d+$/.test(vp.name)) return null;
      if (vp.captureMode === 'full') {
        files.push(`diff-${vp.name}.png`);
        if (keepScreenshots) files.push(`src-${vp.name}.png`, `clone-${vp.name}.png`);
      } else if (vp.captureMode === 'tiled') {
        const heights = [vp.sourceHeight, vp.cloneHeight];
        if (heights.some(h => !Number.isInteger(h) || h < 1 || h > 100_000)) return null;
        const tileNames = (prefix, height) => Array.from({ length: Math.ceil(height / TILE_HEIGHT) },
          (_, i) => `${prefix}-${vp.name}-part-${String(i + 1).padStart(3, '0')}.png`);
        const diffs = tileNames('diff', Math.max(...heights));
        if (JSON.stringify(vp.diffParts) !== JSON.stringify(diffs)) return null;
        files.push(...diffs);
        if (keepScreenshots) files.push(...tileNames('src', heights[0]), ...tileNames('clone', heights[1]));
      } else return null;
    }
    if (!files.length) return null;
    const hash = createHash('sha256');
    for (const file of files) hashFile(hash, join(outDir, file), file);
    return hash.digest('hex');
  } catch { return null; }
}

export function archiveVerifyArtifacts(outDir) {
  const dir = lstatSync(outDir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('invalid previous evidence directory');
  const files = readdirSync(outDir).filter(name => /^(?:verify\.json|(?:diff|src|clone|ix)-.+\.png)$/.test(name));
  if (!files.length) return null;
  const history = join(dirname(outDir), '.resume-history');
  mkdirSync(history, { recursive: true });
  if (!lstatSync(history).isDirectory() || lstatSync(history).isSymbolicLink()) throw new Error('invalid history directory');
  const dest = mkdtempSync(join(history, 'page-'));
  for (const name of files) {
    const file = join(outDir, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid previous evidence');
    copyFileSync(file, join(dest, name), constants.COPYFILE_EXCL);
  }
  return dest;
}

export function archiveVerifySummary(verifyDir) {
  const file = join(verifyDir, 'verify-summary.json');
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid previous summary');
  const history = join(verifyDir, '.resume-history');
  mkdirSync(history, { recursive: true });
  if (!lstatSync(history).isDirectory() || lstatSync(history).isSymbolicLink()) throw new Error('invalid history directory');
  const dest = mkdtempSync(join(history, 'summary-'));
  copyFileSync(file, join(dest, 'verify-summary.json'), constants.COPYFILE_EXCL);
}
