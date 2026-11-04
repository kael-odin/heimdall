#!/usr/bin/env node
/**
 * Verify every public case manifest, file hash and QA run linkage.
 *
 * A public case is evidence, not a screenshot dump. This guard ensures the
 * manifest cannot silently drift from the bytes that were actually reviewed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspace } from '../src/qa/workspace.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CASES = join(ROOT, 'docs', 'cases');
const failures = [];

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...walk(file));
    else if (stat.isFile()) files.push(file);
    else failures.push(`unsupported file type: ${file}`);
  }
  return files;
}

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function safeRelative(caseDir, value, label) {
  if (!value || isAbsolute(value)) {
    failures.push(`${label}: path must be relative`);
    return null;
  }
  const absolute = resolve(caseDir, value);
  const rel = relative(caseDir, absolute).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || rel === '..') {
    failures.push(`${label}: path escapes case directory`);
    return null;
  }
  return { absolute, rel };
}

const manifests = existsSync(CASES)
  ? walk(CASES).filter(file => file.endsWith('manifest.json'))
  : [];

for (const manifestPath of manifests) {
  const caseDir = resolve(manifestPath, '..');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { failures.push(`${manifestPath}: invalid JSON: ${error.message}`); continue; }
  if (manifest.schema !== 'heimdall.public-case/1') failures.push(`${manifestPath}: wrong schema`);
  if (!manifest.run?.id) failures.push(`${manifestPath}: missing run.id`);
  if (!Array.isArray(manifest.files) || !manifest.files.length) failures.push(`${manifestPath}: files is empty`);
  const listed = new Set();
  for (const [index, entry] of (manifest.files ?? []).entries()) {
    const safe = safeRelative(caseDir, entry.path, `${manifestPath} files[${index}]`);
    if (!safe) continue;
    listed.add(safe.rel);
    if (!existsSync(safe.absolute) || !statSync(safe.absolute).isFile()) {
      failures.push(`${manifestPath}: missing ${safe.rel}`);
      continue;
    }
    if (statSync(safe.absolute).size !== entry.bytes) failures.push(`${manifestPath}: size mismatch ${safe.rel}`);
    if (hash(safe.absolute) !== entry.sha256) failures.push(`${manifestPath}: sha256 mismatch ${safe.rel}`);
  }
  for (const file of walk(caseDir)) {
    const rel = relative(caseDir, file).replaceAll('\\', '/');
    if (rel !== 'manifest.json' && !listed.has(rel)) failures.push(`${manifestPath}: unlisted file ${rel}`);
  }

  const qa = join(caseDir, '.heimdall', 'qa.json');
  try {
    const workspace = loadWorkspace(caseDir);
    if (!workspace) failures.push(`${manifestPath}: .heimdall/qa.json not found`);
    if (workspace && !workspace.sites[manifest.target?.site ?? 'web']) failures.push(`${manifestPath}: target site is absent from qa.json`);
  } catch (error) {
    failures.push(`${manifestPath}: qa.json invalid: ${error.message}`);
  }
  const runFile = join(caseDir, 'evidence', 'run.json');
  const ciFile = join(caseDir, 'evidence', 'qa-ci.json');
  try {
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    if (run.runId !== manifest.run.id) failures.push(`${manifestPath}: run.json id does not match manifest`);
  } catch (error) { failures.push(`${manifestPath}: run.json unreadable: ${error.message}`); }
  try {
    const ci = JSON.parse(readFileSync(ciFile, 'utf8'));
    if (ci.schema !== 'heimdall.qa-ci/1') failures.push(`${manifestPath}: qa-ci.json schema invalid`);
    if (ci.result?.runId !== manifest.run.id) failures.push(`${manifestPath}: qa-ci.json id does not match manifest`);
    if (ci.gate?.status !== manifest.run.ciGate) failures.push(`${manifestPath}: CI gate does not match manifest`);
  } catch (error) { failures.push(`${manifestPath}: qa-ci.json unreadable: ${error.message}`); }
  if (!existsSync(qa)) failures.push(`${manifestPath}: qa.json missing`);
}

if (!manifests.length) failures.push('no public case manifests found');
if (failures.length) {
  console.error(`public-cases: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`- ${failure.replaceAll(ROOT, '.')}`);
  process.exit(1);
}
console.log(`public-cases: ${manifests.length} case(s), hashes and QA linkage OK`);
