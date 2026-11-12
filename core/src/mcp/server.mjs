#!/usr/bin/env node
/**
 * mcp/server — Heimdall MCP 服务器（stdio / JSON-RPC 2.0，零依赖）
 *
 * 把 Heimdall 能力暴露给任意 MCP 客户端（Codex/Claude Desktop 等）：
 *   heimdall_status / heimdall_jobs / heimdall_recon / heimdall_forge /
 *   heimdall_audit / heimdall_watch / heimdall_verify / heimdall_tokens /
 *   heimdall_components / heimdall_matrix / heimdall_live_export / heimdall_dedupe
 *
 * 环境变量：HEIMDALL_API（默认 http://127.0.0.1:8900）、HEIMDALL_TOKEN
 *
 * 用法：node src/mcp/server.mjs
 */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900';
const TOKEN = process.env.HEIMDALL_TOKEN ?? '';
const SERVER_INFO = { name: 'heimdall', version: '2.0.0' };
const DEFAULT_PROTOCOL = '2025-03-26';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

export const TOOLS = [
  { name: 'heimdall_status', description: '引擎健康状态与并发槽', inputSchema: { type: 'object', properties: {} } },
  { name: 'heimdall_jobs', description: '任务列表 + 持久化历史', inputSchema: { type: 'object', properties: {} } },
  { name: 'heimdall_recon', description: '启动全站侦察（sitemap+BFS → atlas.json）', inputSchema: { type: 'object', properties: { url: str('目标 URL'), maxPages: num('最大页数，默认 40') }, required: ['url'] } },
  { name: 'heimdall_forge', description: '启动单页完整克隆流水线', inputSchema: { type: 'object', properties: { url: str('目标页面 URL'), hostPost: { type: 'boolean', description: '是否运行站点级汇总（默认 true）' } }, required: ['url'] } },
  { name: 'heimdall_audit', description: '启动 SEO 审计（65 条规则）', inputSchema: { type: 'object', properties: { url: str('站点 URL 或域名'), maxPages: num('最大页数，默认 30') }, required: ['url'] } },
  { name: 'heimdall_watch', description: '启动站点变更监控', inputSchema: { type: 'object', properties: { url: str('站点 URL 或域名'), maxPages: num('最大页数，默认 20'), accept: { type: 'boolean', description: '确认变化并更新基线' } }, required: ['url'] } },
  { name: 'heimdall_verify', description: '多视口保真验证（375/768/1440）', inputSchema: { type: 'object', properties: { host: str('站点 host'), page: str('页面名；省略则 --all'), max: num('--all 时最多页数') }, required: ['host'] } },
  { name: 'heimdall_tokens', description: '设计 token 提取', inputSchema: { type: 'object', properties: { host: str('站点 host'), pages: num('采样页数，默认 5') }, required: ['host'] } },
  { name: 'heimdall_components', description: '组件抽取（header/hero/pricing/faq/footer/cta）', inputSchema: { type: 'object', properties: { host: str('站点 host'), pages: num('来源页数，默认 2'), max: num('最多组件数') }, required: ['host'] } },
  { name: 'heimdall_matrix', description: '竞品 SEO 对标矩阵', inputSchema: { type: 'object', properties: { sites: { type: 'array', items: { type: 'string' }, description: '2 个以上站点' }, max: num('每站页数上限') }, required: ['sites'] } },
  { name: 'heimdall_assets', description: '资产缺口扫描（视觉缺口 vs 元数据/追踪）', inputSchema: { type: 'object', properties: { host: str('站点 host'), max: num('最多页数，默认 60') }, required: ['host'] } },
  { name: 'heimdall_live_export', description: '导出可部署交互镜像包', inputSchema: { type: 'object', properties: { host: str('站点 host'), offline: { type: 'boolean', description: '离线模式' }, rebuild: { type: 'boolean', description: '重建 live 页面' }, root: { type: 'string', enum: ['landing', 'mirror'], description: 'mirror=镜像直接挂到站点根路径（drop-in 部署）' }, heal: { type: 'boolean', description: '导出期自愈：从原站补抓离线缺失资源' }, materializeHar: { type: 'boolean', description: '把 HAR 可回放响应落盘为实体文件（离线更稳）' }, strict: { type: 'boolean', description: '有未覆盖资源时以非零码退出（CI 用）' } }, required: ['host'] } },
  { name: 'heimdall_dedupe', description: '资产 CAS 去重', inputSchema: { type: 'object', properties: { host: str('站点 host'), dryRun: { type: 'boolean', description: '只统计不修改' } }, required: ['host'] } },
];

async function apiGet(path) {
  const r = await fetch(API + path, { headers: TOKEN ? { 'x-heimdall-token': TOKEN } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function apiPost(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-heimdall-token': TOKEN } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function runCli(args, timeoutMs = 10 * 60_000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(CORE, 'src', 'cli.mjs'), ...args], { cwd: CORE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { p.kill('SIGTERM'); } catch {} }, timeoutMs);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out: out.slice(-4000) }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
  });
}
const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

export async function callTool(name, args = {}) {
  switch (name) {
    case 'heimdall_status': return text(await apiGet('/api/status'));
    case 'heimdall_jobs': return text(await apiGet('/api/jobs'));
    case 'heimdall_recon': return text(await apiPost('/api/recon', { url: args.url, maxPages: args.maxPages ?? 40 }));
    case 'heimdall_forge': return text(await apiPost('/api/forge', { url: args.url, hostPost: args.hostPost !== false }));
    case 'heimdall_audit': return text(await apiPost('/api/audit', { url: args.url, maxPages: args.maxPages ?? 30 }));
    case 'heimdall_watch': return text(await apiPost('/api/watch', { url: args.url, maxPages: args.maxPages ?? 20, accept: !!args.accept }));
    case 'heimdall_assets': return text(await apiPost('/api/assets-audit', { host: args.host, maxPages: args.max ?? 60 }));
    case 'heimdall_verify': {
      const cliArgs = ['verify', args.host, args.page || '--all'];
      if (args.max) cliArgs.push('--max', String(args.max));
      const r = await runCli(cliArgs);
      return text('exit=' + r.code + '\n' + r.out);
    }
    case 'heimdall_tokens': {
      const r = await runCli(['tokens', args.host, '--pages', String(args.pages ?? 5)]);
      return text('exit=' + r.code + '\n' + r.out);
    }
    case 'heimdall_components': {
      const cliArgs = ['components', args.host, '--pages', String(args.pages ?? 2)];
      if (args.max) cliArgs.push('--max', String(args.max));
      const r = await runCli(cliArgs);
      return text('exit=' + r.code + '\n' + r.out);
    }
    case 'heimdall_matrix': {
      const sites = Array.isArray(args.sites) ? args.sites : [];
      if (sites.length < 2) return text('需要至少 2 个站点');
      const cliArgs = ['matrix', ...sites];
      if (args.max) cliArgs.push('--max', String(args.max));
      const r = await runCli(cliArgs);
      return text('exit=' + r.code + '\n' + r.out);
    }
    case 'heimdall_live_export': {
      const cliArgs = ['live', args.host];
      if (args.offline) cliArgs.push('--offline');
      if (args.rebuild) cliArgs.push('--rebuild');
      if (args.root) cliArgs.push('--root', String(args.root));
      if (args.heal) cliArgs.push('--heal');
      if (args.materializeHar) cliArgs.push('--materialize-har');
      if (args.strict) cliArgs.push('--strict');
      const r = await runCli(cliArgs);
      return text('exit=' + r.code + '\n' + r.out);
    }
    case 'heimdall_dedupe': {
      const cliArgs = ['dedupe', args.host];
      if (args.dryRun) cliArgs.push('--dry-run');
      const r = await runCli(cliArgs);
      return text('exit=' + r.code + '\n' + r.out);
    }
    default: throw new Error('unknown tool: ' + name);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const protocolVersion = params?.protocolVersion || DEFAULT_PROTOCOL;
    return ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const res = await callTool(params?.name, params?.arguments ?? {});
      return ok(id, res);
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: 'ERROR: ' + String(e).slice(0, 500) }], isError: true });
    }
  }
  return fail(id, -32601, 'Method not found: ' + method);
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    handle(msg).catch((e) => fail(msg.id, -32603, String(e).slice(0, 300)));
  });
}
