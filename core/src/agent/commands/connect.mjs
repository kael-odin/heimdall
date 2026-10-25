/**
 * heimdall connect —— 把 Heimdall MCP 写进客户端配置（E11-02，PRD 07 §2.2、附录 A §5.2）
 *
 *   heimdall connect <client> [--dry-run] [--yes] [--project]
 *   heimdall connect <client> --remove
 *
 * 客户端：claude-code | claude-desktop | cursor | vscode（Ph1）；codex 配置是 TOML，Ph2 再做。
 * 流程：检测 → 展示将写入的差异 → 备份 → 写入 → **自测**（用同一份启动命令拉起 stdio 服务，
 * 走 tools/list 与一次 overview）→ 失败时还原备份。
 * 配置里写 node 的绝对路径与 MCP 服务的绝对路径（Windows 原生可用，路径含空格也不怕）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CORE_ROOT } from '../../paths.mjs';
import { ok, fail, fromError, exitCodeOf, nextAction, CapabilityError } from '../envelope.mjs';
import { parseArgs } from '../cli.mjs';

const HOME = homedir();
const REPO = resolve(CORE_ROOT, '..');
const SERVER = join(REPO, 'packages', 'mcp', 'bin', 'heimdall-mcp.mjs');
const NODE = process.execPath;
const NAME = 'heimdall';

/** 各客户端的配置位置与格式（Ph0 S3 在本机逐个查过；写盘格式以能读回为准） */
export const CLIENTS = Object.freeze({
  'claude-code': { label: 'Claude Code', kind: 'claude-json', file: join(HOME, '.claude.json'), projectFile: '.mcp.json', detect: () => existsSync(join(HOME, '.claude.json')) },
  'claude-desktop': { label: 'Claude Desktop', kind: 'mcpServers', file: join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'), detect: () => existsSync(join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')) },
  cursor: { label: 'Cursor', kind: 'mcpServers', file: join(HOME, '.cursor', 'mcp.json'), projectFile: '.cursor/mcp.json', detect: () => existsSync(join(HOME, '.cursor')) },
  vscode: { label: 'VS Code', kind: 'vscode', file: join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json'), projectFile: '.vscode/mcp.json', detect: () => existsSync(join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Code', 'User')) },
});

const readJsonLoose = (file) => {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new CapabilityError('invalid_args', `配置文件不是合法 JSON，先手工修好：${file}`); }
};

/** 按客户端格式，把 heimdall 这一项放进文档；返回 { 新文档, 移除后的文档 } */
function withServer(client, doc, entry) {
  const c = CLIENTS[client];
  const next = structuredClone(doc);
  if (c.kind === 'vscode') {
    next.servers = { ...(next.servers ?? {}) };
    if (entry) next.servers[NAME] = { type: 'stdio', command: NODE, args: [SERVER.replace(/\\/g, '/')] };
    else delete next.servers[NAME];
  } else {
    next.mcpServers = { ...(next.mcpServers ?? {}) };
    if (entry) next.mcpServers[NAME] = { command: NODE, args: [SERVER.replace(/\\/g, '/')], env: { HEIMDALL_API: process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900' } };
    else delete next.mcpServers[NAME];
  }
  return next;
}

/** 自测：按写入的启动命令拉起 stdio 服务，tools/list + overview */
async function selfTest() {
  return new Promise((resolveTest) => {
    const p = spawn(NODE, [SERVER], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HEIMDALL_CAPS_TIMEOUT_MS: '3000' } });
    const rl = createInterface({ input: p.stdout });
    const pending = new Map();
    let seq = 0;
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolveTest({ ok: false, error: '自测超时（20 秒）' }); }, 20_000);
    const finish = (r) => { clearTimeout(timer); try { p.kill(); } catch {} resolveTest(r); };
    rl.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    p.on('error', (e) => finish({ ok: false, error: e.message }));
    const request = (method, params = {}) => new Promise((res) => {
      const id = ++seq; pending.set(id, res);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    (async () => {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'heimdall-connect', version: '1' } });
      if (init.error) return finish({ ok: false, error: init.error.message });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await request('tools/list', {});
      const tools = list.result?.tools ?? [];
      if (!tools.length) return finish({ ok: false, error: 'tools/list 为空' });
      const call = await request('tools/call', { name: 'heimdall_overview', arguments: { include: ['engine'] } });
      const text = call.result?.content?.[0]?.text ?? '';
      finish({ ok: true, tools: tools.length, engine: /引擎正常/.test(text) ? 'ok' : 'unreachable' });
    })().catch((e) => finish({ ok: false, error: e.message }));
  });
}

function diffText(before, after, file) {
  const keys = new Set([...Object.keys(before.mcpServers ?? before.servers ?? {}), ...Object.keys(after.mcpServers ?? after.servers ?? {})]);
  const lines = [`文件：${file}`, `键：${'mcpServers' in after || 'mcpServers' in before ? 'mcpServers' : 'servers'}`];
  for (const k of keys) {
    const b = (before.mcpServers ?? before.servers ?? {})[k], a = (after.mcpServers ?? after.servers ?? {})[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    lines.push(b ? `- ${k}: ${JSON.stringify(b)}` : `- （无）`, a ? `+ ${k}: ${JSON.stringify(a)}` : `+ （移除）`);
  }
  return lines.join('\n');
}

async function runConnect(argv) {
  const { flags, positional } = parseArgs(argv);
  const client = positional[0];
  const json = !!flags.json;
  try {
    if (!client || !CLIENTS[client]) throw new CapabilityError('invalid_args', `客户端取 ${Object.keys(CLIENTS).join(' / ')}`, { hint: '例：heimdall connect claude-desktop' });
    const c = CLIENTS[client];
    const file = flags.project ? resolve(c.projectFile ?? (client === 'claude-code' ? '.mcp.json' : '.cursor/mcp.json')) : c.file;
    if (!existsSync(SERVER)) throw new CapabilityError('internal', `MCP 服务不存在：${SERVER}`, { hint: '在仓库里运行 `pnpm mcp:build` 或 `pnpm -C packages/mcp install`' });
    if (!c.detect() && !flags.project) throw new CapabilityError('not_found', `没检测到 ${c.label}`, { hint: `装好 ${c.label} 再试；或加 --project 写进当前项目` });
    const before = readJsonLoose(file);
    const after = withServer(client, before, !flags.remove);
    if (JSON.stringify(before) === JSON.stringify(after)) return ok({ client, file, changed: false }, { summary: `${c.label} 已经是这个配置，没有改动。` });
    const diff = diffText(before, after, file);
    if (flags['dry-run']) return ok({ client, file, dryRun: true, diff }, { summary: `将写入：\n${diff}` });
    let backup = null;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) { backup = `${file}.heimdall-bak`; copyFileSync(file, backup); }
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(after, null, 2) + '\n');
    renameSync(tmp, file);
    // 没移除时才自测（移除之后服务不在了，自测没有意义）
    const test = flags.remove ? null : await selfTest();
    if (test && !test.ok) {
      if (backup) renameSync(backup, file); else writeFileSync(file, JSON.stringify(before, null, 2) + '\n');
      return fail('internal', `写入后自测失败，已还原：${test.error}`, { hint: '`heimdall doctor` 自检；或手工检查 MCP 服务能否用 node 启动' });
    }
    const warnings = test && test.engine !== 'ok' ? [{ code: 'engine_unreachable', message: 'MCP 服务已连通，但引擎没在跑：克隆类工具会提示先 `heimdall serve`' }] : [];
    return ok({ client, file, backup, changed: true, selfTest: test, diff }, {
      summary: flags.remove ? `已从 ${c.label} 移除 Heimdall。` : `${c.label} 已连上：${test.tools} 个工具，引擎${test.engine === 'ok' ? '正常' : '没在跑'}。`
        + (backup ? `\n原配置备份在 ${backup}` : '') + (flags.remove ? '' : '\n重新打开客户端后生效。'),
      nextActions: flags.remove ? [] : [nextAction('heimdall_overview', null, '在客户端里让它先调这个')],
      warnings,
    });
  } catch (error) {
    const env = fromError(error);
    if (json) return env;
    return env;
  }
}

export async function run(argv) {
  const env = await runConnect(argv);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
    for (const w of env.warnings ?? []) process.stdout.write(`! ${w.message}\n`);
  }
  return exitCodeOf(env);
}
