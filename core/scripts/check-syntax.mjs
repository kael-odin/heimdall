#!/usr/bin/env node
/**
 * check-syntax — zero-dependency syntax gate for the core package.
 *
 * Walks src/ and scripts/, runs `node --check` on every .mjs file and parses
 * every JSON file. Keeps CI honest without pulling a linter into the loop.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGETS = ['src', 'scripts', 'test'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'workspace' || name === 'deliverable') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let failed = 0, checked = 0;
for (const target of TARGETS) {
  const dir = join(ROOT, target);
  let files = [];
  try { files = walk(dir); } catch { continue; }
  for (const file of files) {
    if (file.endsWith('.mjs') || file.endsWith('.js')) {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      checked++;
      if (r.status !== 0) {
        failed++;
        console.error(`SYNTAX FAIL ${relative(ROOT, file)}\n${r.stderr}`);
      }
    } else if (file.endsWith('.json')) {
      checked++;
      try { JSON.parse(readFileSync(file, 'utf8')); }
      catch (e) { failed++; console.error(`JSON FAIL ${relative(ROOT, file)}: ${e.message}`); }
    }
  }
}
if (failed) {
  console.error(`\ncheck-syntax: ${failed} failure(s) / ${checked} checked`);
  process.exit(1);
}
console.log(`check-syntax: ${checked} file(s) OK`);
