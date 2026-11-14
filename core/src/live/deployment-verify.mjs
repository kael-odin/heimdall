#!/usr/bin/env node
/**
 * live/deployment-verify — 在真实 Docker 无外联网络中验收最终交付包。
 *
 * 这条验收只给适配器服务端外联一个可追溯证据；页面、写入业务和状态机
 * 仍以导出时声明的操作流程与人工授权旅程为准。
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeArgs } from '../args.mjs';
import { DATA_ROOT, WORKSPACE } from '../paths.mjs';

const VERIFY_SCHEMA = 'heimdall.adapter-egress-verification/1';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_OBSERVE_MS = 3_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OBSERVE_MS = 15_000;
const HOST_RE = /^[a-z0-9.-]+$/i;

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

function safeRelativeBundle(bundleDir) {
  const rel = relative(DATA_ROOT, bundleDir).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || rel.includes('/../') || !rel.startsWith('deliverable/')) {
    return null;
  }
  return rel;
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

function verifierScript(port, observeMs) {
  return `
const { existsSync, readFileSync } = await import('node:fs');
const base = 'http://127.0.0.1:${port}';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async (path, options) => {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  return { status: response.status, text };
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
await wait(${observeMs});
const gaps = JSON.parse((await request('/__heimdall/adapter-gaps')).text);
if (!gaps || typeof gaps.summary?.uniqueGaps !== 'number') throw new Error('adapter gap ledger is unavailable');
if (!existsSync('/data/adapter-gap-ledger.json')) throw new Error('runtime state volume was not written');
console.log(JSON.stringify({
  health: 'passed', root: root.status < 500 ? 'passed' : 'failed',
  declaredRoutes: routes.length, exercisedRoutes: exercised, untestedRoutes: untested,
  gapLedger: gaps.summary, stateVolume: 'passed',
}));
`;
}

function parseVerifierOutput(output) {
  const line = String(output).trim().split(/\r?\n/).at(-1);
  try { return JSON.parse(line); }
  catch { throw new DeploymentVerificationError('failed', '容器验收没有返回有效证据'); }
}

function runContainerCheck({ container, port, observeMs, timeoutMs, runDocker: run }) {
  const result = run(['exec', container, 'node', '--input-type=module', '-e', verifierScript(port, observeMs)], timeoutMs);
  return parseVerifierOutput(result);
}

function readBundle(bundleDir) {
  regularDirectory(bundleDir, '交付包');
  for (const [file, label] of [
    ['health.json', 'health.json'], ['checksums.json', 'checksums.json'], ['Dockerfile', 'Dockerfile'],
    ['serve.mjs', 'serve.mjs'], ['heimdall-live.json', 'heimdall-live.json'],
    ['runtime-adapter/manifest.json', 'runtime-adapter/manifest.json'],
    ['runtime-adapter/index.mjs', 'runtime-adapter/index.mjs'],
  ]) regularFile(join(bundleDir, file), label);
  const health = jsonFile(join(bundleDir, 'health.json'), 'health.json');
  if (health?.adapter?.status !== 'included') {
    throw new DeploymentVerificationError('invalid_args', '交付包没有包含适配器');
  }
  const config = jsonFile(join(bundleDir, 'heimdall-live.json'), 'heimdall-live.json');
  const manifest = jsonFile(join(bundleDir, 'runtime-adapter/manifest.json'), 'runtime-adapter/manifest.json');
  if (!Array.isArray(manifest.routes) || !manifest.routes.length) {
    throw new DeploymentVerificationError('invalid_bundle', '适配器没有声明路由');
  }
  return {
    health, config, manifest,
    checksumsSha256: verifyBundleChecksums(bundleDir),
  };
}

function reportTarget({ siteId, reportPath }) {
  if (reportPath) return resolve(reportPath);
  if (!siteId) throw new DeploymentVerificationError('invalid_args', '写入工作区证据需要 --site-id 或 --report');
  if (!HOST_RE.test(siteId)) throw new DeploymentVerificationError('invalid_args', 'siteId 格式无效');
  return join(WORKSPACE, siteId, 'adapter-egress-verification.json');
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(report, null, 2) + '\n');
  renameSync(temp, path);
}

export function validateDeploymentReport(report, { siteId, checksumsSha256 } = {}) {
  return report?.schema === VERIFY_SCHEMA
    && (!siteId || report.siteId === siteId)
    && report.serverEgress === 'verified'
    && /^[a-f0-9]{64}$/i.test(report.bundleChecksumsSha256 ?? '')
    && (!checksumsSha256 || report.bundleChecksumsSha256 === checksumsSha256)
    && report.docker?.network === 'none'
    && report.checks?.health === 'passed'
    && report.checks?.stateVolume === 'passed';
}

export function verifyDeploymentBundle({ bundleDir, siteId, reportPath, timeoutMs = DEFAULT_TIMEOUT_MS, observeMs = DEFAULT_OBSERVE_MS, runDocker = docker }) {
  const bundle = resolve(bundleDir);
  const metadata = readBundle(bundle);
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
  let started = false;
  let built = false;
  let first;
  let second;
  try {
    runDocker(['build', '--pull=false', '--tag', image, bundle], timeoutMs);
    built = true;
    runDocker(['volume', 'create', volume], timeoutMs);
    runDocker(['run', '--detach', '--rm', '--network', 'none', '--name', container,
      '--mount', `type=volume,source=${volume},target=/data`, image], timeoutMs);
    started = true;
    const network = runDocker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container], timeoutMs);
    if (network !== 'none') throw new DeploymentVerificationError('failed', '容器没有使用 network none');
    first = runContainerCheck({ container, port, observeMs, timeoutMs, runDocker });
    runDocker(['rm', '--force', container], timeoutMs);
    started = false;
    runDocker(['run', '--detach', '--rm', '--network', 'none', '--name', container,
      '--mount', `type=volume,source=${volume},target=/data`, image], timeoutMs);
    started = true;
    second = runContainerCheck({ container, port, observeMs: Math.min(observeMs, 1_000), timeoutMs, runDocker });
    const report = {
      schema: VERIFY_SCHEMA, siteId: siteId ?? metadata.config.siteId,
      generatedAt: new Date().toISOString(), serverEgress: 'verified',
      bundle: bundleRef, bundleChecksumsSha256: metadata.checksumsSha256,
      docker: { network: 'none' },
      checks: {
        health: 'passed', root: first.root, sourceWorkspace: 'passed',
        stateVolume: second.stateVolume, restart: 'passed',
      },
      adapter: {
        declaredRoutes: first.declaredRoutes, exercisedRoutes: first.exercisedRoutes,
        untestedRoutes: first.untestedRoutes,
      },
      gapLedger: first.gapLedger,
      observationMs: observeMs,
      evidence: { firstStart: first.health, secondStart: second.health },
    };
    if (!validateDeploymentReport(report, { siteId: report.siteId, checksumsSha256: metadata.checksumsSha256 })) {
      throw new DeploymentVerificationError('failed', '生成的无外联证据未通过自校验');
    }
    writeReport(target, report);
    return { report, reportPath: target };
  } finally {
    if (started) { try { runDocker(['rm', '--force', container], timeoutMs); } catch {} }
    if (built) { try { runDocker(['image', 'rm', image], timeoutMs); } catch {} }
    try { runDocker(['volume', 'rm', volume], timeoutMs); } catch {}
  }
}

function usage() {
  console.error('用法: heimdall live-verify <bundleDir> [--site-id S] [--report FILE] [--timeout-ms N] [--observe-ms N]');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { argOf, positional } = makeArgs();
  const bundleDir = positional()[0];
  if (!bundleDir) { usage(); process.exit(2); }
  try {
    const result = verifyDeploymentBundle({
      bundleDir,
      siteId: argOf('site-id', undefined), reportPath: argOf('report', undefined),
      timeoutMs: boundedNumber(argOf('timeout-ms', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      observeMs: boundedNumber(argOf('observe-ms', DEFAULT_OBSERVE_MS), DEFAULT_OBSERVE_MS, MAX_OBSERVE_MS),
    });
    console.log(`[live-verify] serverEgress=verified routes=${result.report.adapter.exercisedRoutes}/${result.report.adapter.declaredRoutes} report=${result.reportPath}`);
  } catch (error) {
    console.error(`[live-verify] ${error?.message ?? error}`);
    process.exit(error?.code === 'unavailable' ? 3 : error?.code === 'invalid_args' || error?.code === 'invalid_bundle' ? 2 : 1);
  }
}
