import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WORKSPACE } from '../../../paths.mjs';
import { assertSiteOrigin, siteIdForOrigin } from '../../../site-origin.mjs';
import { normalizeOutcomeEvidence, summarizeOutcomeEvidence } from '../../../seo/outcome-evidence.mjs';
import { ok, CapabilityError } from '../../envelope.mjs';
import { isSecretPath } from '../../secrets.mjs';
import { siteDir } from '../../workspace.mjs';

const MAX_INPUT_BYTES = 512 * 1024;

function readInput(file) {
  const input = resolve(file);
  if (isSecretPath(input)) throw new CapabilityError('forbidden', '秘密级文件不能作为 SEO/GEO 证据输入');
  if (!existsSync(input) || !statSync(input).isFile()) throw new CapabilityError('not_found', '证据输入文件不存在');
  if (statSync(input).size > MAX_INPUT_BYTES) throw new CapabilityError('invalid_args', '证据输入超过 512 KiB 上限');
  try { return JSON.parse(readFileSync(input, 'utf8')); }
  catch { throw new CapabilityError('invalid_args', '证据输入不是合法 JSON'); }
}

function writeAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch {}
    throw error;
  }
}

export default {
  id: 'seo_outcomes',
  title: 'SEO/GEO：写入外部效果证据',
  description: 'Validate a sanitized, authorized search/indexing and model-citation experiment summary, bind it to an existing site origin, and write only normalized counts to workspace/<siteId>/seo/outcome-evidence.json. Raw queries, prompts, cookies, tokens and response bodies are never copied. The result is observed evidence, not verified ranking or citation success.',
  effects: ['read', 'write-local'], scope: 'build', idempotent: false, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false, required: ['siteId', 'origin', 'file'],
    properties: {
      siteId: { type: 'string', minLength: 1, maxLength: 253 },
      origin: { type: 'string', pattern: '^https?://', maxLength: 2000 },
      file: { type: 'string', minLength: 1, maxLength: 2000 },
      force: { type: 'boolean', default: false, description: 'Replace the existing normalized sidecar after review' },
    },
  },
  cli: { usage: 'seo-outcomes <siteId> <origin> --file JSON [--force]', positional: ['siteId', 'origin'] },
  async handler(args) {
    const root = siteDir(args.siteId);
    if (!existsSync(root)) throw new CapabilityError('not_found', `没有站点工作区 ${args.siteId}`);
    let origin;
    try { origin = assertSiteOrigin(root, args.origin, { claim: false }); }
    catch (error) { throw new CapabilityError('origin_conflict', String(error?.message ?? error).slice(0, 300)); }
    let derived;
    try { derived = siteIdForOrigin(WORKSPACE, origin); }
    catch (error) { throw new CapabilityError('origin_conflict', String(error?.message ?? error).slice(0, 300)); }
    if (derived !== args.siteId) throw new CapabilityError('origin_conflict', `origin 对应 ${derived}，不是 ${args.siteId}`);
    const source = readInput(args.file);
    let normalized;
    try { normalized = normalizeOutcomeEvidence(source, origin); }
    catch (error) { throw new CapabilityError('invalid_args', String(error?.message ?? error).slice(0, 300)); }
    const seoDir = join(root, 'seo');
    const target = join(seoDir, 'outcome-evidence.json');
    if (existsSync(target) && !args.force) throw new CapabilityError('invalid_args', '已有 outcome-evidence.json；复核后加 --force 覆盖');
    mkdirSync(seoDir, { recursive: true });
    writeAtomic(target, normalized);
    const outcomeEvidence = summarizeOutcomeEvidence(root, args.siteId, origin);
    return ok({ siteId: args.siteId, origin, outcomeEvidence }, {
      summary: `已写入 ${args.siteId} 的 SEO/GEO 外部效果摘要；搜索=${outcomeEvidence.search.status}，模型引用=${outcomeEvidence.modelCitation.status}。`,
      evidence: outcomeEvidence.path ? [{ path: outcomeEvidence.path, uri: outcomeEvidence.uri }] : [],
    });
  },
};
