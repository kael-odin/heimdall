/**
 * heimdall connect —— 把 Heimdall MCP 写进客户端配置（E11-02，PRD 07 §2.2、附录 A §5.2）
 *
 *   heimdall connect <client> [--api URL] [--dry-run] [--yes] [--project]
 *   heimdall connect <client> --remove
 *
 * 客户端：claude-code | claude-desktop | cursor | vscode | codex。
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
import { parseArgs } from '../parse-args.mjs';

const HOME = homedir();
const REPO = resolve(CORE_ROOT, '..');
const SERVER = join(REPO, 'packages', 'mcp', 'bin', 'heimdall-mcp.mjs');
const NODE = process.execPath;
const NAME = 'heimdall';
export const DEFAULT_API = 'http://127.0.0.1:8900';
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local');
const CLAUDE_DESKTOP_DIR = join(APPDATA, 'Claude');
const CODEX_HOME = process.env.CODEX_HOME ?? join(HOME, '.codex');
const CLAUDE_PLUGIN_MANIFEST = join(HOME, '.claude', 'plugins', 'installed_plugins.json');

/** 各客户端的配置位置与格式（Ph0 S3 在本机逐个查过；写盘格式以能读回为准） */
export const CLIENTS = Object.freeze({
  'claude-code': { label: 'Claude Code', kind: 'claude-json', file: join(HOME, '.claude.json'), projectFile: '.mcp.json', detect: () => existsSync(join(HOME, '.claude.json')) },
  'claude-desktop': { label: 'Claude Desktop', kind: 'mcpServers', file: join(CLAUDE_DESKTOP_DIR, 'claude_desktop_config.json'), detect: () => existsSync(CLAUDE_DESKTOP_DIR) || existsSync(join(LOCALAPPDATA, 'Claude')) },
  cursor: { label: 'Cursor', kind: 'mcpServers', file: join(HOME, '.cursor', 'mcp.json'), projectFile: '.cursor/mcp.json', detect: () => existsSync(join(HOME, '.cursor')) },
  vscode: { label: 'VS Code', kind: 'vscode', file: join(APPDATA, 'Code', 'User', 'mcp.json'), projectFile: '.vscode/mcp.json', detect: () => existsSync(join(APPDATA, 'Code', 'User')) },
  codex: { label: 'Codex', kind: 'codex-toml', file: join(CODEX_HOME, 'config.toml'), detect: () => existsSync(CODEX_HOME) },
});

const readJsonLoose = (file) => {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new CapabilityError('invalid_args', `配置文件不是合法 JSON，先手工修好：${file}`); }
};

const readText = (file) => existsSync(file) ? readFileSync(file, 'utf8') : '';

/** 校验并规范化写入客户端 / 自测共同使用的引擎地址。 */
export function normalizeApi(value = process.env.HEIMDALL_API ?? DEFAULT_API) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new CapabilityError('invalid_args', 'HEIMDALL_API 必须是合法的 HTTP(S) 地址'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CapabilityError('invalid_args', 'HEIMDALL_API 必须是不含账号、查询和片段的 HTTP(S) 地址');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new CapabilityError('invalid_args', 'HEIMDALL_API 不能带子路径');
  }
  return url.origin;
}

/** 一份客户端配置对应的真实启动命令；写入和自测都从这里取，避免两边漂移。 */
export function serverLaunch({ api = process.env.HEIMDALL_API ?? DEFAULT_API, node = NODE, server = SERVER } = {}) {
  return {
    command: node,
    args: [server.replace(/\\/g, '/')],
    env: { HEIMDALL_API: normalizeApi(api) },
  };
}

export function selfTestEnv(api, base = process.env) {
  return { ...base, HEIMDALL_API: normalizeApi(api), HEIMDALL_CAPS_TIMEOUT_MS: '3000' };
}

function claudeCodePlugin() {
  try {
    const manifest = JSON.parse(readText(CLAUDE_PLUGIN_MANIFEST) || '{}');
    const entries = manifest.plugins?.['heimdall@heimdall'];
    const entry = Array.isArray(entries) ? entries.find(item => item?.scope === 'user') ?? entries[0] : null;
    return entry?.installPath && existsSync(entry.installPath)
      ? { version: entry.version ?? null, path: entry.installPath }
      : null;
  } catch { return null; }
}

/** 只读检查客户端是否安装、是否已有 Heimdall 项；不回显任何配置内容。 */
export function inspectClientConfigs() {
  return Object.entries(CLIENTS).map(([client, config]) => {
    const installed = config.detect();
    let configured = false;
    let error = null;
    try {
      if (config.kind === 'codex-toml') {
        configured = /^\s*\[mcp_servers\.heimdall(?:\.|\])/m.test(readText(config.file));
      } else if (existsSync(config.file)) {
        const doc = readJsonLoose(config.file);
        configured = !!(doc.mcpServers?.[NAME] ?? doc.servers?.[NAME]);
      }
    } catch (cause) { error = String(cause?.message ?? cause).slice(0, 160); }
    const plugin = client === 'claude-code' ? claudeCodePlugin() : null;
    if (plugin) configured = true;
    return {
      client, label: config.label, installed, configured, file: config.file,
      ...(plugin ? { pluginVersion: plugin.version, pluginPath: plugin.path } : {}),
      ...(error ? { error } : {}),
    };
  });
}

/** 按客户端格式，把 heimdall 这一项放进文档；返回 { 新文档, 移除后的文档 } */
export function withServer(client, doc, entry, options = {}) {
  const c = CLIENTS[client];
  const next = structuredClone(doc);
  const launch = serverLaunch(options);
  if (c.kind === 'vscode') {
    next.servers = { ...(next.servers ?? {}) };
    if (entry) next.servers[NAME] = { type: 'stdio', ...launch };
    else delete next.servers[NAME];
  } else {
    next.mcpServers = { ...(next.mcpServers ?? {}) };
    if (entry) next.mcpServers[NAME] = launch;
    else delete next.mcpServers[NAME];
  }
  return next;
}

/** 只移除 Heimdall 自己的 TOML 表，保留 Codex 的其它 MCP 服务器和注释。 */
export function stripCodexServer(text) {
  const out = [];
  let skipping = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) skipping = header[1] === 'mcp_servers.heimdall' || header[1].startsWith('mcp_servers.heimdall.');
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function codexServerBlock({ node = NODE, server = SERVER, api = DEFAULT_API } = {}) {
  return [
    '[mcp_servers.heimdall]',
    `command = ${JSON.stringify(node)}`,
    `args = [${JSON.stringify(server.replace(/\\/g, '/'))}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 300',
    '',
    '[mcp_servers.heimdall.env]',
    `HEIMDALL_API = ${JSON.stringify(normalizeApi(api))}`,
  ].join('\n');
}

/** Codex 使用 TOML；这里只维护一个独立表，避免重写用户其它配置。 */
export function withCodexServer(text, entry, options = {}) {
  const base = stripCodexServer(text);
  if (!entry) return base ? base + '\n' : '';
  const block = codexServerBlock(options);
  return (base ? base + '\n\n' : '') + block + '\n';
}

/** 自测：按写入的启动命令拉起 stdio 服务，tools/list + overview */
async function selfTest(launch, { spawnProcess = spawn } = {}) {
  return new Promise((resolveTest) => {
    const p = spawnProcess(launch.command, launch.args, {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: selfTestEnv(launch.env.HEIMDALL_API),
    });
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

function diffText(before, after, file, kind, api) {
  if (kind === 'codex-toml') {
    const beforeHas = /^\s*\[mcp_servers\.heimdall\]\s*$/m.test(String(before ?? ''));
    const afterHas = /^\s*\[mcp_servers\.heimdall\]\s*$/m.test(String(after ?? ''));
    return [`文件：${file}`, '节：[mcp_servers.heimdall]',
      beforeHas ? '- 已有 Heimdall MCP 配置' : '- （无）',
      afterHas ? `+ 写入 Heimdall MCP 配置（stdio，HEIMDALL_API=${api}）` : '+ （移除）'].join('\n');
  }
  const keys = new Set([...Object.keys(before.mcpServers ?? before.servers ?? {}), ...Object.keys(after.mcpServers ?? after.servers ?? {})]);
  const lines = [`文件：${file}`, `键：${'mcpServers' in after || 'mcpServers' in before ? 'mcpServers' : 'servers'}`];
  for (const k of keys) {
    const b = (before.mcpServers ?? before.servers ?? {})[k], a = (after.mcpServers ?? after.servers ?? {})[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    lines.push(b ? `- ${k}: ${JSON.stringify(b)}` : `- （无）`, a ? `+ ${k}: ${JSON.stringify(a)}` : `+ （移除）`);
  }
  return lines.join('\n');
}

export async function connectClient(argv) {
  const { flags, positional } = parseArgs(argv);
  const client = positional[0];
  try {
    if (!client || !CLIENTS[client]) throw new CapabilityError('invalid_args', `客户端取 ${Object.keys(CLIENTS).join(' / ')}`, { hint: '例：heimdall connect claude-desktop' });
    const c = CLIENTS[client];
    if (flags.project && !c.projectFile) throw new CapabilityError('invalid_args', `${c.label} 只有全局配置，不支持 --project`);
    const file = flags.project ? resolve(c.projectFile) : c.file;
    if (!existsSync(SERVER)) throw new CapabilityError('internal', `MCP 服务不存在：${SERVER}`, { hint: '在仓库里运行 `pnpm mcp:build` 或 `pnpm -C packages/mcp install`' });
    if (!c.detect() && !flags.project) throw new CapabilityError('not_found', `没检测到 ${c.label}`, { hint: `装好 ${c.label} 再试；或加 --project 写进当前项目` });
    const api = normalizeApi(flags.api);
    const launch = serverLaunch({ api });
    const before = c.kind === 'codex-toml' ? readText(file) : readJsonLoose(file);
    const after = c.kind === 'codex-toml'
      ? withCodexServer(before, !flags.remove, { api })
      : withServer(client, before, !flags.remove, { api });
    const unchanged = c.kind === 'codex-toml' ? before === after : JSON.stringify(before) === JSON.stringify(after);
    if (unchanged) {
      const test = flags.remove || flags['dry-run'] ? null : await selfTest(launch);
      if (test && !test.ok) return fail('internal', `${c.label} 的现有配置自测失败，文件未改动：${test.error}`, { hint: '`heimdall doctor` 自检；或运行 `heimdall connect` 前先启动引擎' });
      return ok({ client, file, api, changed: false, selfTest: test }, {
        summary: `${c.label} 已经是这个配置，没有改动。${flags['dry-run'] ? '这是 dry-run，没有启动 MCP 自测。' : test ? `自测：${test.tools} 个工具，引擎${test.engine === 'ok' ? '正常' : '没在跑'}。` : ''}`,
        warnings: test && test.engine !== 'ok' ? [{ code: 'engine_unreachable', message: 'MCP 服务已连通，但引擎没在跑：克隆类工具会提示先 `heimdall serve`' }] : [],
      });
    }
    const diff = diffText(before, after, file, c.kind, api);
    if (flags['dry-run']) return ok({ client, file, dryRun: true, diff }, { summary: `将写入：\n${diff}` });
    let backup = null;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) { backup = `${file}.heimdall-bak`; copyFileSync(file, backup); }
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, typeof after === 'string' ? after : JSON.stringify(after, null, 2) + '\n');
    renameSync(tmp, file);
    // 没移除时才自测（移除之后服务不在了，自测没有意义）
    const test = flags.remove ? null : await selfTest(launch);
    if (test && !test.ok) {
      if (backup) copyFileSync(backup, file); else writeFileSync(file, typeof before === 'string' ? before : JSON.stringify(before, null, 2) + '\n');
      return fail('internal', `写入后自测失败，已还原：${test.error}`, { hint: '`heimdall doctor` 自检；或手工检查 MCP 服务能否用 node 启动' });
    }
    const warnings = test && test.engine !== 'ok' ? [{ code: 'engine_unreachable', message: 'MCP 服务已连通，但引擎没在跑：克隆类工具会提示先 `heimdall serve`' }] : [];
    return ok({ client, file, api, backup, changed: true, selfTest: test, diff }, {
      summary: flags.remove ? `已从 ${c.label} 移除 Heimdall。` : `${c.label} 已连上：${test.tools} 个工具，引擎${test.engine === 'ok' ? '正常' : '没在跑'}。`
        + (backup ? `\n原配置备份在 ${backup}` : '') + (flags.remove ? '' : '\n重新打开客户端后生效。'),
      nextActions: flags.remove ? [] : [nextAction('heimdall_overview', null, '在客户端里让它先调这个')],
      warnings,
    });
  } catch (error) {
    return fromError(error);
  }
}

export async function run(argv) {
  const env = await connectClient(argv);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
    for (const w of env.warnings ?? []) process.stdout.write(`! ${w.message}\n`);
  }
  return exitCodeOf(env);
}
