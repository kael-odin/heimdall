#!/usr/bin/env node
/**
 * heimdall backend scaffold — 生成 B3 最小可运行后端起点。
 *
 * 只读取已清洗的 api-contract.json 和已验证格式的 runtime-adapter。
 * 不发明业务规则，也不把观察型契约包装成源站后端等价物。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectRuntimeAdapter, isRuntimeAdapterPath, matchesRuntimeAdapterRoute, responseHeaders } from '../../live/adapter-runtime.mjs';
import { CapabilityError, exitCodeOf, fromError, ok } from '../envelope.mjs';
import { parseArgs } from '../parse-args.mjs';
import { assertSiteId, siteDir } from '../workspace.mjs';

const CONTRACT_FILES = ['api-contract.json', 'deliver/api-contract.json', 'deliverable/api-contract.json'];
const METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

function readJson(file, maxBytes = 4 * 1024 * 1024) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function businessRuleResults(file, label) {
  const report = readJson(file);
  if (!report || report.schema !== 'heimdall.backend-check/1' || report.mode !== 'business-rules-only') {
    throw new CapabilityError('invalid_args', `${label} 必须是 business-rules-only 的 backend-check.json。`);
  }
  const rows = Array.isArray(report.results) ? report.results.filter(item => String(item?.id ?? '').startsWith('business-rule:')) : [];
  const map = new Map();
  for (const item of rows) {
    const id = String(item.id);
    if (map.has(id)) throw new CapabilityError('invalid_args', `${label} 包含重复业务规则：${id}`);
    map.set(id, {
      ...(typeof item.actor === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item.actor) ? { actor: item.actor } : {}),
      status: ['passed', 'failed', 'incomplete', 'skipped'].includes(item.status) ? item.status : 'unknown',
      ...(Number.isInteger(item.step) && item.step > 0 ? { step: item.step } : {}),
      ...(typeof item.pointer === 'string' ? { pointer: item.pointer.slice(0, 128) } : {}),
      ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 128) } : {}),
    });
  }
  return map;
}

function comparisonRepairTask(ruleId, source, candidate, index) {
  const suffix = ruleId.slice('business-rule:'.length).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 64) || 'unknown';
  return {
    id: `repair-backend-rule-equivalence-${suffix}-${index}`,
    kind: 'business-rule-equivalence', target: 'candidate backend',
    instruction: '修正候选后端对应业务流程，再分别运行源站和候选后端的 business-rules-only 检查。',
    requiresHumanApproval: false,
    evidence: {
      ruleId, sourceStatus: source?.status ?? 'missing', candidateStatus: candidate?.status ?? 'missing',
      ...(candidate?.actor ? { actor: candidate.actor } : source?.actor ? { actor: source.actor } : {}),
      ...(candidate?.step ? { step: candidate.step } : {}),
      ...(candidate?.pointer ? { pointer: candidate.pointer } : {}),
    },
  };
}

function compareReports(flags, positional) {
  if (positional[0] !== 'compare' || !positional[1] || !positional[2]) {
    throw new CapabilityError('invalid_args', '用法：heimdall backend compare <source-check.json> <candidate-check.json> [--out FILE] [--force] [--json]');
  }
  const sourceFile = resolve(String(positional[1]));
  const candidateFile = resolve(String(positional[2]));
  const source = businessRuleResults(sourceFile, '源站报告');
  const candidate = businessRuleResults(candidateFile, '候选报告');
  const ids = [...new Set([...source.keys(), ...candidate.keys()])].sort();
  const comparisons = ids.map(id => {
    const sourceResult = source.get(id);
    const candidateResult = candidate.get(id);
    let status = 'passed';
    let reason;
    if (!sourceResult) { status = 'incomplete'; reason = 'rule_missing_from_source'; }
    else if (!candidateResult) { status = 'failed'; reason = 'rule_missing_from_candidate'; }
    else if (sourceResult.status !== 'passed') { status = 'incomplete'; reason = 'source_rule_not_passed'; }
    else if (candidateResult.status !== 'passed') { status = 'failed'; reason = 'candidate_rule_not_passed'; }
    return {
      id, status, reason,
      ...(sourceResult?.actor ? { sourceActor: sourceResult.actor } : {}),
      ...(candidateResult?.actor ? { candidateActor: candidateResult.actor } : {}),
      sourceStatus: sourceResult?.status ?? 'missing', candidateStatus: candidateResult?.status ?? 'missing',
      ...(candidateResult?.step ? { step: candidateResult.step } : {}),
      ...(candidateResult?.pointer ? { pointer: candidateResult.pointer } : {}),
    };
  });
  if (!comparisons.length) comparisons.push({ id: 'business-rules', status: 'incomplete', reason: 'no_business_rules_declared', sourceStatus: 'missing', candidateStatus: 'missing' });
  const repairTasks = comparisons.filter(item => item.status === 'failed').map((item, index) => comparisonRepairTask(item.id, source.get(item.id), candidate.get(item.id), index + 1));
  const overall = comparisons.some(item => item.status === 'failed') ? 'failed'
    : comparisons.some(item => item.status === 'incomplete') ? 'incomplete' : 'passed';
  const base = process.env.HEIMDALL_INVOKE_CWD ?? process.cwd();
  const outFile = resolve(base, flags.out ? String(flags.out) : 'backend-compare.json');
  if (existsSync(outFile) && !flags.force) throw new CapabilityError('invalid_args', '比较报告已存在：' + outFile, { hint: '确认覆盖后加 --force，或换一个 --out 文件。' });
  const report = {
    schema: 'heimdall.backend-comparison/1', generatedAt: new Date().toISOString(), mode: 'business-rules-only', overall,
    sourceRules: source.size, candidateRules: candidate.size,
    summary: { compared: comparisons.filter(item => item.id !== 'business-rules').length, passed: comparisons.filter(item => item.status === 'passed').length, failed: comparisons.filter(item => item.status === 'failed').length, incomplete: comparisons.filter(item => item.status === 'incomplete').length },
    comparisons, repairTasks,
    note: '只比较两份脱敏业务规则报告；通过不代表完整后端等价，也不覆盖未声明的权限、状态机、持久化或外部副作用。',
  };
  writeFileChecked(outFile, json(report));
  return ok({ ...report, outFile }, {
    summary: `后端业务规则对照${overall === 'passed' ? '通过' : overall === 'incomplete' ? '未完成' : '失败'}：${report.summary.passed} 通过，${report.summary.failed} 失败，${report.summary.incomplete} 未完成。`,
    warnings: ['比较只使用 business-rules-only 报告，不会读取或保存请求体、认证值和响应正文。'],
  });
}

function writeFileChecked(file, value) {
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CapabilityError('invalid_args', '输出文件不是普通文件：' + file);
  }
  writeFileSync(file, value, 'utf8');
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function text(value, max = 256) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function safePath(value) {
  return isRuntimeAdapterPath(value) ? value : null;
}

function names(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item).trim().toLowerCase())
    .filter(item => /^[a-z0-9_.:[\]~-]{1,128}$/i.test(item)))].sort().slice(0, max);
}

function schema(value, depth = 0) {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (depth > 8) throw new CapabilityError('invalid_args', '后端契约结构超过 8 层，不能省略约束后继续生成。');
  const output = {};
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (!types.length || types.length > 7 || types.some(type => !SCHEMA_TYPES.has(type))) {
      throw new CapabilityError('invalid_args', '后端契约包含无效的 JSON 类型。');
    }
    output.type = Array.isArray(value.type) ? [...new Set(types)] : value.type;
  }
  for (const key of ['format', 'nullable', 'additionalProperties']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'boolean') output[key] = value[key];
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || !value[key].length || value[key].length > 20) {
      throw new CapabilityError('invalid_args', '后端契约每个组合必须包含 1 至 20 个分支。');
    }
    const children = value[key].map(item => schema(item, depth + 1));
    if (children.some(item => item === undefined)) throw new CapabilityError('invalid_args', '后端契约包含无效的响应分支。');
    output[key] = children;
  }
  if (Array.isArray(value.required)) output.required = value.required.filter(name => typeof name === 'string').slice(0, 100);
  if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
    output.properties = Object.create(null);
    for (const [name, item] of Object.entries(value.properties).slice(0, 100)) {
      const child = schema(item, depth + 1);
      if (child !== undefined) output.properties[text(name, 128)] = child;
    }
  }
  if (value.items !== undefined) {
    const child = schema(value.items, depth + 1);
    if (child !== undefined) output.items = child;
  }
  return output;
}

function content(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [mime, item] of Object.entries(value).slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const child = schema(item.schema);
    output[text(mime, 128)] = child !== undefined ? { schema: child } : {};
  }
  return output;
}

function operation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  const observed = value['x-heimdall-observations'];
  if (observed && typeof observed === 'object') {
    output['x-heimdall-observations'] = {
      samples: Number.isFinite(Number(observed.samples)) ? Number(observed.samples) : null,
      queryParams: names(observed.queryParams),
      authSchemes: names(observed.authSchemes),
    };
  }
  if (value.requestBody && typeof value.requestBody === 'object') output.requestBody = { content: content(value.requestBody.content) };
  if (value.responses && typeof value.responses === 'object') {
    output.responses = {};
    for (const [status, response] of Object.entries(value.responses).slice(0, 30)) {
      if (!/^[0-9]{3}$/.test(status) || !response || typeof response !== 'object') continue;
      const item = { content: content(response.content) };
      if (Number.isFinite(Number(response['x-heimdall-samples']))) item['x-heimdall-samples'] = Number(response['x-heimdall-samples']);
      output.responses[status] = item;
    }
  }
  return output;
}

function projectContract(source, siteId, status) {
  const input = source && typeof source === 'object' ? source : {};
  const openapi = input.openapi && typeof input.openapi === 'object' ? input.openapi : {};
  const paths = {};
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {}).slice(0, 200)) {
    const safe = safePath(path);
    if (!safe || !pathItem || typeof pathItem !== 'object') continue;
    const item = {};
    for (const [method, value] of Object.entries(pathItem)) {
      if (!METHODS.has(method.toLowerCase())) continue;
      const projected = operation(value);
      if (projected) item[method.toLowerCase()] = projected;
    }
    if (Object.keys(item).length) paths[safe] = item;
  }
  const origin = (() => {
    try {
      const url = new URL(openapi.servers?.[0]?.url);
      return /^https?:$/.test(url.protocol) ? url.origin : null;
    } catch {
      return null;
    }
  })();
  const observed = Array.isArray(input.observations) ? input.observations.slice(0, 200).map(item => ({
    op: text(item?.op),
    samples: Number.isFinite(Number(item?.samples)) ? Number(item.samples) : null,
    statusCodes: Array.isArray(item?.statusCodes) ? item.statusCodes.filter(Number.isInteger).slice(0, 30) : [],
    queryParams: names(item?.queryParams),
    withResponseSchema: item?.withResponseSchema === true,
    withRequestSchema: item?.withRequestSchema === true,
    authSchemes: names(item?.authSchemes),
    errorSamples: Number.isFinite(Number(item?.errorSamples)) ? Number(item.errorSamples) : 0,
    provenance: 'observed',
  })) : [];
  const endpointCount = Object.values(paths).reduce((sum, item) => sum + Object.keys(item).length, 0);
  return {
    schema: 'heimdall.backend-scaffold-contract/1',
    sourceSchema: text(input.schema, 80),
    siteId,
    generatedAt: new Date().toISOString(),
    tier: endpointCount ? 'B1' : 'B0',
    status,
    origin,
    openapi: {
      openapi: '3.1.0',
      info: { title: siteId + ' observed API contract', version: 'observed-1' },
      ...(origin ? { servers: [{ url: origin, 'x-heimdall-provenance': 'observed' }] } : {}),
      'x-heimdall-tier': endpointCount ? 'B1' : 'B0',
      paths,
    },
    observations: observed,
    unknowns: Array.isArray(input.unknowns)
      ? input.unknowns.slice(0, 100).map(item => ({ kind: text(item?.kind, 80), op: text(item?.op), detail: text(item?.detail) }))
      : [{ kind: status === 'missing' ? 'api-contract-missing' : 'api-contract-invalid' }],
    coverage: {
      endpoints: endpointCount,
      observed: endpointCount,
      withResponseSchema: observed.filter(item => item.withResponseSchema).length,
      withRequestSchema: observed.filter(item => item.withRequestSchema).length,
      authObserved: observed.filter(item => item.authSchemes.length > 0).length,
      invented: 0,
    },
  };
}

function routesOf(contract) {
  const rows = [];
  for (const [path, item] of Object.entries(contract.openapi?.paths ?? {})) {
    for (const [method, value] of Object.entries(item ?? {})) {
      const upper = method.toUpperCase();
      if (!HTTP_METHODS.has(upper)) continue;
      rows.push({
        method: upper,
        path,
        queryParams: names(value?.['x-heimdall-observations']?.queryParams),
        authSchemes: names(value?.['x-heimdall-observations']?.authSchemes),
        responseStatuses: Object.keys(value?.responses ?? {}).filter(code => /^[0-9]{3}$/.test(code)).map(Number),
        basis: 'observed',
      });
    }
  }
  return rows.sort((a, b) => (a.method + ' ' + a.path).localeCompare(b.method + ' ' + b.path)).slice(0, 200);
}

function responseShapesOf(operation) {
  return Object.entries(operation?.responses ?? {}).filter(([status]) => /^[0-9]{3}$/.test(status)).map(([status, response]) => {
    const contentMap = response?.content && typeof response.content === 'object' && !Array.isArray(response.content) ? response.content : {};
    const schemas = Object.entries(contentMap).flatMap(([mimeType, item]) => {
      const value = schema(item?.schema);
      return value === undefined ? [] : [{ mimeType: text(mimeType, 128), schema: value }];
    });
    return {
      status: Number(status),
      mimeTypes: Object.keys(contentMap).map(value => text(value, 128)).filter(Boolean).sort(),
      ...(schemas.length ? { schemas } : {}),
    };
  });
}

function backendTask({ siteId, contract, adapter, routes }) {
  const observedEndpoints = routes.map(route => ({
    ...route,
    responseShapes: responseShapesOf(contract.openapi?.paths?.[route.path]?.[route.method.toLowerCase()]),
  }));
  const observedInputs = [
    { path: 'api-contract.json', role: 'observed interface contract', basis: contract.status === 'observed' ? 'observed' : 'unknown', required: true },
    ...(adapter.present ? [{ path: 'runtime-adapter/manifest.json', role: 'observed replay route metadata', basis: 'observed', required: true }] : []),
  ];
  const optionalInputs = [
    { path: 'backend-check.json', role: 'deterministic local check results', basis: 'observed', required: false },
    { path: '$HEIMDALL_RUNTIME_DATA_DIR/adapter-gap-ledger.json', role: 'runtime gap summary from the external data directory', basis: 'observed', required: false },
  ];
  const unknowns = ['authentication', 'permissions', 'state-machine', 'business-rules', 'persistence', 'side-effects'];
  if (contract.status !== 'observed') unknowns.push('api-contract:' + contract.status);
  const tasks = contract.status === 'observed' ? [
    { id: 'implement-observed-routes', basis: 'observed', requiresHumanApproval: false, instruction: '只实现 observedEndpoints 中已经有契约证据的路由，保持状态码、MIME 和有限 JSON 结构。' },
    { id: 'replay-and-close-gaps', basis: adapter.present ? 'observed' : 'unknown', requiresHumanApproval: false, instruction: '运行 npm run check；读取缺口账本后逐项补实现，不能用猜测清除缺口。' },
    { id: 'add-reviewed-business-rules', basis: 'inferred', requiresHumanApproval: true, instruction: '只有在授权旅程和测试数据确认后，才把业务流程写入 state-rules.json 并标记 reviewed。' },
    { id: 'verify-state-and-side-effects', basis: 'unknown', requiresHumanApproval: true, instruction: '人工授权后验证操作前后状态、读回、清理、权限和外部副作用。' },
  ] : [
    { id: 'obtain-observation', basis: 'unknown', requiresHumanApproval: true, instruction: '先取得脱敏 api-contract.json；没有观察证据时不要发明业务 API。' },
  ];
  return {
    schema: 'heimdall.backend-ai-task/1',
    siteId,
    status: contract.status === 'observed' ? 'ready_for_ai_draft' : 'blocked_on_observation',
    objective: '在保持证据出处的前提下补齐本地后端，让前端能在独立部署中复现已观察行为，并用确定性检查收敛差异。',
    inputs: [...observedInputs, ...optionalInputs],
    observedEndpoints,
    currentAdapter: {
      present: adapter.present,
      routes: adapter.routes,
      sessions: adapter.sessions ?? 0,
      basis: adapter.present ? 'observed' : 'unknown',
    },
    unknowns,
    tasks,
    guardrails: [
      '只把 observed 证据当作已知行为；inferred 只能作为草稿输入，invented 不得作为通过证据。',
      '认证、权限、写入、持久化、状态机和外部副作用需要人工授权与独立旅程。',
      '不得把认证值、Cookie、请求体、响应正文或原始 HAR 写入任务文件或检查报告。',
      '完成实现后必须运行 npm run check，并按 backend-check.json 的修复任务继续复测。',
    ],
    verification: {
      commands: ['npm start', 'npm run check', 'npm run check -- --business-rules-only', `heimdall site-assessment ${siteId} --json`],
      gates: [
        'observed 路由的状态码、MIME 和有限 JSON 结构通过。',
        'adapter-gap-ledger 没有新的未声明路由或查询参数缺口。',
        '业务规则先由人工确认，再用同一规则分别检查源站和候选后端。',
      ],
    },
    prompt: [
      '先读取 api-contract.json、backend-task.json，以及存在时的 backend-check.json 和 adapter-gap-ledger.json。',
      '只实现有 observed 证据的端点；不要从 unknowns 推断认证、权限、状态机、持久化或副作用。',
      '把需要业务判断的内容写成 inferred 草稿，等待人工确认后再写入 state-rules.json。',
      '每完成一个小改动就运行 npm run check；最终把 verified、observed、inferred、unknown 分开汇报。',
    ].join('\n'),
    provenance: {
      observed: observedInputs.filter(item => item.basis === 'observed').map(item => item.path),
      inferred: ['AI 任务目标', '修复步骤', '验证门禁'],
      invented: [],
    },
    limitations: [
      '任务文件是补写提示和证据索引，不是源站后端等价证明。',
      '运行后产生的缺口和检查结果可能变化，应以最新 backend-check.json 与 site-assessment 为准。',
    ],
  };
}

function findContract(root) {
  for (const suffix of CONTRACT_FILES) {
    const file = join(root, suffix);
    if (!existsSync(file)) continue;
    const source = readJson(file);
    return source ? { status: 'observed', source, path: suffix } : { status: 'invalid', source: null, path: suffix };
  }
  return { status: 'missing', source: null, path: null };
}

function readAdapter(root) {
  const dir = join(root, 'runtime-adapter');
  if (!existsSync(dir)) return { status: 'missing', present: false, routes: [] };
  try {
    const inspected = inspectRuntimeAdapter(root);
    const stat = lstatSync(inspected.moduleFile);
    if (stat.size > 2 * 1024 * 1024) throw new Error('adapter module is too large');
    const manifest = readJson(join(dir, 'manifest.json'), 1024 * 1024);
    if (!manifest) throw new Error('adapter manifest is invalid');
    return {
      status: 'observed',
      present: true,
      routes: manifest.routes.map(route => ({ method: route.method, path: route.path })),
      sessions: manifest.sessions ? Object.keys(manifest.sessions).length : 0,
      moduleFile: inspected.moduleFile,
    };
  } catch (error) {
    throw new CapabilityError('invalid_args', '已有 runtime-adapter 无法安全纳入脚手架：' + String(error.message).slice(0, 180));
  }
}

function stateRules(siteId, contract, adapter) {
  return {
    schema: 'heimdall.backend-state-rules/1',
    siteId,
    status: 'inferred-draft',
    provenance: {
      observed: [
        ...(contract.status === 'observed' ? ['api-contract.json'] : []),
        ...(adapter.present ? ['runtime-adapter/manifest.json'] : []),
      ],
      inferred: ['authentication', 'permissions', 'state transitions', 'validation', 'persistence', 'side effects'],
      invented: [],
    },
    routes: routesOf(contract),
    rules: [],
    unknowns: ['authentication', 'permissions', 'state-machine', 'business-rules', 'persistence', 'side-effects',
      ...(contract.status !== 'observed' ? ['api-contract'] : [])],
    note: '这里故意留空；没有授权的真实旅程和业务规则时，Heimdall 不替人编造后端行为。已确认的规则可用 actor 标记执行身份，认证值仍只能通过环境变量引用。',
  };
}

function serverSource() {
  return String.raw`#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const portArg = process.argv.indexOf('--port');
const PORT = Number(process.env.PORT || (portArg >= 0 ? process.argv[portArg + 1] : 8080));
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ADAPTER_TIMEOUT_MS = 15_000;
const HOP_HEADERS = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
${isRuntimeAdapterPath.toString()}
${matchesRuntimeAdapterRoute.toString()}
const contract = readJson(join(ROOT, 'api-contract.json'), { openapi: { paths: {} }, status: 'missing' });
const contractRoutes = routeRows(contract);
const adapterManifest = readJson(join(ROOT, 'runtime-adapter', 'manifest.json'), null);
const dataDir = resolve(process.env.HEIMDALL_RUNTIME_DATA_DIR || join(ROOT, '..', basename(ROOT) + '-data'));
mkdirSync(dataDir, { recursive: true });
const gapFile = join(dataDir, 'adapter-gap-ledger.json');
let adapterModule = null;
let adapterError = null;
if (adapterManifest) {
  try {
    adapterModule = await import(new URL('./runtime-adapter/index.mjs', import.meta.url));
    if (typeof adapterModule.handle !== 'function') throw new Error('adapter handle function is missing');
  } catch (error) {
    adapterError = String(error.message || error);
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function routeRows(value) {
  const rows = [];
  for (const [path, item] of Object.entries(value?.openapi?.paths || {})) {
    for (const method of Object.keys(item || {})) {
      if (/^(get|head|post|put|patch|delete|options)$/i.test(method)) rows.push({ method: method.toUpperCase(), path });
    }
  }
  return rows.sort((a, b) => (a.method + ' ' + a.path).localeCompare(b.method + ' ' + b.path));
}
function manifestRows(value) {
  return Array.isArray(value?.routes) ? value.routes.map(item => ({ method: item.method, path: item.path })) : [];
}
function key(row) { return row.method + ' ' + row.path; }
const adapterRoutes = manifestRows(adapterManifest);
const adapterRouteSet = new Set(adapterRoutes.map(key));
const observedRouteSet = new Set(contractRoutes.map(key));
const initialLedger = {
  schema: 'heimdall.adapter-gap-ledger/1',
  source: 'b3-scaffold-runtime',
  status: 'not-run',
  updatedAt: null,
  summary: { runtimeRequests: 0, uniqueGaps: 0, unobservedPaths: 0, unobservedQueryVariants: 0, uncoveredQueryParameters: 0, missingResponseBodies: 0, unverifiedWrites: adapterRoutes.filter(item => !['GET', 'HEAD'].includes(item.method)).length },
  knownRoutes: adapterRoutes,
  gaps: [],
  unknowns: ['authentication-permission-unknown', 'business-state-unknown'],
};
const ledger = readJson(gapFile, initialLedger);
ledger.gaps = Array.isArray(ledger.gaps) ? ledger.gaps : [];
function safePath(value) {
  try { return new URL(String(value || '/'), 'http://adapter.local').pathname; } catch { return '/[invalid]'; }
}
function queryNames(value) {
  try { return [...new Set([...new URL('http://adapter.local' + (value || '')).searchParams.keys()].map(item => item.toLowerCase()))].sort(); } catch { return []; }
}
function saveLedger() {
  ledger.summary.runtimeRequests = ledger.gaps.reduce((sum, item) => sum + item.count, 0);
  ledger.summary.uniqueGaps = ledger.gaps.length;
  ledger.summary.unobservedPaths = ledger.gaps.filter(item => item.categories.includes('unobserved-path')).length;
  ledger.summary.unobservedQueryVariants = ledger.gaps.filter(item => item.categories.includes('unobserved-query-variant')).length;
  ledger.summary.uncoveredQueryParameters = ledger.gaps.filter(item => item.categories.includes('uncovered-query-parameter')).length;
  ledger.status = ledger.gaps.length ? 'needs-review' : ledger.summary.runtimeRequests ? 'no-gaps-observed' : 'not-run';
  ledger.updatedAt = new Date().toISOString();
  writeFileSync(gapFile + '.tmp', JSON.stringify(ledger, null, 2));
  renameSync(gapFile + '.tmp', gapFile);
}
function recordGap(details) {
  const method = String(details?.method || 'GET').toUpperCase();
  const path = safePath(details?.path);
  const params = [...new Set((details?.queryParams || queryNames(details?.search)).map(item => String(item).toLowerCase()))].sort().slice(0, 50);
  const category = ['unobserved-path', 'uncovered-query-parameter', 'unobserved-query-variant'].includes(details?.category) ? details.category : 'unobserved-path';
  const gapKey = method + ' ' + path + '|' + params.join(',') + '|' + category;
  const current = ledger.gaps.find(item => item.key === gapKey);
  if (current) current.count += 1;
  else ledger.gaps.push({ key: gapKey, method, path, queryParams: params, count: 1, categories: [category], nearestRoutes: [] });
  while (ledger.gaps.length > 200) ledger.gaps.shift();
  saveLedger();
}
function jsonResponse(res, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value, null, 2) + String.fromCharCode(10));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}
function health() {
  const missing = contractRoutes.filter(item => !matchesRuntimeAdapterRoute(adapterRouteSet, item.method, item.path));
  return {
    schema: 'heimdall.backend-health/1',
    level: 'B3-scaffold',
    siteId: contract.siteId || null,
    implementation: adapterModule ? 'observed-adapter-plus-stubs' : 'route-stubs-only',
    observedRoutes: contractRoutes.length,
    adapterRoutes: adapterRoutes.length,
    missingObservedRoutes: missing,
    unknowns: ['authentication', 'permissions', 'state-machine', 'business-rules', 'persistence', 'side-effects'],
    adapter: { present: !!adapterModule, loadError: adapterError, gapLedger: ledger.summary },
    warning: '这是可运行的后端起点，不是源站后端等价物。',
  };
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}
function requestHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name) || value == null) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}
${responseHeaders.toString()}
async function serveAdapter(req, res, url) {
  let body;
  try { body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req); }
  catch (error) { jsonResponse(res, error.status || 400, { error: error.message }); return; }
  const request = new Request('http://adapter.local' + url.pathname + url.search, {
    method: req.method,
    headers: requestHeaders(req),
    body: body && body.length ? body : undefined,
  });
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('adapter timed out')), ADAPTER_TIMEOUT_MS); });
    const response = await Promise.race([adapterModule.handle(request, { dataDir, method: req.method, recordGap }), deadline]);
    if (!(response instanceof Response)) throw new Error('adapter must return Response');
    res.writeHead(response.status, responseHeaders(response));
    if (req.method === 'HEAD' || !response.body) {
      await response.body?.cancel();
      res.end();
    } else {
      await pipeline(Readable.fromWeb(response.body), res);
    }
  } catch (error) {
    if (!res.headersSent) jsonResponse(res, String(error.message).includes('timed out') ? 504 : 500, { error: 'adapter_failed' });
    else res.destroy();
  } finally {
    clearTimeout(timer);
  }
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/__heimdall/health') return jsonResponse(res, 200, health());
  if (req.method === 'GET' && url.pathname === '/__heimdall/adapter-gaps') return jsonResponse(res, 200, ledger);
  if (req.method === 'GET' && url.pathname === '/__heimdall/contract') return jsonResponse(res, 200, contract);
  if (adapterModule) return serveAdapter(req, res, url);
  if (observedRouteSet.has(req.method + ' ' + url.pathname)) {
    return jsonResponse(res, 501, { error: 'not_implemented', message: '该观察到的路由还没有业务实现。' }, { 'X-Heimdall-Provenance': 'scaffold' });
  }
  return jsonResponse(res, 404, { error: 'not_found' });
});
server.on('error', error => { console.error('[heimdall-backend] ' + error.message); process.exitCode = 1; });
server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  console.log('HEIMDALL_BACKEND_READY http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + port);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
`;
}

function checksSource() {
  return String.raw`#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8080').replace(new RegExp('/$'), '');
const onlyBusinessRules = process.argv.includes('--business-rules-only');
const contract = JSON.parse(readFileSync(join(ROOT, 'api-contract.json'), 'utf8'));
let stateRules = { rules: [] };
try { stateRules = JSON.parse(readFileSync(join(ROOT, 'state-rules.json'), 'utf8')); } catch { stateRules = { rules: null }; }
const rows = [];
function responseRows(operation) {
  return Object.entries(operation?.responses || {})
    .filter(([status]) => /^[0-9]{3}$/.test(status))
    .map(([status, response]) => {
      const content = response && typeof response === 'object' && !Array.isArray(response) ? response.content || {} : {};
      return {
        status: Number(status),
        mimeTypes: Object.keys(content).map(value => String(value).split(';', 1)[0].trim().toLowerCase()).filter(Boolean).sort(),
        schemas: Object.entries(content).map(([mimeType, item]) => ({
          mimeType: String(mimeType).split(';', 1)[0].trim().toLowerCase(),
          schema: item && (typeof item.schema === 'boolean' || (item.schema && typeof item.schema === 'object' && !Array.isArray(item.schema))) ? item.schema : null,
        })).filter(item => item.schema !== null),
      };
    });
}
for (const [path, item] of Object.entries(contract.openapi?.paths || {})) {
  for (const method of Object.keys(item || {})) {
    if (!/^(get|head|post|put|patch|delete|options)$/i.test(method)) continue;
    const operation = item[method] || {};
    const observations = operation['x-heimdall-observations'] || {};
    rows.push({
      method: method.toUpperCase(),
      path,
      queryParams: Array.isArray(observations.queryParams) ? [...new Set(observations.queryParams.map(String))].sort() : [],
      authSchemes: Array.isArray(observations.authSchemes) ? [...new Set(observations.authSchemes.map(String))].sort() : [],
      responses: responseRows(operation),
    });
  }
}
function normalizeMime(value) { return String(value || '').split(';', 1)[0].trim().toLowerCase(); }
function mimeMatches(actual, expected) {
  const left = normalizeMime(actual);
  const right = normalizeMime(expected);
  if (!left || !right) return false;
  if (right === '*/*' || left === right) return true;
  const [leftType] = left.split('/');
  const [rightType, rightSubtype] = right.split('/');
  return rightSubtype === '*' && leftType === rightType;
}
function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}
function schemaError(value, schema, path = '$') {
  if (schema === false) return { path, expected: 'false schema', actual: actualType(value) };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const actual = actualType(value);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => type === actual || (type === 'number' && actual === 'integer'))
    && !(value === null && schema.nullable === true)) {
    return { path, expected: types.join('|'), actual };
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(schema[key])) continue;
    const errors = schema[key].map(branch => schemaError(value, branch, path));
    const matches = errors.filter(error => error === null).length;
    if ((key === 'oneOf' && matches !== 1) || (key === 'anyOf' && !matches)
      || (key === 'allOf' && matches !== errors.length)) {
      return key === 'allOf' ? errors.find(Boolean) : { path, expected: key, actual, matchedBranches: matches };
    }
  }
  if (actual === 'object') {
    if (schema.required && schema.required.some(name => !Object.prototype.hasOwnProperty.call(value, name))) {
      return { path, expected: 'required property', actual: 'missing' };
    }
    for (const [name, child] of Object.entries(schema.properties || {})) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      const error = schemaError(value[name], child, path + '.' + name);
      if (error) return error;
    }
  }
  if (actual === 'array' && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const error = schemaError(value[index], schema.items, path + '[' + index + ']');
      if (error) return error;
    }
  }
  return null;
}
const RULE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token']);
const JSON_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
function envName(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null; }
function actorLabel(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) ? value : null; }
function withActor(actor, value) { return actor ? { actor, ...value } : value; }
function headerValue(value) {
  if (typeof value === 'string') return { value, missing: false };
  const name = envName(value?.env);
  return name ? { value: process.env[name] ?? null, missing: process.env[name] === undefined } : { value: null, invalid: true };
}
function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}
function pointerValue(value, pointer) {
  if (pointer === '') return { found: true, value };
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 256) return { invalid: true };
  let current = value;
  for (const part of pointer.slice(1).split('/').map(item => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(Object(current), part)) return { found: false };
    current = current[part];
  }
  return { found: true, value: current };
}
function responseFieldPath(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8
    || value.some(part => typeof part !== 'string' || !part || part.length > 100 || /[\x00-\x1f\x7f]/.test(part))) return null;
  return [...value];
}
function responseReference(value, stepIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['response', 'path'].includes(key))) return null;
  if (!Number.isInteger(value.response) || value.response < 0 || value.response >= stepIndex) return null;
  const path = responseFieldPath(value.path);
  return path ? { response: value.response, path } : null;
}
function safeReferenceValue(value) {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
}
function prepareRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return { error: 'invalid_rule' };
  const id = typeof rule.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(rule.id) ? rule.id : null;
  if (!id || !Array.isArray(rule.steps) || !rule.steps.length || rule.steps.length > 16) return { error: 'invalid_rule' };
  const actor = rule.actor === undefined ? null : actorLabel(rule.actor);
  if (rule.actor !== undefined && !actor) return { id, error: 'invalid_actor' };
  const steps = [];
  for (let stepIndex = 0; stepIndex < rule.steps.length; stepIndex += 1) {
    const step = rule.steps[stepIndex];
    const method = String(step?.method || '').toUpperCase();
    const path = step?.path;
    if (!RULE_METHODS.has(method) || typeof path !== 'string' || !path.startsWith('/') || path.length > 512 || path.includes('\\0') || path.includes('\\\\')) return { id, error: 'invalid_step' };
    const names = path.split('/').map(part => /^\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}$/.exec(part)?.[1] ?? null).filter(Boolean);
    if (path.split('/').some(part => /[{}]/.test(part) && !/^\{[A-Za-z_][A-Za-z0-9_.-]{0,63}\}$/.test(part))
      || new Set(names).size !== names.length) return { id, error: 'invalid_path_params' };
    let pathParams;
    if (names.length || step.pathParams !== undefined) {
      if (!names.length || !step.pathParams || typeof step.pathParams !== 'object' || Array.isArray(step.pathParams)
        || Object.keys(step.pathParams).length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(step.pathParams, name))) {
        return { id, error: 'invalid_path_params' };
      }
      pathParams = Object.fromEntries(names.map(name => {
        const reference = responseReference(step.pathParams[name], stepIndex);
        return [name, reference];
      }));
      if (Object.values(pathParams).some(reference => !reference)) return { id, error: 'invalid_path_params' };
    }
    const expect = step.expect && typeof step.expect === 'object' && !Array.isArray(step.expect) ? step.expect : null;
    const statuses = Array.isArray(expect?.status) ? expect.status : expect?.status === undefined ? [] : [expect.status];
    if (!expect || !statuses.length || statuses.some(status => !Number.isInteger(status) || status < 100 || status > 599)) return { id, error: 'missing_expected_status' };
    const headers = {};
    for (const [name, raw] of Object.entries(step.headers || {})) {
      if (!/^[A-Za-z0-9-]{1,80}$/.test(name)) return { id, error: 'invalid_header' };
      const resolved = headerValue(raw);
      if (resolved.invalid || (SENSITIVE_HEADERS.has(name.toLowerCase()) && typeof raw === 'string') || resolved.missing) return { id, error: resolved.missing ? 'missing_env' : 'invalid_header' };
      headers[name] = resolved.value;
    }
    let body = undefined;
    if (step.bodyEnv !== undefined) {
      const bodyName = envName(step.bodyEnv);
      if (!bodyName || process.env[bodyName] === undefined) return { id, error: 'missing_env' };
      try { JSON.parse(process.env[bodyName]); } catch { return { id, error: 'invalid_body' }; }
      body = process.env[bodyName];
      if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }
    const rawJsonAssertions = Array.isArray(expect.json) ? expect.json.slice(0, 32) : [];
    if (expect.json !== undefined && !Array.isArray(expect.json)) return { id, error: 'invalid_json_assertions' };
    const jsonAssertions = rawJsonAssertions.map(assertion => {
      if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion) || typeof assertion.pointer !== 'string') return null;
      if (!Object.prototype.hasOwnProperty.call(assertion, 'equalsFrom')) return assertion;
      if (Object.prototype.hasOwnProperty.call(assertion, 'equals')) return null;
      const reference = responseReference(assertion.equalsFrom, stepIndex);
      return reference ? { ...assertion, equalsFrom: reference } : null;
    });
    if (jsonAssertions.some(assertion => !assertion)) return { id, error: 'invalid_json_assertion' };
    if (expect.type !== undefined && (typeof expect.type !== 'string' || !JSON_TYPES.has(expect.type))) return { id, error: 'invalid_expected_type' };
    steps.push({ method, path, headers, body, statuses, expect, jsonAssertions, ...(pathParams ? { pathParams } : {}) });
  }
  return { id, ...(actor ? { actor } : {}), steps };
}
function assertionError(value, assertion) {
  const actual = pointerValue(value, assertion.pointer);
  if (actual.invalid) return { reason: 'invalid_json_pointer', pointer: assertion.pointer.slice(0, 128) };
  if (assertion.exists !== undefined && assertion.exists !== actual.found) return { reason: 'json_assertion', pointer: assertion.pointer.slice(0, 128) };
  if (!actual.found) return assertion.exists === false ? null : { reason: 'json_assertion', pointer: assertion.pointer.slice(0, 128) };
  if (assertion.type !== undefined && (typeof assertion.type !== 'string' || !JSON_TYPES.has(assertion.type) || actualType(actual.value) !== assertion.type)) return { reason: 'json_assertion', pointer: assertion.pointer.slice(0, 128) };
  if (Object.prototype.hasOwnProperty.call(assertion, 'equals') && !sameJson(actual.value, assertion.equals)) return { reason: 'json_assertion', pointer: assertion.pointer.slice(0, 128) };
  if (Object.prototype.hasOwnProperty.call(assertion, 'contains')) {
    const expected = assertion.contains;
    const matches = typeof actual.value === 'string' ? actual.value.includes(String(expected))
      : Array.isArray(actual.value) ? actual.value.some(item => sameJson(item, expected)) : false;
    if (!matches) return { reason: 'json_assertion', pointer: assertion.pointer.slice(0, 128) };
  }
  return null;
}
async function runBusinessRule(rule) {
  const rawId = typeof rule?.id === 'string' ? rule.id : 'unknown';
  const rawIdSafe = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(rawId) ? rawId : 'unknown';
  const rawActor = actorLabel(rule?.actor);
  const rawHasWrite = Array.isArray(rule?.steps) && rule.steps.some(step => WRITE_METHODS.has(String(step?.method || '').toUpperCase()));
  if (rawHasWrite && process.env.HEIMDALL_ALLOW_WRITES !== '1') {
    return withActor(rawActor, { id: 'business-rule:' + rawIdSafe, status: 'skipped', reason: 'write_requires_explicit_local_authorization', requiresHumanApproval: true });
  }
  const prepared = prepareRule(rule);
  const id = 'business-rule:' + String(prepared.id || 'unknown').slice(0, 80);
  const actor = prepared.actor || rawActor;
  const report = value => withActor(actor, value);
  if (prepared.error) return report({ id, status: prepared.error === 'missing_env' || prepared.error === 'invalid_body' ? 'incomplete' : 'failed', reason: prepared.error, requiresHumanApproval: prepared.error === 'missing_env' });
  const responses = [];
  const pointerFor = path => '/' + path.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
  const readJson = async index => {
    const state = responses[index];
    if (!state) return { error: 'reference_unavailable' };
    if (state.bodyRead) return state.bodyError ? { error: state.bodyError } : { value: state.body };
    state.bodyRead = true;
    try {
      const raw = await state.response.text();
      if (raw.length > 2 * 1024 * 1024) { state.bodyError = 'response_too_large'; return { error: state.bodyError }; }
      state.body = JSON.parse(raw);
      return { value: state.body };
    } catch {
      state.bodyError = 'invalid_json_response';
      return { error: state.bodyError };
    }
  };
  const resolvePath = async step => {
    let resolved = step.path;
    for (const [name, reference] of Object.entries(step.pathParams ?? {})) {
      const source = await readJson(reference.response);
      if (source.error) return { error: 'reference_unavailable', pointer: pointerFor(reference.path) };
      const actual = pointerValue(source.value, pointerFor(reference.path));
      const value = actual.found ? actual.value : null;
      const safeNumber = typeof value !== 'number' || (Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
      if (actual.invalid || !actual.found || !['string', 'number', 'boolean'].includes(typeof value) || !safeNumber) {
        return { error: 'reference_unavailable', pointer: pointerFor(reference.path) };
      }
      resolved = resolved.replace('{' + name + '}', encodeURIComponent(String(value)));
    }
    return { path: resolved };
  };
  for (let index = 0; index < prepared.steps.length; index += 1) {
    const step = prepared.steps[index];
    const resolved = await resolvePath(step);
    if (resolved.error) return report({ id, status: 'incomplete', step: index + 1, reason: resolved.error, pointer: resolved.pointer });
    let response;
    try { response = await fetch(base + resolved.path, { method: step.method, headers: step.headers, body: step.body }); }
    catch { return report({ id, status: 'failed', step: index + 1, reason: 'request_failed' }); }
    responses.push({ response, bodyRead: false, body: null, bodyError: null });
    if (!step.statuses.includes(response.status)) return report({ id, status: 'failed', step: index + 1, httpStatus: response.status, expectedStatuses: step.statuses, reason: 'unexpected_status' });
    const expectedMime = step.expect.contentType;
    if (expectedMime !== undefined) {
      const allowed = Array.isArray(expectedMime) ? expectedMime : [expectedMime];
      if (!allowed.some(item => typeof item === 'string' && normalizeMime(item) === normalizeMime(response.headers.get('content-type')))) return report({ id, status: 'failed', step: index + 1, httpStatus: response.status, reason: 'unexpected_content_type' });
    }
    if (step.jsonAssertions.length || step.expect.type !== undefined) {
      const parsed = await readJson(index);
      if (parsed.error) return report({ id, status: 'failed', step: index + 1, reason: parsed.error });
      const value = parsed.value;
      if (step.expect.type !== undefined && actualType(value) !== step.expect.type) return report({ id, status: 'failed', step: index + 1, reason: 'json_assertion' });
      for (const assertion of step.jsonAssertions) {
        let resolvedAssertion = assertion;
        if (assertion.equalsFrom) {
          const source = await readJson(assertion.equalsFrom.response);
          if (source.error) return report({ id, status: 'incomplete', step: index + 1, reason: 'reference_unavailable', pointer: pointerFor(assertion.equalsFrom.path) });
          const actual = pointerValue(source.value, pointerFor(assertion.equalsFrom.path));
          if (actual.invalid || !actual.found || !safeReferenceValue(actual.value)) {
            return report({ id, status: 'incomplete', step: index + 1, reason: 'reference_unavailable', pointer: pointerFor(assertion.equalsFrom.path) });
          }
          resolvedAssertion = { ...assertion, equals: actual.value };
        }
        const error = assertionError(value, resolvedAssertion);
        if (error) return report({ id, status: 'failed', step: index + 1, ...error });
      }
    }
  }
  return report({ id, status: 'passed', steps: prepared.steps.length, checkedSteps: prepared.steps.length });
}
async function runBusinessRules() {
  if (stateRules?.rules === undefined || stateRules?.rules === null) return [{ id: 'business-rules', status: 'failed', reason: 'invalid_rules_file' }];
  if (!Array.isArray(stateRules.rules)) return [{ id: 'business-rules', status: 'failed', reason: 'invalid_rules_file' }];
  if (!stateRules.rules.length) return onlyBusinessRules
    ? [{ id: 'business-rules', status: 'incomplete', reason: 'no_business_rules_declared' }]
    : [];
  if (stateRules.status !== 'reviewed' || (Array.isArray(stateRules.provenance?.invented) && stateRules.provenance.invented.length)) {
    return [{ id: 'business-rules', status: 'skipped', reason: stateRules.status !== 'reviewed' ? 'rules_require_human_review' : 'invented_rules_require_review', requiresHumanApproval: true }];
  }
  return Promise.all(stateRules.rules.slice(0, 32).map(runBusinessRule));
}
async function inspectResponse(route, response) {
  const expectedStatuses = route.responses.map(item => item.status);
  const expected = route.responses.find(item => item.status === response.status);
  const actualMimeType = normalizeMime(response.headers.get('content-type'));
  if (response.status === 501) return { status: 'not_implemented', httpStatus: response.status, expectedStatuses, actualMimeType };
  if (expectedStatuses.length && !expectedStatuses.includes(response.status)) {
    return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, reason: '响应状态码没有出现在观察契约中' };
  }
  const expectedMimeTypes = expected?.mimeTypes || [];
  if (expectedMimeTypes.length && !expectedMimeTypes.some(item => mimeMatches(actualMimeType, item))) {
    return { status: 'failed', httpStatus: response.status, expectedStatuses, expectedMimeTypes, actualMimeType, reason: '响应 MIME 没有出现在观察契约中' };
  }
  const schemaCandidates = (expected?.schemas || []).filter(item => !item.mimeType || mimeMatches(actualMimeType, item.mimeType));
  if (schemaCandidates.length && route.method !== 'HEAD' && response.status !== 204 && response.status !== 304) {
    const raw = await response.text();
    if (!raw.trim()) return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, reason: '契约声明了响应结构，但实际响应没有响应体' };
    let value;
    try { value = JSON.parse(raw); }
    catch { return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, reason: '契约声明 JSON 结构，但实际响应不是合法 JSON' }; }
    const errors = schemaCandidates.map(item => schemaError(value, item.schema)).filter(Boolean);
    if (errors.length === schemaCandidates.length) {
      return { status: 'failed', httpStatus: response.status, expectedStatuses, actualMimeType, schemaError: errors[0], reason: '响应 JSON 不满足观察到的字段结构' };
    }
  }
  return { status: response.status >= 500 ? 'failed' : 'implemented', httpStatus: response.status, expectedStatuses, expectedMimeTypes, actualMimeType };
}
function repairTaskFor(item) {
  const id = String(item?.id || '');
  if (id === 'business-rules' || id.startsWith('business-rule:')) return {
    id: 'repair-business-rule-' + (id === 'business-rules' ? 'review' : id.slice('business-rule:'.length).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 64) || 'unknown'),
    kind: 'business-rule', target: 'state-rules.json',
    instruction: item.status === 'skipped' ? '先确认业务规则和写入授权，再把 state-rules.json 标记为 reviewed 后重新运行 npm run check。'
      : '修正业务规则或后端实现，再运行 npm run check；报告不会保存请求体、认证值或响应正文。',
    requiresHumanApproval: item.requiresHumanApproval === true || item.status === 'skipped',
    evidence: {
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 96) : 'business-rule-failed',
      ...(typeof item.actor === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item.actor) ? { actor: item.actor } : {}),
    },
  };
  if (id === 'health') return {
    id: 'repair-service-health', kind: 'service-health', target: 'server.mjs',
    instruction: '先修复服务启动或健康端点，再运行 npm run check。', requiresHumanApproval: false,
  };
  if (id === 'adapter-coverage') return {
    id: 'repair-route-coverage', kind: 'route-coverage', target: 'runtime-adapter/index.mjs',
    instruction: '补齐观察到但适配器未覆盖的路由；证据不足时先补观察契约。', requiresHumanApproval: false,
    evidence: { missingObservedRoutes: Array.isArray(item.missingObservedRoutes) ? item.missingObservedRoutes.length : 0 },
  };
  if (id === 'adapter-gap-ledger') {
    const uniqueGaps = Number(item.uniqueGaps || 0);
    const unobservedQueryVariants = Number(item.unobservedQueryVariants || 0);
    const uncoveredQueryParameters = Number(item.uncoveredQueryParameters || 0);
    const unverifiedWrites = Number(item.unverifiedWrites || 0);
    const kind = unverifiedWrites > 0 ? 'write-verification' : unobservedQueryVariants > 0 ? 'query-variant-gap' : uncoveredQueryParameters > 0 ? 'query-parameter-gap' : 'runtime-gap';
    const instruction = unverifiedWrites > 0
      ? '先用授权测试旅程验证写入、回读和清理，再修改适配器。'
      : unobservedQueryVariants > 0
        ? '为已知查询参数补齐未观察到的值或组合；先用独立留出请求验证，再运行 npm run check。'
      : uncoveredQueryParameters > 0
        ? '补齐查询参数名对应的路由分支，再运行 npm run check。'
        : '补齐运行时发现但契约未声明的路由，再运行 npm run check。';
    return {
      id: 'repair-' + kind, kind, target: 'runtime-adapter/index.mjs', instruction,
      requiresHumanApproval: unverifiedWrites > 0,
      evidence: { uniqueGaps, unobservedQueryVariants, uncoveredQueryParameters, unverifiedWrites },
    };
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) /.test(id)) return null;
  const target = id.slice(0, 256);
  const taskId = 'repair-' + target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  if (item.status === 'not_implemented') return {
    id: taskId || 'repair-route-implementation', kind: 'route-implementation', target,
    instruction: '根据观察到的契约实现这个路由；不要臆造认证、权限或业务副作用。', requiresHumanApproval: false,
  };
  if (item.status === 'skipped') return {
    id: taskId || 'repair-authorized-journey', kind: item.authSchemes?.length ? 'authentication-verification' : 'authorized-journey', target,
    instruction: item.authSchemes?.length ? '用明确登录档和权限旅程验收该路由；不要为通过匿名检查放宽认证。'
      : '先补明确授权的测试数据和业务旅程，再实现该路由并复测。', requiresHumanApproval: true,
  };
  return {
    id: taskId || 'repair-response-contract', kind: 'response-contract', target,
    instruction: '按观察契约修正响应状态码、MIME 或有限 JSON 结构，再运行 npm run check。', requiresHumanApproval: false,
    evidence: {
      httpStatus: item.httpStatus,
      expectedStatuses: Array.isArray(item.expectedStatuses) ? item.expectedStatuses.slice(0, 30) : [],
      expectedMimeTypes: Array.isArray(item.expectedMimeTypes) ? item.expectedMimeTypes.slice(0, 20) : [],
      actualMimeType: typeof item.actualMimeType === 'string' ? item.actualMimeType.slice(0, 128) : undefined,
      schemaPath: typeof item.schemaError?.path === 'string' ? item.schemaError.path.slice(0, 128) : undefined,
    },
  };
}
function attachRepairTask(item) {
  if (!['failed', 'incomplete', 'not_implemented', 'skipped'].includes(item?.status)) return item;
  const repairTask = repairTaskFor(item);
  return repairTask ? { ...item, repairTask } : item;
}
function overallOf(items) {
  if (items.some(item => item.status === 'failed')) return 'failed';
  if (items.some(item => ['incomplete', 'not_implemented', 'skipped'].includes(item.status))) return 'incomplete';
  return 'passed';
}
const results = [];
try {
  if (onlyBusinessRules) {
    results.push(...await runBusinessRules());
  } else {
  const health = await fetch(base + '/__heimdall/health');
  let healthJson = null;
  try { healthJson = await health.json(); } catch {}
  results.push({ id: 'health', status: health.ok ? 'passed' : 'failed', httpStatus: health.status });
  if (!health.ok || !healthJson) throw new Error('health check failed');
  const missingObservedRoutes = Array.isArray(healthJson.missingObservedRoutes) ? healthJson.missingObservedRoutes : null;
  results.push({
    id: 'adapter-coverage',
    status: missingObservedRoutes?.length ? 'incomplete' : missingObservedRoutes ? 'passed' : 'incomplete',
    adapterPresent: healthJson.adapter?.present === true,
    missingObservedRoutes: missingObservedRoutes || [],
    reason: missingObservedRoutes?.length ? '适配器没有覆盖全部观察到的路由' : missingObservedRoutes ? undefined : '健康端点没有提供观察路由覆盖结果',
  });
  for (const route of rows) {
    if (route.method !== 'GET' && route.method !== 'HEAD') {
      results.push({ id: route.method + ' ' + route.path, status: 'skipped', reason: '写入路由需要人工授权和业务规则' });
      continue;
    }
    if (route.path.includes('{')) {
      results.push({ id: route.method + ' ' + route.path, status: 'skipped', reason: '路径参数需要具体测试数据' });
      continue;
    }
    if (route.authSchemes.length) {
      results.push({ id: route.method + ' ' + route.path, status: 'skipped', authSchemes: route.authSchemes,
        reason: '已观察到认证材料，当前匿名检查无法核实；请使用明确登录档和权限旅程' });
      continue;
    }
    const response = await fetch(base + route.path, { method: route.method });
    results.push({ id: route.method + ' ' + route.path, queryParams: route.queryParams, ...(await inspectResponse(route, response)) });
  }
  try {
    const gapResponse = await fetch(base + '/__heimdall/adapter-gaps');
    const gapLedger = await gapResponse.json();
    const summary = gapLedger?.summary || {};
    results.push({
      id: 'adapter-gap-ledger',
      status: !gapResponse.ok ? 'failed' : Number(summary.uniqueGaps || 0) > 0 ? 'failed' : Number(summary.unverifiedWrites || 0) > 0 ? 'incomplete' : 'passed',
      ledgerStatus: gapLedger?.status || 'unknown',
      uniqueGaps: Number(summary.uniqueGaps || 0),
      unobservedQueryVariants: Number(summary.unobservedQueryVariants || 0),
      uncoveredQueryParameters: Number(summary.uncoveredQueryParameters || 0),
      unverifiedWrites: Number(summary.unverifiedWrites || 0),
      reason: Number(summary.uniqueGaps || 0) > 0 ? '运行时发现未观察路径、查询变体或未覆盖查询参数' : Number(summary.unverifiedWrites || 0) > 0 ? '写入路由仍只有回放证据，尚未完成业务验证' : undefined,
    });
  } catch (error) {
    results.push({ id: 'adapter-gap-ledger', status: 'failed', reason: '无法读取适配器缺口账本：' + String(error.message || error).slice(0, 180) });
  }
  results.push(...await runBusinessRules());
  }
} catch (error) {
  results.push({ id: 'server', status: 'failed', reason: String(error.message || error) });
}
for (let index = 0; index < results.length; index += 1) results[index] = attachRepairTask(results[index]);
let overall = overallOf(results);
const repairTasks = results.map(item => item.repairTask).filter(Boolean);
const report = { schema: 'heimdall.backend-check/1', generatedAt: new Date().toISOString(), base,
  mode: onlyBusinessRules ? 'business-rules-only' : 'scaffold', overall, results, repairTasks,
  note: onlyBusinessRules ? '只表示声明的业务规则在当前 base 上通过，不代表服务健康、路由覆盖或完整后端等价。'
    : '通过只表示脚手架能启动并完成当前检查，不代表业务正确。' };
try {
  writeFileSync(join(ROOT, 'backend-check.json.tmp'), JSON.stringify(report, null, 2) + String.fromCharCode(10), 'utf8');
  renameSync(join(ROOT, 'backend-check.json.tmp'), join(ROOT, 'backend-check.json'));
} catch (error) {
  results.push({ id: 'report', status: 'failed', reason: '检查结果无法落盘：' + String(error.message || error).slice(0, 180) });
  overall = overallOf(results);
}
console.log(JSON.stringify({ ...report, overall, results }, null, 2));
process.exitCode = overall === 'passed' ? 0 : 1;
`;
}

function readmeSource({ siteId, outDir, adapter, routes }) {
  const routeText = routes.length ? routes.map(item => '- ' + item.method + ' ' + item.path).join('\n') : '- 没有可用的观察型 API 路由';
  const adapterText = adapter.present
    ? '已纳入现有 B2 观察回放适配器（' + adapter.routes.length + ' 条路由）；它只证明已观察样本的回放能力。'
    : '没有纳入 B2 适配器；已观察路由会返回 501，等待 AI 或开发者补实现。';
  return [
    '# Heimdall B3 后端脚手架',
    '',
    '站点：' + siteId,
    '当前级别：B3-scaffold',
    '输出目录：' + outDir,
    '',
    '## 先说人话',
    '',
    '这是一个能启动、能看健康状态、能逐条补路由的后端起点，不是源站后端的复制品。',
    '观察到的内容来自脱敏 API 契约；没有观察到的认证、权限、状态机、持久化和副作用都留在未知项里。',
    adapterText,
    'backend-task.json 是给 AI 使用的脱敏任务包：它列出 observed 端点、修复边界和确定性复测命令；运行后应以最新 backend-check.json 与 site-assessment 为准。',
    '',
    '## 已观察路由',
    '',
    routeText,
    '',
    '## 运行',
    '',
    'npm start',
    '打开 http://127.0.0.1:8080/__heimdall/health 查看当前状态。',
    '运行 npm run check 做健康、只读路由和未实现项检查。',
    '要做业务后端检查：在 state-rules.json 中填写 rules，并先把 status 改为 reviewed；每条规则由多个 HTTP 步骤和 status / contentType / JSON Pointer 断言组成。',
    '步骤路径可以使用完整段参数（例如 /items/{id}）；pathParams 用 response + path 引用较早步骤的 JSON 标量，值只在内存中解析并按 URL 段编码，不会写入报告。',
    '规则可用 actor 标记匿名、所有者或其他测试身份；规则中的 Authorization、Cookie 和请求体只通过环境变量引用，写入规则还需要显式设置 HEIMDALL_ALLOW_WRITES=1。',
    '检查报告只保留规则 ID、步骤、状态和脱敏断言位置，不保存请求体、认证值或响应正文。',
    '要在获授权源站复测同一规则，可运行 node checks.mjs https://source.example --business-rules-only；报告会标记为 business-rules-only，不包含脚手架健康和缺口门禁。',
    '需要外置状态目录时设置 HEIMDALL_RUNTIME_DATA_DIR；默认目录在脚手架目录旁边。',
    'AI 补写有状态处理器时使用 handle(request, { dataDir }) 的包外目录保存数据；读回、重启和删除都要用独立预期另行核验，不能只看写请求返回成功。',
    'manifest 路由支持完整路径段参数，例如 /posts/{postId}；每个参数只匹配一个非空段，方法仍须逐项声明，会话初始化路由只接受固定路径。',
    'npm run check 不会自动构造参数值或执行写操作；缺少具体测试数据的参数路由仍标为未完成。',
    '已观察到认证材料的读取路由也保留未完成；使用明确登录档和权限旅程验证，不为通过匿名检查放宽认证。',
    '服务复用 live 运行时的响应头处理，逐条转发 Set-Cookie，保留会话及签名 Cookie 和含逗号的 Expires。',
    '',
    'Docker 部署：',
    '',
    'docker build -t site-backend .',
    'docker volume create site-backend-data',
    'docker run --rm --publish 127.0.0.1:8080:8080 --mount type=volume,source=site-backend-data,target=/data site-backend',
    '',
    '镜像内监听 0.0.0.0，状态目录为 /data。复用同一命名卷可在重建容器后保留状态；每个项目使用自己的卷。',
    '直接运行 Node 仍默认只监听 127.0.0.1；确认访问边界后可设置 HOST。',
    '',
    '## 生成证据',
    '',
    'api-contract.json：脱敏的观察型接口形状。',
    'state-rules.json：待人工确认的状态规则草稿，当前没有自动编造规则。',
    'runtime-adapter/：如果纳入，只有 manifest.json 和 index.mjs。',
    'checks.mjs：本地可重复检查，并把最近一次结果写入 backend-check.json。',
    'JSON 检查覆盖类型（含可空）、必填字段、数组项和 oneOf / anyOf / allOf；组合最多 20 个分支、结构深度最多 8 层，超限拒绝生成。',
    '这不是完整 JSON Schema 验证器；引用、枚举、数值范围和格式需要另行验证。',
    '',
    '## 未完成且不能猜的事情',
    '',
    '- 登录、退出、凭据刷新和失效。',
    '- 角色、权限、资源边界和拒绝口径。',
    '- 创建、更新、删除、回滚、幂等和持久化。',
    '- 消息、邮件、支付、Webhook 等副作用。',
    '- 路径参数、异常输入和业务数据清理。',
    '',
    '验证时请把 observed、inferred、invented、unknown 分开写；当前 invented 数量为 0。',
    '',
  ].join('\n');
}

function packageSource(siteId) {
  return json({
    name: 'heimdall-' + siteId + '-backend-scaffold',
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=22.13.0' },
    scripts: { start: 'node server.mjs', check: 'node checks.mjs' },
  });
}

function build(flags, positional) {
  if (positional[0] === 'compare') return compareReports(flags, positional);
  if (positional[0] !== 'scaffold' || !positional[1]) {
    throw new CapabilityError('invalid_args', '用法：heimdall backend scaffold <siteId> [--out D] [--force] [--json]；或 backend compare <source-check.json> <candidate-check.json> [--out FILE]');
  }
  const siteId = assertSiteId(positional[1]);
  const root = siteDir(siteId);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new CapabilityError('not_found', '没有站点 ' + siteId, { hint: '运行 heimdall overview 列出已有站点。' });
  }
  const base = process.env.HEIMDALL_INVOKE_CWD ?? process.cwd();
  const outDir = resolve(base, flags.out ? String(flags.out) : join(root, 'backend-scaffold'));
  if (existsSync(outDir)) {
    const stat = lstatSync(outDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CapabilityError('invalid_args', '输出目录不是普通目录：' + outDir);
    if (!flags.force && readdirSync(outDir).length) {
      throw new CapabilityError('invalid_args', '输出目录已有文件：' + outDir, { hint: '确认覆盖后加 --force，或换一个 --out 目录。' });
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }
  const source = findContract(root);
  const contract = projectContract(source.source, siteId, source.status);
  const adapter = readAdapter(root);
  const routes = routesOf(contract);
  const task = backendTask({ siteId, contract, adapter, routes });
  const dockerfile = [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY package.json server.mjs checks.mjs api-contract.json state-rules.json ./',
    ...(adapter.present ? ['COPY runtime-adapter ./runtime-adapter'] : []),
    'ENV NODE_ENV=production HOST=0.0.0.0 HEIMDALL_RUNTIME_DATA_DIR=/data',
    'VOLUME ["/data"]',
    'EXPOSE 8080',
    'CMD ["node", "server.mjs"]',
    '',
  ].join('\n');
  const files = [
    ['package.json', packageSource(siteId)],
    ['server.mjs', serverSource()],
    ['checks.mjs', checksSource()],
    ['api-contract.json', json(contract)],
    ['state-rules.json', json(stateRules(siteId, contract, adapter))],
    ['backend-task.json', json(task)],
    ['Dockerfile', dockerfile],
  ];
  for (const [name, value] of files) writeFileChecked(join(outDir, name), value);
  if (adapter.present) {
    const target = join(outDir, 'runtime-adapter');
    mkdirSync(target, { recursive: true });
    writeFileChecked(join(target, 'manifest.json'), json(readJson(join(root, 'runtime-adapter', 'manifest.json'), {})));
    writeFileChecked(join(target, 'index.mjs'), readFileSync(adapter.moduleFile, 'utf8'));
  }
  writeFileChecked(join(outDir, 'README.md'), readmeSource({ siteId, outDir, adapter, routes }));
  const unknowns = ['authentication', 'permissions', 'state-machine', 'business-rules', 'persistence', 'side-effects'];
  if (source.status !== 'observed') unknowns.push('api-contract:' + source.status);
  return ok({
    schema: 'heimdall.backend-scaffold/1',
    siteId,
    level: 'B3-scaffold',
    outDir,
    contract: { status: source.status, source: source.path, observedRoutes: routes.length },
    adapter: { status: adapter.status, present: adapter.present, routes: adapter.routes.length, sessions: adapter.sessions ?? 0 },
    files: files.map(([name]) => name).concat(adapter.present ? ['runtime-adapter/manifest.json', 'runtime-adapter/index.mjs'] : ['runtime-adapter/ not copied']),
    task: { path: 'backend-task.json', status: task.status, schema: task.schema },
    provenance: { observed: source.status === 'observed' ? ['api-contract.json'] : [], inferred: ['state-rules.json', 'checks.mjs'], invented: [] },
    unknowns,
    verification: { commands: ['npm start', 'npm run check', 'GET /__heimdall/health', 'GET /__heimdall/adapter-gaps'] },
  }, {
    summary: 'B3 后端脚手架已生成：' + outDir + '；观察到 ' + routes.length + ' 条路由，' + (adapter.present ? '已带观察回放适配器' : '没有适配器，路由先返回 501') + '。',
    warnings: [
      '这是可运行的后端起点，不是源站后端等价物。',
      ...(source.status !== 'observed' ? ['API 契约状态为 ' + source.status + '，没有自动发明接口。'] : []),
      ...(adapter.present ? ['已复制现有 runtime-adapter；它仍只代表观察样本回放。'] : []),
    ],
  });
}

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const env = (() => {
    try { return build(flags, positional); } catch (error) { return fromError(error); }
  })();
  process.stdout.write((flags.json ? JSON.stringify(env) : [
    env.summary,
    ...(env.warnings ?? []).map(item => '! ' + item),
    ...(env.ok ? ['输出：' + env.result.outDir, '下一步：npm start，然后运行 npm run check。'] : ['[' + env.error.code + '] ' + env.error.message, '下一步：' + env.error.hint]),
  ].join('\n')) + '\n');
  return env.ok && env.result?.schema === 'heimdall.backend-comparison/1' && env.result.overall !== 'passed'
    ? 1 : exitCodeOf(env);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exit(await run(process.argv.slice(2)));
}
