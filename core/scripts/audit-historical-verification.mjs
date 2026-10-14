#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from '../src/paths.mjs';
import { auditHistoricalVerification } from '../src/audit/historical-verification.mjs';

const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const csv = (rows, fields) => [fields.join(','), ...rows.map(row => fields.map(key => quote(row[key])).join(','))].join('\n') + '\n';

export function run({ workspace = WORKSPACE, outDir = null } = {}) {
  const report = auditHistoricalVerification(resolve(workspace));
  if (outDir) {
    const out = resolve(outDir);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'historical-verification.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(out, 'historical-verification-pages.csv'), csv(report.pages,
      ['host', 'page', 'targetPath', 'hasQuery', 'hasClone', 'verifyState', 'oldOverall', 'oldGrade',
        'estimatedV2', 'estimatedGrade', 'worstCoverage', 'observedViewports', 'gradeDrop']));
    writeFileSync(join(out, 'historical-verification-missing.csv'), csv(report.missing,
      ['host', 'atlasIndex', 'type', 'pathname', 'hasQuery', 'queryHash', 'proposedPage', 'reason']));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = flag => argv.indexOf(flag);
  const workspace = at('--workspace') >= 0 ? argv[at('--workspace') + 1] : WORKSPACE;
  const outDir = at('--out-dir') >= 0 ? argv[at('--out-dir') + 1] : null;
  if (!workspace || (at('--out-dir') >= 0 && !outDir)) {
    console.error('usage: node core/scripts/audit-historical-verification.mjs [--workspace DIR] [--out-dir DIR]');
    process.exitCode = 2;
  } else console.log(JSON.stringify(run({ workspace, outDir }).summary, null, 2));
}
