import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../ids.mjs';
import { isSecretPath } from '../secrets.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', 'coverage', '.turbo']);
const SKIP_PATHS = new Set(['.heimdall/ref', '.heimdall/runs']);

/** The exact file set eligible for a rebuild delivery, in stable order. */
export function projectFiles(projectDir) {
  const root = resolve(projectDir);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = path.slice(root.length + 1).replace(/\\/g, '/');
      if (isSecretPath(rel) || [...SKIP_PATHS].some(p => rel === p || rel.startsWith(`${p}/`))) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(path); continue; }
      if (!stat.isFile()) continue;
      const bytes = readFileSync(path);
      files.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes) });
    }
  };
  walk(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export const projectFingerprint = (dir) => sha256(JSON.stringify(projectFiles(dir)));
