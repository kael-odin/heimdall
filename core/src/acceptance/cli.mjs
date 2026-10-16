#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { emit } from '../emit.mjs';
import { createAcceptanceRun, readAcceptanceRun, updateAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from './store.mjs';

export async function executeAcceptanceRun(runId) {
  const manifest = readAcceptanceRun(runId);
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
    if (readAcceptanceRun(runId)?.status === 'running') updateAcceptanceRun(runId, { status: 'failed', gate: 'blocked', error: String(error?.message ?? error).slice(0, 1000), endedAt: new Date().toISOString() });
    emit({ kind: 'acceptance-error', runId, error: String(error?.message ?? error).slice(0, 1000) });
    throw error;
  }
}
export async function main(args = process.argv.slice(2)) {
  let runId;
  if (args[0] === '--run' && args[1]) runId = args[1];
  else if (args[0] === '--plan' && args[1]) {
    runId = createAcceptanceRun(JSON.parse(readFileSync(resolve(args[1]), 'utf8'))).runId;
  } else throw new Error('Usage: node core/src/acceptance/cli.mjs --plan plan.json [--gate] | --run <runId>');
  const report = await executeAcceptanceRun(runId);
  process.stdout.write(JSON.stringify({ runId, gate: report.gate, summary: report.summary, outputDir: acceptanceRunDir(runId) }, null, 2) + '\n');
  if (args.includes('--gate') && report.gate !== 'passed') process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 1; });
}
