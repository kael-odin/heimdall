#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { emit } from '../emit.mjs';
import { createAcceptanceRun, readLegacyAcceptanceRun, updateAcceptanceRun, finishAcceptanceRun, acceptanceRunDir, readAcceptanceSnapshots, ACCEPTANCE_ROOT } from './store.mjs';
import { compareAcceptanceSnapshots, comparisonMarkdown } from './comparison.mjs';

function protectAcceptanceOutput(output) {
  const within = (root, path) => {
    const pathFromRoot = relative(root, path);
    return pathFromRoot === '' || pathFromRoot !== '..' && !pathFromRoot.startsWith('..' + sep) && !isAbsolute(pathFromRoot);
  };
  const root = resolve(ACCEPTANCE_ROOT);
  let ancestor = output;
  const suffix = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const actualOutput = resolve(realpathSync(ancestor), ...suffix);
  const actualRoot = existsSync(root) ? realpathSync(root) : root;
  if (within(root, output) || within(actualRoot, actualOutput)) {
    throw new Error('Comparison output must stay outside the acceptance run store; original reports and evidence are immutable.');
  }
}

export async function executeAcceptanceRun(runId) {
  // This gate precedes both the runner import and its catch/finalize writes.
  // Read access to a managed head is never standalone execution permission.
  const manifest = readLegacyAcceptanceRun(runId);
  if (!manifest || manifest.status !== 'running') throw new Error('acceptance run is not running');
  try {
    const { runAcceptance } = await import('./runner.mjs');
    const raw = await runAcceptance(manifest.plan, { runId, outputDir: acceptanceRunDir(runId), onEvent: event => {
      updateAcceptanceRun(runId, { progress: { ...event, at: new Date().toISOString() } });
      emit(event);
    } });
    const report = finishAcceptanceRun(runId, raw);
    emit({ kind: 'acceptance-complete', runId, gate: report.gate, summary: report.summary });
    return report;
  } catch (error) {
    if (readLegacyAcceptanceRun(runId)?.status === 'running') updateAcceptanceRun(runId, { status: 'failed', gate: 'blocked', error: String(error?.message ?? error).slice(0, 1000), endedAt: new Date().toISOString() });
    emit({ kind: 'acceptance-error', runId, error: String(error?.message ?? error).slice(0, 1000) });
    throw error;
  }
}
export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--compare') {
    if (!args[1] || !args[2] || args[1] === args[2]) throw new Error('Usage: --compare <beforeRunId> <afterRunId> [--format json|md] [--output path]');
    let format = 'json', output;
    const seen = new Set();
    for (let i = 3; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!['--format', '--output'].includes(key) || !value || seen.has(key)) throw new Error('Comparison supports --format and --output; original run gates remain authoritative.');
      seen.add(key);
      if (key === '--format') format = value; else output = resolve(value);
    }
    if (!['json', 'md'].includes(format)) throw new Error('Comparison format must be json or md');
    const [before, after] = readAcceptanceSnapshots([args[1], args[2]]);
    if (!before || !after) throw new Error('Comparison run not found');
    if (Date.parse(before.manifest?.createdAt) > Date.parse(after.manifest?.createdAt)) throw new Error('Before run was created after the after run');
    const comparison = compareAcceptanceSnapshots(before, after);
    const content = format === 'md' ? comparisonMarkdown(comparison) : JSON.stringify(comparison, null, 2) + '\n';
    if (output) { protectAcceptanceOutput(output); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, content); }
    else process.stdout.write(content);
    if (comparison.status !== 'completed') process.exitCode = 1;
    return comparison;
  }
  let runId;
  if (args[0] === '--run' && args[1]) runId = args[1];
  else if (args[0] === '--plan' && args[1]) {
    runId = createAcceptanceRun(JSON.parse(readFileSync(resolve(args[1]), 'utf8'))).runId;
  } else throw new Error('Usage: node core/src/acceptance/cli.mjs --plan plan.json [--gate] | --run <runId> | --compare <beforeRunId> <afterRunId> [--format json|md] [--output path]');
  const report = await executeAcceptanceRun(runId);
  process.stdout.write(JSON.stringify({ runId, gate: report.gate, summary: report.summary, outputDir: acceptanceRunDir(runId) }, null, 2) + '\n');
  if (args.includes('--gate') && report.gate !== 'passed') process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 1; });
}
