#!/usr/bin/env node
/** Offline catalog maintenance. This command never starts an engine or recovers runs. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ACCEPTANCE_ROOT } from './constants.mjs';
import { acquireAcceptanceOwner } from './owner.mjs';
import { createAcceptanceCatalogStore } from './catalog.mjs';
import { invalid, error } from './catalog-schema.mjs';
import { acceptanceCatalogError } from './catalog-api.mjs';

const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^ag-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACTIONS = new Set(['--preview', '--apply', '--create']);
const CONFIRMATION = ['--expected-generation-id', '--expected-revision', '--expected-head-sha256',
  '--expected-previous-sha256', '--expected-plan-digest'];

export function parseCatalogMaintenanceArgs(args) {
  if (!Array.isArray(args) || !ACTIONS.has(args[0])) invalid('请选择 --preview、--apply 或 --create。');
  const action = args[0].slice(2), allowed = new Set(['--target-schema', '--root', ...(action === 'apply' ? CONFIRMATION : [])]);
  const values = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || values.has(key) || typeof value !== 'string' || !value || value.startsWith('--')) invalid('维护命令参数无效或重复。');
    values.set(key, value);
  }
  const target = values.get('--target-schema');
  if (values.has('--root') && !values.get('--root').trim()) invalid('目录路径无效。');
  if (!(action === 'create' ? ['3', '4'] : ['4']).includes(target)) invalid('请明确指定目录目标格式。');
  const input = { targetSchemaVersion: Number(target) };
  if (action === 'apply') {
    if (CONFIRMATION.some(key => !values.has(key))) invalid('应用迁移需要完整的新预览确认。');
    const revision = values.get('--expected-revision'), previous = values.get('--expected-previous-sha256');
    if (!GENERATION.test(values.get('--expected-generation-id')) || !/^(?:0|[1-9][0-9]*)$/.test(revision)
      || !Number.isSafeInteger(Number(revision)) || !HASH.test(values.get('--expected-head-sha256'))
      || !HASH.test(values.get('--expected-plan-digest')) || previous !== 'none' && !HASH.test(previous)) invalid('迁移确认摘要或版本无效。');
    Object.assign(input, { expectedGenerationId: values.get('--expected-generation-id'), expectedRevision: Number(revision),
      expectedHeadSha256: values.get('--expected-head-sha256'), expectedPreviousSha256: previous === 'none' ? null : previous,
      expectedPlanDigest: values.get('--expected-plan-digest') });
  }
  return { action, input, ...(values.has('--root') ? { root: values.get('--root') } : {}) };
}

export async function main(args = process.argv.slice(2)) {
  // Parse before owner acquisition: malformed commands never touch a data root.
  const { action, input, root } = parseCatalogMaintenanceArgs(args);
  const owner = acquireAcceptanceOwner({ root: root === undefined ? ACCEPTANCE_ROOT : resolve(process.env.HEIMDALL_INVOKE_CWD ?? process.cwd(), root) });
  try {
    const store = createAcceptanceCatalogStore({ root: owner.root, owner });
    let result;
    if (action === 'preview') result = await store.previewMigration(input);
    else if (action === 'create') {
      if (existsSync(join(owner.root, 'catalog.json'))) throw error('CATALOG_ALREADY_INITIALIZED', 409, '目录已存在，不能重复创建。');
      const catalog = await store.initialize({ createSchemaVersion: input.targetSchemaVersion });
      result = { changed: true, schemaVersion: catalog.schemaVersion, generationId: catalog.generationId, revision: catalog.revision,
        headSha256: createHash('sha256').update(JSON.stringify(catalog, null, 2) + '\n').digest('hex'), executionReady: false };
    } else {
      const applied = await store.applyMigration(input);
      result = { changed: applied.changed, schemaVersion: applied.catalog.schemaVersion, generationId: applied.catalog.generationId,
        revision: applied.catalog.revision, headSha256: applied.completedSteps.at(-1)?.headSha256 ?? input.expectedHeadSha256,
        completedSteps: applied.completedSteps, executionReady: false };
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally { owner.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(cause => {
    const failure = cause?.code === 'CATALOG_ALREADY_INITIALIZED'
      ? { status: 409, payload: { code: 'CATALOG_ALREADY_INITIALIZED', error: '目录已存在，不能重复创建。' } }
      : acceptanceCatalogError(cause);
    process.stderr.write(JSON.stringify({ status: failure.status, ...failure.payload }) + '\n');
    process.exitCode = 1;
  });
}
