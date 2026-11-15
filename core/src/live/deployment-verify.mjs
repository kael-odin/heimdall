#!/usr/bin/env node
/**
 * live/deployment-verify — 在真实 Docker 无外联网络中验收最终交付包。
 *
 * 适配器模式给服务端外联一个可追溯证据，静态模式给最终镜像文件系统的
 * 浏览器加载一个可追溯证据；写入业务和状态机仍以人工授权旅程为准。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeArgs } from '../args.mjs';
import { DATA_ROOT, WORKSPACE } from '../paths.mjs';
import { inspectRuntimeAdapter } from './adapter-runtime.mjs';
import { listLivePageRoutes } from './health.mjs';
import { readOperationPlanFile } from './operation-plan.mjs';
import { probeOfflineBrowserBundle, probeOfflineOperations } from './probe.mjs';

const VERIFY_SCHEMA = 'heimdall.adapter-egress-verification/1';
const STATIC_VERIFY_SCHEMA = 'heimdall.static-deployment-verification/1';
const ATTEMPT_SCHEMA = 'heimdall.deployment-verification-attempt/1';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_OBSERVE_MS = 3_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OBSERVE_MS = 15_000;
const MAX_HTTP_CHECKS = 100;
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_PLAN_BYTES = 1024 * 1024;
const HOST_RE = /^[a-z0-9.-]+$/i;
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export class DeploymentVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function jsonFile(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new DeploymentVerificationError('invalid_bundle', `${label} 无法读取`); }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function bundleFiles(root) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
      if (!prefix && (name === 'checksums.json' || name === 'changes.json')) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new DeploymentVerificationError('invalid_bundle', '交付包包含符号链接');
      if (stat.isDirectory()) walk(path, prefix ? `${prefix}/${name}` : name);
      else if (stat.isFile()) files.push(prefix ? `${prefix}/${name}` : name);
    }
  };
  walk(root);
  return files.sort();
}

export function verifyBundleChecksums(bundleDir) {
  regularDirectory(bundleDir, '交付包');
  const checksumsFile = join(bundleDir, 'checksums.json');
  const manifest = jsonFile(checksumsFile, 'checksums.json');
  if (!Array.isArray(manifest.files) || manifest.files.length > 100_000) {
    throw new DeploymentVerificationError('invalid_bundle', 'checksums.json 的文件清单无效');
  }
  const listed = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item.p !== 'string' || !/^\S[^\\]*$/.test(item.p)
      || item.p.includes('/../') || item.p.startsWith('../')
      || !Number.isSafeInteger(item.s) || item.s < 0 || !/^[a-f0-9]{64}$/i.test(item.h ?? '')) {
      throw new DeploymentVerificationError('invalid_bundle', 'checksums.json 含有无效条目');
    }
    const path = resolve(bundleDir, item.p);
    const rel = relative(bundleDir, path).replaceAll('\\', '/');
    if (rel !== item.p || listed.has(item.p)) throw new DeploymentVerificationError('invalid_bundle', 'checksums.json 路径越界或重复');
    regularFile(path, item.p);
    if (lstatSync(path).size !== item.s || sha256File(path) !== item.h) {
      throw new DeploymentVerificationError('failed', `交付包文件校验失败：${item.p}`);
    }
    listed.add(item.p);
  }
  const actual = bundleFiles(bundleDir);
  if (actual.length !== listed.size || actual.some(path => !listed.has(path))) {
    throw new DeploymentVerificationError('failed', '交付包包含未列入 checksums.json 的文件');
  }
  return sha256File(checksumsFile);
}

function regularDirectory(path, label) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  } catch {
    throw new DeploymentVerificationError('invalid_bundle', `${label} 必须是普通目录`);
  }
}

function regularFile(path, label) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  } catch {
    throw new DeploymentVerificationError('invalid_bundle', `${label} 不存在或不是普通文件`);
  }
}

function boundedNumber(value, fallback, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new DeploymentVerificationError('invalid_args', `数值必须是 1 到 ${max} 的整数`);
  }
  return number;
}

function safeCheckPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || value.includes('\\') || value.length > 2048 || /%(?:2f|5c)/i.test(value)) return false;
  try {
    const path = new URL(value, 'http://check.local').pathname;
    return !['/', '/static', '/__heimdall', '/lm'].some(root => path === root || path.startsWith(root + '/'));
  } catch { return false; }
}

export function readHttpChecks(path) {
  regularFile(path, 'HTTP 检查文件');
  if (lstatSync(path).size > 1024 * 1024) {
    throw new DeploymentVerificationError('invalid_args', 'HTTP 检查文件超过 1 MiB');
  }
  const source = jsonFile(path, 'HTTP 检查文件');
  if (source?.version !== 1 || !Array.isArray(source.beforeRestart)
    || source.beforeRestart.length < 1 || source.beforeRestart.length > MAX_HTTP_CHECKS
    || (source.afterRestart !== undefined && (!Array.isArray(source.afterRestart) || source.afterRestart.length > MAX_HTTP_CHECKS))) {
    throw new DeploymentVerificationError('invalid_args', 'HTTP 检查文件必须是 version=1，并包含 beforeRestart 数组');
  }
  const seen = new Set();
  const validate = (items, label) => items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(item.id)
      || seen.has(item.id) || !HTTP_METHODS.has(item.method)
      || !safeCheckPath(item.path) || !item.expect || typeof item.expect !== 'object') {
      throw new DeploymentVerificationError('invalid_args', `${label}[${index}] 的请求或断言无效`);
    }
    seen.add(item.id);
    const headers = item.headers ?? {};
    if (typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 50
      || Object.entries(headers).some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
        || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value))) {
      throw new DeploymentVerificationError('invalid_args', `${label}[${index}] 的请求头无效`);
    }
    if (item.body !== undefined && !['string', 'object', 'number', 'boolean'].includes(typeof item.body)) {
      throw new DeploymentVerificationError('invalid_args', `${label}[${index}] 的请求体无效`);
    }
    if (item.body !== undefined && Buffer.byteLength(typeof item.body === 'string' ? item.body : JSON.stringify(item.body)) > MAX_HTTP_BODY_BYTES) {
      throw new DeploymentVerificationError('invalid_args', `${label}[${index}] 的请求体超过 4 MiB`);
    }
    const expect = item.expect;
    if (!Number.isInteger(expect.status) || expect.status < 100 || expect.status > 599
      || (expect.contentType !== undefined && (typeof expect.contentType !== 'string' || expect.contentType.length > 128))
      || (expect.textIncludes !== undefined && (typeof expect.textIncludes !== 'string' || expect.textIncludes.length > 200))
      || (expect.json !== undefined && (!Array.isArray(expect.json) || expect.json.length > 20
        || expect.json.some(assertion => !assertion || typeof assertion.pointer !== 'string'
          || !assertion.pointer.startsWith('/') || assertion.pointer.length > 512 || !Object.hasOwn(assertion, 'equals'))))) {
      throw new DeploymentVerificationError('invalid_args', `${label}[${index}] 的响应断言无效`);
    }
    return { ...item, method: item.method, headers, expect };
  });
  return {
    beforeRestart: validate(source.beforeRestart, 'beforeRestart'),
    afterRestart: validate(source.afterRestart ?? [], 'afterRestart'),
    sha256: sha256File(path),
    path,
  };
}

export function formatHttpCheckFailure(phase, check, detail) {
  const safePhase = phase === 'afterRestart' ? 'afterRestart' : 'beforeRestart';
  const safeId = typeof check?.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(check.id) ? check.id : 'unknown';
  return `HTTP check failed [${safePhase}]: ${safeId}${detail ? ` (${detail})` : ''}`;
}

function safeRelativeBundle(bundleDir) {
  const rel = relative(DATA_ROOT, bundleDir).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || rel.includes('/../') || !rel.startsWith('deliverable/')) {
    return null;
  }
  return rel;
}

function safeFailureOrigin(value) {
  try { return new URL(String(value)).host || 'unknown-host'; }
  catch { return 'unknown-host'; }
}

export function summarizeBrowserProbeFailures(report, maxGroups = 4) {
  if (!report || !Array.isArray(report.failures) || report.failures.length === 0) return '';
  const groups = new Map();
  for (const failure of report.failures) {
    let key = typeof failure?.kind === 'string' && failure.kind ? failure.kind : 'unknown';
    if (key === 'externalRequest') key += `@${safeFailureOrigin(failure.target)}`;
    else if (Number.isInteger(failure?.status)) key += `:${failure.status}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const limit = Number.isInteger(maxGroups) && maxGroups > 0 ? maxGroups : 4;
  const items = [...groups.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key}×${count}`);
  return items.join('、') + (groups.size > limit ? '、…' : '');
}

function docker(args, timeoutMs) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') {
    throw new DeploymentVerificationError('unavailable', 'Docker CLI 不可用');
  }
  if (result.error?.code === 'ETIMEDOUT' || result.signal) {
    throw new DeploymentVerificationError('incomplete', 'Docker 验收超时');
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new DeploymentVerificationError('failed', `Docker 验收失败${detail ? `：${detail}` : ''}`);
  }
  return String(result.stdout ?? '').trim();
}

function verifierScript(port, observeMs, phase) {
  return `
const { existsSync, readFileSync } = await import('node:fs');
const base = 'http://127.0.0.1:${port}';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async (path, options) => {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type') || '', text };
};
const health = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { return JSON.parse((await request('/__heimdall/health')).text); }
    catch { await wait(100); }
  }
  throw new Error('health endpoint did not start');
};
if (existsSync('/app/workspace')) throw new Error('source workspace is present in image');
if (process.env.HEIMDALL_RUNTIME_DATA_DIR !== '/data') throw new Error('runtime data directory is not /data');
const first = await health();
if (first.offline !== true) throw new Error('bundle is not offline');
if (first.adapterGaps === undefined) throw new Error('adapter health evidence is missing');
const root = await request('/');
if (root.status >= 400) throw new Error('root route failed with ' + root.status);
const manifest = JSON.parse(readFileSync('/app/runtime-adapter/manifest.json', 'utf8'));
const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
let exercised = 0;
let untested = 0;
for (const route of routes) {
  if (route.method !== 'GET' && route.method !== 'HEAD') { untested++; continue; }
  if (String(route.path).includes('{')) { untested++; continue; }
  const result = await request(route.path, { method: route.method });
  if (result.status >= 500) throw new Error(route.method + ' ' + route.path + ' returned ' + result.status);
  exercised++;
}
const readJsonPointer = (value, pointer) => {
  let current = value;
  for (const token of pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (current === null || current === undefined || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return current;
};
const runHttpChecks = async checks => {
  const results = [];
  const fail = (check, detail) => { throw new Error((${formatHttpCheckFailure.toString()})('${phase}', check, detail)); };
  for (const check of checks) {
    const body = check.body === undefined || check.method === 'GET' || check.method === 'HEAD'
      ? undefined : typeof check.body === 'string' ? check.body : JSON.stringify(check.body);
    const result = await request(check.path, {
      method: check.method, headers: check.headers, ...(body === undefined ? {} : { body }),
    });
    if (result.status !== check.expect.status) fail(check, 'status expected ' + check.expect.status + ', got ' + result.status);
    if (check.expect.contentType && !result.contentType.toLowerCase().startsWith(check.expect.contentType.toLowerCase())) {
      fail(check, 'content-type assertion failed');
    }
    if (check.expect.textIncludes && !result.text.includes(check.expect.textIncludes)) {
      fail(check, 'text assertion failed');
    }
    if (Array.isArray(check.expect.json)) {
      let value;
      try { value = JSON.parse(result.text); } catch { fail(check, 'response is not valid JSON'); }
      for (const assertion of check.expect.json) {
        if (JSON.stringify(readJsonPointer(value, assertion.pointer)) !== JSON.stringify(assertion.equals)) {
          fail(check, 'JSON pointer ' + assertion.pointer + ' mismatch');
        }
      }
    }
    results.push({ id: check.id, status: result.status });
  }
  return { checked: results.length, passed: results.length, results };
};
let httpChecks = null;
if (existsSync('/run/heimdall-http-checks.json')) {
  const plan = JSON.parse(readFileSync('/run/heimdall-http-checks.json', 'utf8'));
  const checks = '${phase}' === 'beforeRestart' ? plan.beforeRestart : plan.afterRestart;
  httpChecks = await runHttpChecks(checks);
}
await wait(${observeMs});
const gaps = JSON.parse((await request('/__heimdall/adapter-gaps')).text);
if (!gaps || typeof gaps.summary?.uniqueGaps !== 'number') throw new Error('adapter gap ledger is unavailable');
if (!existsSync('/data/adapter-gap-ledger.json')) throw new Error('runtime state volume was not written');
console.log(JSON.stringify({
  health: 'passed', root: root.status < 500 ? 'passed' : 'failed',
  declaredRoutes: routes.length, exercisedRoutes: exercised, untestedRoutes: untested,
  gapLedger: gaps.summary, stateVolume: 'passed', httpChecks,
}));
`;
}

function staticVerifierScript(port, observeMs) {
  return `
const { existsSync, readdirSync, statSync } = await import('node:fs');
const { join, relative } = await import('node:path');
const base = 'http://127.0.0.1:${port}';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async path => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  await response.arrayBuffer();
  return response.status;
};
const health = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(base + '/__heimdall/health', { signal: AbortSignal.timeout(15000) });
      return JSON.parse(await response.text());
    } catch { await wait(100); }
  }
  throw new Error('health endpoint did not start');
};
if (existsSync('/app/workspace')) throw new Error('source workspace is present in image');
const first = await health();
if (first.offline !== true) throw new Error('bundle is not offline');
if (first.adapterGaps !== undefined) throw new Error('static bundle unexpectedly exposes adapter state');
if (await request('/') >= 400) throw new Error('root route failed');
const routes = [];
const walk = (dir, prefix = '') => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory() && name !== '.heimdall-query') walk(file, prefix ? prefix + '/' + name : name);
    else if (stat.isFile() && name === 'index.html') routes.push(prefix ? '/' + prefix + '/' : '/');
  }
};
walk('/app/site/live');
if (!routes.length) throw new Error('static bundle has no live page');
for (const route of [...new Set(routes)].sort()) {
  if (await request(route) >= 400) throw new Error('page route failed: ' + route);
}
await wait(${observeMs});
console.log(JSON.stringify({ health: 'passed', root: 'passed', routes: [...new Set(routes)].sort(), routesChecked: new Set(routes).size, sourceWorkspace: 'passed' }));
`;
}

function parseVerifierOutput(output) {
  const line = String(output).trim().split(/\r?\n/).at(-1);
  try { return JSON.parse(line); }
  catch { throw new DeploymentVerificationError('failed', '容器验收没有返回有效证据'); }
}

function runContainerCheck({ container, port, observeMs, timeoutMs, runDocker: run, httpChecksPath, phase }) {
  if (httpChecksPath) run(['cp', httpChecksPath, `${container}:/run/heimdall-http-checks.json`], timeoutMs);
  const result = run(['exec', container, 'node', '--input-type=module', '-e', verifierScript(port, observeMs, phase)], timeoutMs);
  return parseVerifierOutput(result);
}

function runStaticContainerCheck({ container, port, observeMs, timeoutMs, runDocker: run }) {
  const result = run(['exec', container, 'node', '--input-type=module', '-e', staticVerifierScript(port, observeMs)], timeoutMs);
  return parseVerifierOutput(result);
}

function copyContainerApp({ container, destination, timeoutMs, runDocker: run }) {
  run(['cp', `${container}:/app/.`, destination], timeoutMs);
}

async function probeFinalImageFilesystem(bundleDir, routes, observeMs) {
  return probeOfflineBrowserBundle(bundleDir, routes, {
    settleMs: observeMs,
    maxObservationMs: Math.min(20_000, observeMs + 5_000),
    quietMs: Math.min(500, observeMs),
  });
}

async function probeFinalImageOperations(bundleDir, flows, adapterSessionRoutes, observeMs) {
  return probeOfflineOperations(bundleDir, flows, {
    adapterSessionRoutes,
    settleMs: Math.min(observeMs, 5_000),
    lateMs: Math.min(observeMs, 5_000),
    timeoutMs: 30_000,
  });
}

function readDeploymentOperationPlan(path, origin, pageRoutes) {
  regularFile(path, '操作计划文件');
  if (lstatSync(path).size > MAX_OPERATION_PLAN_BYTES) {
    throw new DeploymentVerificationError('invalid_args', '操作计划文件超过 1 MiB');
  }
  const plan = readOperationPlanFile(path, origin, pageRoutes);
  if (plan.status !== 'ok' || !plan.flows.length) {
    throw new DeploymentVerificationError('invalid_args', `操作计划无效${plan.issue ? `：${plan.issue}` : ''}`);
  }
  return plan;
}

function readBundle(bundleDir, mode = 'adapter') {
  regularDirectory(bundleDir, '交付包');
  for (const [file, label] of [
    ['health.json', 'health.json'], ['checksums.json', 'checksums.json'], ['Dockerfile', 'Dockerfile'],
    ['serve.mjs', 'serve.mjs'], ['heimdall-live.json', 'heimdall-live.json'],
  ]) regularFile(join(bundleDir, file), label);
  const health = jsonFile(join(bundleDir, 'health.json'), 'health.json');
  if (mode === 'adapter') {
    for (const [file, label] of [['runtime-adapter/manifest.json', 'runtime-adapter/manifest.json'], ['runtime-adapter/index.mjs', 'runtime-adapter/index.mjs']]) {
      regularFile(join(bundleDir, file), label);
    }
    if (health?.adapter?.status !== 'included') throw new DeploymentVerificationError('invalid_args', '交付包没有包含适配器');
  } else if (health?.adapter?.status === 'included' || existsSync(join(bundleDir, 'runtime-adapter'))) {
    throw new DeploymentVerificationError('invalid_args', '静态验收不能接管含适配器的交付包');
  }
  const config = jsonFile(join(bundleDir, 'heimdall-live.json'), 'heimdall-live.json');
  const manifest = mode === 'adapter' ? jsonFile(join(bundleDir, 'runtime-adapter/manifest.json'), 'runtime-adapter/manifest.json') : null;
  if (mode === 'adapter' && (!Array.isArray(manifest.routes) || !manifest.routes.length)) {
    throw new DeploymentVerificationError('invalid_bundle', '适配器没有声明路由');
  }
  return {
    health, config, manifest,
    checksumsSha256: verifyBundleChecksums(bundleDir),
  };
}

export function validateStaticDeploymentReport(report, { siteId, checksumsSha256 } = {}) {
  return report?.schema === STATIC_VERIFY_SCHEMA
    && (!siteId || report.siteId === siteId)
    && report.deployment === 'verified'
    && /^[a-f0-9]{64}$/i.test(report.bundleChecksumsSha256 ?? '')
    && (!checksumsSha256 || report.bundleChecksumsSha256 === checksumsSha256)
    && report.docker?.network === 'none'
    && report.checks?.health === 'passed'
    && report.checks?.root === 'passed'
    && report.checks?.routes?.failed === 0
    && report.checks?.sourceWorkspace === 'passed'
    && report.checks?.restart === 'passed'
    && report.checks?.browserProbe?.scope === 'final-image-filesystem'
    && report.checks.browserProbe.bundleChecksumsSha256 === report.bundleChecksumsSha256
    && report.checks.browserProbe.failed === 0
    && report.checks.browserProbe.untested === 0
    && report.checks.browserProbe.truncated === false
    && report.checks.browserProbe.checked === report.checks.routes.checked;
}

function reportTarget({ siteId, reportPath, kind = 'adapter' }) {
  if (reportPath) return resolve(reportPath);
  if (!siteId) throw new DeploymentVerificationError('invalid_args', '写入工作区证据需要 --site-id 或 --report');
  if (!HOST_RE.test(siteId)) throw new DeploymentVerificationError('invalid_args', 'siteId 格式无效');
  return join(WORKSPACE, siteId, kind === 'static' ? 'deployment-verification.json' : 'adapter-egress-verification.json');
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(report, null, 2) + '\n');
  renameSync(temp, path);
}

function attemptReportTarget({ siteId, reportPath, kind }) {
  if (reportPath) return `${resolve(reportPath)}.attempt.json`;
  if (!siteId || !HOST_RE.test(siteId)) return null;
  return join(WORKSPACE, siteId, kind === 'static' ? 'deployment-verification-attempt.json' : 'adapter-egress-verification-attempt.json');
}

function attemptStatus(code) {
  if (code === 'unavailable') return 'unavailable';
  if (code === 'incomplete') return 'incomplete';
  if (code === 'invalid_args' || code === 'invalid_bundle') return 'invalid';
  return 'failed';
}

function attemptStage(value) {
  return ['bundle', 'docker-build', 'container-start', 'container-check', 'browser-probe', 'operation-probe', 'restart', 'report'].includes(value)
    ? value : 'unknown';
}

function safeAttemptBrowserProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    checked: Number.isSafeInteger(value.checked) && value.checked >= 0 ? value.checked : 0,
    failed: Number.isSafeInteger(value.failed) && value.failed >= 0 ? value.failed : 0,
    untested: Number.isSafeInteger(value.untested) && value.untested >= 0 ? value.untested : 0,
    truncated: value.truncated === true,
    failureCount: Number.isSafeInteger(value.failureCount) && value.failureCount >= 0 ? value.failureCount
      : Array.isArray(value.failures) ? value.failures.length : 0,
    ...(summarizeBrowserProbeFailures(value) ? { causes: summarizeBrowserProbeFailures(value) } : {}),
  };
}

function writeAttemptReport({ siteId, reportPath, kind, bundleDir, stage, error, browserProbe, phase }) {
  const target = attemptReportTarget({ siteId, reportPath, kind });
  if (!target) return null;
  const bundle = safeRelativeBundle(resolve(bundleDir));
  const report = {
    schema: ATTEMPT_SCHEMA, siteId, mode: kind === 'static' ? 'static' : 'adapter',
    generatedAt: new Date().toISOString(), status: attemptStatus(error?.code), stage: attemptStage(stage),
    ...(bundle ? { bundle } : {}),
    error: { code: typeof error?.code === 'string' ? error.code.slice(0, 32) : 'failed' },
    ...(phase === 'afterRestart' || phase === 'beforeRestart' ? { phase } : {}),
    ...(browserProbe ? { browserProbe: safeAttemptBrowserProbe(browserProbe) } : {}),
  };
  try {
    const bundlePath = resolve(bundleDir);
    const checksums = join(bundlePath, 'checksums.json');
    if (existsSync(checksums)) report.bundleChecksumsSha256 = sha256File(checksums);
  } catch {}
  try { writeReport(target, report); } catch { return null; }
  return target;
}

function clearAttemptReport({ siteId, reportPath, kind }) {
  const target = attemptReportTarget({ siteId, reportPath, kind });
  if (target) rmSync(target, { force: true });
}

export function validateDeploymentReport(report, { siteId, checksumsSha256 } = {}) {
  return report?.schema === VERIFY_SCHEMA
    && (!siteId || report.siteId === siteId)
    && report.serverEgress === 'verified'
    && /^[a-f0-9]{64}$/i.test(report.bundleChecksumsSha256 ?? '')
    && (!checksumsSha256 || report.bundleChecksumsSha256 === checksumsSha256)
    && report.docker?.network === 'none'
    && report.checks?.health === 'passed'
    && report.checks?.stateVolume === 'passed'
    && (!report.checks.operationProbe || (
      report.checks.operationProbe.scope === 'final-image-filesystem'
      && /^[a-f0-9]{64}$/i.test(report.checks.operationProbe.planSha256 ?? '')
      && report.checks.operationProbe.checked === report.checks.operationProbe.planned
      && report.checks.operationProbe.failed === 0
      && report.checks.operationProbe.untested === 0
    ));
}

export async function verifyDeploymentBundle({ bundleDir, siteId, reportPath, httpChecksPath, operationPlanPath,
  timeoutMs = DEFAULT_TIMEOUT_MS, observeMs = DEFAULT_OBSERVE_MS, runDocker = docker,
  copySnapshot = copyContainerApp, probeOperations = probeFinalImageOperations }) {
  const bundle = resolve(bundleDir);
  const metadata = readBundle(bundle);
  const httpChecks = httpChecksPath ? readHttpChecks(resolve(httpChecksPath)) : null;
  const operationPlanFile = operationPlanPath ? resolve(operationPlanPath) : null;
  if (operationPlanFile) regularFile(operationPlanFile, '操作计划文件');
  const port = Number(metadata.config.port ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DeploymentVerificationError('invalid_bundle', '交付包端口无效');
  }
  const target = reportTarget({ siteId: siteId ?? metadata.config.siteId, reportPath });
  const bundleRef = safeRelativeBundle(bundle);
  if (!bundleRef && !reportPath) {
    throw new DeploymentVerificationError('invalid_args', '默认工作区证据要求交付包位于 DATA_ROOT/deliverable 内');
  }
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const image = `heimdall-egress-verify:${suffix}`;
  const container = `heimdall-egress-verify-${suffix}`;
  const volume = `heimdall-egress-state-${suffix}`;
  const snapshot = operationPlanFile ? mkdtempSync(join(tmpdir(), 'heimdall-adapter-image-')) : null;
  let started = false;
  let built = false;
  let first;
  let second;
  let operationProbe;
  let stage = 'bundle';
  let phase = null;
  try {
    stage = 'docker-build';
    runDocker(['build', '--pull=false', '--tag', image, bundle], timeoutMs);
    built = true;
    runDocker(['volume', 'create', volume], timeoutMs);
    stage = 'container-start';
    runDocker(['run', '--detach', '--rm', '--network', 'none', '--name', container,
      '--mount', `type=volume,source=${volume},target=/data`, image], timeoutMs);
    started = true;
    const network = runDocker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container], timeoutMs);
    if (network !== 'none') throw new DeploymentVerificationError('failed', '容器没有使用 network none');
    stage = 'container-check';
    phase = 'beforeRestart';
    first = runContainerCheck({ container, port, observeMs, timeoutMs, runDocker,
      httpChecksPath: httpChecks?.path, phase: 'beforeRestart' });
    if (operationPlanFile) {
      stage = 'operation-probe';
      copySnapshot({ container, destination: snapshot, timeoutMs, runDocker });
      const snapshotChecksumsSha256 = verifyBundleChecksums(snapshot);
      if (snapshotChecksumsSha256 !== metadata.checksumsSha256) {
        throw new DeploymentVerificationError('failed', '最终镜像 /app 快照与交付包校验和不一致');
      }
      const pageRoutes = listLivePageRoutes(join(snapshot, 'site', 'live'), metadata.config.origin);
      const plan = readDeploymentOperationPlan(operationPlanFile, metadata.config.origin, pageRoutes);
      const adapter = inspectRuntimeAdapter(snapshot);
      operationProbe = await probeOperations(snapshot, plan.flows, Object.fromEntries(adapter.sessionRoutes), observeMs);
      if (!operationProbe || operationProbe.failed !== 0 || operationProbe.untested !== 0
        || operationProbe.checked !== operationProbe.planned) {
        throw new DeploymentVerificationError('failed', `最终镜像操作验收失败：${operationProbe?.failed ?? 'unknown'} 个失败，${operationProbe?.untested ?? 'unknown'} 条未测`);
      }
    }
    stage = 'restart';
    runDocker(['rm', '--force', container], timeoutMs);
    started = false;
    runDocker(['run', '--detach', '--rm', '--network', 'none', '--name', container,
      '--mount', `type=volume,source=${volume},target=/data`, image], timeoutMs);
    started = true;
    stage = 'container-check';
    phase = 'afterRestart';
    second = runContainerCheck({ container, port, observeMs: Math.min(observeMs, 1_000), timeoutMs, runDocker,
      httpChecksPath: httpChecks?.path, phase: 'afterRestart' });
    stage = 'report';
    const report = {
      schema: VERIFY_SCHEMA, siteId: siteId ?? metadata.config.siteId,
      generatedAt: new Date().toISOString(), serverEgress: 'verified',
      bundle: bundleRef, bundleChecksumsSha256: metadata.checksumsSha256,
      docker: { network: 'none' },
      checks: {
        health: 'passed', root: first.root, sourceWorkspace: 'passed',
        stateVolume: second.stateVolume, restart: 'passed',
        ...(operationProbe ? { operationProbe: {
          scope: 'final-image-filesystem', planSha256: sha256File(operationPlanFile),
          planned: operationProbe.planned, checked: operationProbe.checked,
          failed: operationProbe.failed, untested: operationProbe.untested,
          passedFlows: operationProbe.flows?.filter(flow => flow.passed).length ?? null,
        } } : {}),
      },
      adapter: {
        declaredRoutes: first.declaredRoutes, exercisedRoutes: first.exercisedRoutes,
        untestedRoutes: first.untestedRoutes,
      },
      gapLedger: first.gapLedger,
      ...(httpChecks ? { httpChecks: {
        planSha256: httpChecks.sha256, beforeRestart: first.httpChecks, afterRestart: second.httpChecks,
      } } : {}),
      observationMs: observeMs,
      evidence: { firstStart: first.health, secondStart: second.health },
    };
    if (!validateDeploymentReport(report, { siteId: report.siteId, checksumsSha256: metadata.checksumsSha256 })) {
      throw new DeploymentVerificationError('failed', '生成的无外联证据未通过自校验');
    }
    writeReport(target, report);
    clearAttemptReport({ siteId: report.siteId, reportPath, kind: 'adapter' });
    return { report, reportPath: target };
  } catch (error) {
    const attempt = writeAttemptReport({ siteId: siteId ?? metadata.config.siteId, reportPath, kind: 'adapter',
      bundleDir: bundle, stage, error, phase });
    if (attempt && error && typeof error === 'object') error.attemptReportPath = attempt;
    throw error;
  } finally {
    if (started) { try { runDocker(['rm', '--force', container], timeoutMs); } catch {} }
    if (built) { try { runDocker(['image', 'rm', image], timeoutMs); } catch {} }
    try { runDocker(['volume', 'rm', volume], timeoutMs); } catch {}
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  }
}

export async function verifyStaticDeploymentBundle({ bundleDir, siteId, reportPath, timeoutMs = DEFAULT_TIMEOUT_MS,
  observeMs = DEFAULT_OBSERVE_MS, runDocker = docker, copySnapshot = copyContainerApp,
  probeBrowser = probeFinalImageFilesystem }) {
  const bundle = resolve(bundleDir);
  const metadata = readBundle(bundle, 'static');
  const target = reportTarget({ siteId: siteId ?? metadata.config.siteId, reportPath, kind: 'static' });
  const port = Number(metadata.config.port ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DeploymentVerificationError('invalid_bundle', '交付包端口无效');
  }
  const bundleRef = safeRelativeBundle(bundle);
  if (!bundleRef && !reportPath) throw new DeploymentVerificationError('invalid_args', '默认工作区证据要求交付包位于 DATA_ROOT/deliverable 内');
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const image = `heimdall-static-verify:${suffix}`;
  const container = `heimdall-static-verify-${suffix}`;
  const snapshot = mkdtempSync(join(tmpdir(), 'heimdall-static-image-'));
  let started = false;
  let built = false;
  let first;
  let browserProbe;
  let stage = 'bundle';
  try {
    stage = 'docker-build';
    runDocker(['build', '--pull=false', '--tag', image, bundle], timeoutMs);
    built = true;
    stage = 'container-start';
    runDocker(['run', '--detach', '--rm', '--network', 'none', '--name', container, image], timeoutMs);
    started = true;
    const network = runDocker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container], timeoutMs);
    if (network !== 'none') throw new DeploymentVerificationError('failed', '容器没有使用 network none');
    stage = 'container-check';
    first = runStaticContainerCheck({ container, port, observeMs, timeoutMs, runDocker });
    if (!Array.isArray(first.routes) || first.routes.length !== first.routesChecked) {
      throw new DeploymentVerificationError('failed', '容器验收没有返回完整页面路由清单');
    }
    copySnapshot({ container, destination: snapshot, timeoutMs, runDocker });
    const snapshotChecksumsSha256 = verifyBundleChecksums(snapshot);
    if (snapshotChecksumsSha256 !== metadata.checksumsSha256) {
      throw new DeploymentVerificationError('failed', '最终镜像 /app 快照与交付包校验和不一致');
    }
    stage = 'browser-probe';
    browserProbe = await probeBrowser(snapshot, first.routes, observeMs);
    if (!browserProbe || browserProbe.failed !== 0 || browserProbe.untested !== 0
      || browserProbe.truncated || browserProbe.checked !== first.routesChecked) {
      const causes = summarizeBrowserProbeFailures(browserProbe);
      throw new DeploymentVerificationError('failed', `最终镜像浏览器验收失败：${browserProbe?.failed ?? 'unknown'} 个失败，${browserProbe?.untested ?? 'unknown'} 页未测${causes ? `；原因：${causes}` : ''}`);
    }
    runDocker(['rm', '--force', container], timeoutMs);
    started = false;
    stage = 'restart';
    runDocker(['run', '--detach', '--rm', '--network', 'none', '--name', container, image], timeoutMs);
    started = true;
    stage = 'container-check';
    const second = runStaticContainerCheck({ container, port, observeMs: Math.min(observeMs, 1_000), timeoutMs, runDocker });
    const report = {
      schema: STATIC_VERIFY_SCHEMA, siteId: siteId ?? metadata.config.siteId,
      generatedAt: new Date().toISOString(), deployment: 'verified',
      bundle: bundleRef, bundleChecksumsSha256: metadata.checksumsSha256,
      docker: { network: 'none' },
      checks: {
        health: 'passed', root: first.root,
        routes: { checked: first.routesChecked, failed: 0 },
        sourceWorkspace: first.sourceWorkspace, restart: 'passed',
        browserProbe: {
          scope: 'final-image-filesystem', bundleChecksumsSha256: metadata.checksumsSha256,
          checked: browserProbe.checked, failed: browserProbe.failed,
          untested: browserProbe.untested, truncated: !!browserProbe.truncated,
          failureCount: browserProbe.failureCount ?? browserProbe.failures?.length ?? 0,
          observation: browserProbe.observation ?? null,
        },
      },
      observationMs: observeMs, evidence: { firstStart: first, secondStart: second },
    };
    if (!validateStaticDeploymentReport(report, { siteId: report.siteId, checksumsSha256: metadata.checksumsSha256 })) {
      throw new DeploymentVerificationError('failed', '生成的静态无外联证据未通过自校验');
    }
    writeReport(target, report);
    clearAttemptReport({ siteId: report.siteId, reportPath, kind: 'static' });
    return { report, reportPath: target };
  } catch (error) {
    const attempt = writeAttemptReport({ siteId: siteId ?? metadata.config.siteId, reportPath, kind: 'static',
      bundleDir: bundle, stage, error, browserProbe });
    if (attempt && error && typeof error === 'object') error.attemptReportPath = attempt;
    throw error;
  } finally {
    if (started) { try { runDocker(['rm', '--force', container], timeoutMs); } catch {} }
    if (built) { try { runDocker(['image', 'rm', image], timeoutMs); } catch {} }
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function usage() {
  console.error('用法: heimdall live-verify <bundleDir> [--static] [--site-id S] [--report FILE] [--http-checks FILE] [--operation-plan FILE] [--timeout-ms N] [--observe-ms N]');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { argOf, has, positional } = makeArgs();
  const invokeCwd = process.env.HEIMDALL_INVOKE_CWD ?? process.cwd();
  const fromInvokeCwd = value => value === undefined ? undefined : resolve(invokeCwd, value);
  const bundleDir = fromInvokeCwd(positional()[0]);
  if (!bundleDir) { usage(); process.exit(2); }
  try {
    const common = {
      bundleDir, siteId: argOf('site-id', undefined), reportPath: fromInvokeCwd(argOf('report', undefined)),
      operationPlanPath: fromInvokeCwd(argOf('operation-plan', undefined)),
      timeoutMs: boundedNumber(argOf('timeout-ms', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      observeMs: boundedNumber(argOf('observe-ms', DEFAULT_OBSERVE_MS), DEFAULT_OBSERVE_MS, MAX_OBSERVE_MS),
    };
    if (has('static')) {
      if (argOf('http-checks', undefined) !== undefined || common.operationPlanPath !== undefined) {
        throw new DeploymentVerificationError('invalid_args', '静态验收不支持 --http-checks 或 --operation-plan');
      }
      const result = await verifyStaticDeploymentBundle(common);
      console.log(`[live-verify] deployment=verified routes=${result.report.checks.routes.checked} report=${result.reportPath}`);
    } else {
      const result = await verifyDeploymentBundle({ ...common, httpChecksPath: fromInvokeCwd(argOf('http-checks', undefined)) });
      console.log(`[live-verify] serverEgress=verified routes=${result.report.adapter.exercisedRoutes}/${result.report.adapter.declaredRoutes} report=${result.reportPath}`);
    }
  } catch (error) {
    console.error(`[live-verify] ${error?.message ?? error}`);
    process.exit(error?.code === 'unavailable' ? 3 : error?.code === 'invalid_args' || error?.code === 'invalid_bundle' ? 2 : 1);
  }
}
