/**
 * agent/cli — CLI 代理模式（E3-01 ~ E3-08，PRD 附录 A §5）
 *
 * 注册表里的每个能力都是一个子命令（overview / site / brief / artifact / compare / jobs / clone / doctor），
 * 外加 CLI 专属命令（rebuild、connect、probe、mcp）。旧命令照旧由 cli.mjs 的命令表处理（E3-06）。
 *
 *   --json        stdout 只有 NDJSON 进度事件与**最后一行**信封；日志一律走 stderr（E3-01）
 *   --wait / --no-wait / --timeout <秒>   长任务的等待语义（E3-02）
 *   退出码        0 成功 · 1 门禁未过 · 2 用法 · 3 环境 · 4 排队 / 超时 · 5 无权限 · 6 预算 · 7 内部（E3-03）
 *   --help --json 机器可读的命令清单（E3-05）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPABILITIES, describeCapabilities, getCapability, toolName } from './registry/index.mjs';
import { invoke } from './registry/invoke.mjs';
import { exitCodeOf, fail } from './envelope.mjs';

export const AGENT_COMMANDS = Object.freeze(CAPABILITIES.map(c => c.id));
export const CLI_ONLY = Object.freeze({
  rebuild: { usage: 'rebuild init <url|siteId> [--page P] [--stack html-css|vite-react-ts-tailwind] [--fidelity …] [--gate …] [--dir D] [--force] [--model-class …] | rebuild status [--project .] | rebuild deliver [--project .] [--out D] [--no-mirror]', desc: '生成重建工作区（--force 覆盖脚手架文件，评测用）；查看进度；按 Floor=Mirror 交付' },
  connect: { usage: 'connect <claude-code|claude-desktop|cursor|vscode> [--remove] [--dry-run] [--yes]', desc: '把 Heimdall MCP 写进客户端配置（先备份，再自测）' },
  probe: { usage: 'probe sizes|outline|har [--site S] [--max N]', desc: '复现 PRD 01 §1.4 的体量、大纲压缩与接口统计' },
  gate: { usage: 'gate baseline <siteId> <page> [--viewport 1440] | gate report [--project .] [--level bronze|silver|gold]', desc: '正式基线供给与体检（E7-19）；六维门禁报告（E7-06），未通过退出码 1' },
  bench: { usage: 'bench score --site S --page P --candidate 标签=目录,… | bench run --site S --page P --project D --arm a1|a2|a3 [--feedback full|targeted] [--edit rewrite|surgical] --iterations N | bench sections --site S --page P --project D | bench summary --site S --page P', desc: 'Heimdall-Bench：测量候选、跑模型消融臂、按分段循环、汇总重复测量（E14-01~03）' },
  mcp: { usage: 'mcp [--http <port>] [--legacy]', desc: 'MCP 服务：默认 v2（stdio）；--legacy 起旧的 13 工具服务器' },
  qa: { usage: 'qa init | login <登录档> | status | run [站点] | findings | show <F编号> | similar "标题" | submit <文件> | verdict <F编号> <裁决> "理由" [--pattern] | rules', desc: '测试工作区：带登录态测试、按以往裁决过滤、只出该提单的问题' },
});

const BOOL_FLAGS = new Set(['json', 'wait', 'no-wait', 'quiet', 'yes', 'refresh', 'force', 'fix', 'remove', 'dry-run', 'help', 'all-discovered', 'recon-only', 'legacy', 'inline', 'no-revert', 'no-mirror', 'pattern', 'no-links', 'texts']);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** 解析 argv：--flag value / --flag=value / 布尔标志；其余是位置参数 */
export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOL_FLAGS.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[k] = true;
      else flags[k] = argv[++i];
    } else positional.push(a);
  }
  return { flags, positional };
}

const num = (v) => (v === undefined || v === true ? undefined : Number(v));
const list = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map(s => s.trim()).filter(Boolean));

/** 把命令行翻译成能力入参 */
export function argsFor(id, { flags, positional }) {
  const a = {};
  const set = (k, v) => { if (v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))) a[k] = v; };
  switch (id) {
    case 'overview': set('limit', num(flags.limit)); set('include', list(flags.include)); break;
    case 'site': set('siteId', positional[0] ?? flags['site-id']); set('view', flags.view); set('limit', num(flags.limit)); set('cursor', num(flags.cursor)); break;
    case 'brief':
      if (flags.project) set('project', resolve(String(flags.project === true ? '.' : flags.project)));
      set('siteId', positional[0] ?? flags['site-id']); set('page', positional[1] ?? flags.page);
      set('detail', flags.detail ?? (flags['section-id'] || flags.section ? 'full' : undefined)); set('sectionId', flags['section-id'] ?? flags.section);
      set('fidelity', flags.fidelity); set('tokenBudget', num(flags['token-budget'])); if (flags.refresh) a.refresh = true;
      break;
    case 'artifact':
      set('uri', positional[0] ?? flags.uri); set('save', flags.save ? resolve(String(flags.save)) : undefined); set('maxBytes', num(flags['max-bytes']));
      if (flags['range-offset'] !== undefined || flags['range-limit'] !== undefined) a.range = { ...(num(flags['range-offset']) !== undefined ? { offset: num(flags['range-offset']) } : {}), ...(num(flags['range-limit']) !== undefined ? { limit: num(flags['range-limit']) } : {}) };
      break;
    case 'compare':
      if (flags.project) a.candidate = { dir: resolve(String(flags.project === true ? '.' : flags.project)) };
      else if (flags.url) a.candidate = { url: String(flags.url) };
      set('siteId', positional[0] ?? flags['site-id']); set('page', positional[1] ?? flags.page); set('route', flags.route);
      set('mode', flags.mode); set('viewports', list(flags.viewports ?? flags.viewport)?.map(Number));
      set('sectionIds', list(flags['section-id'] ?? flags.section));
      // --gate 不带值：未到 pass-candidate 即退出码 1（CI 用）；--gate <level>：指定目标等级（URL 模式）
      if (flags.gate === true) a.requireGate = true; else if (flags.gate) a.gate = { level: flags.gate };
      set('inlineCrops', 0);
      break;
    case 'jobs': set('action', positional[0] ?? 'list'); set('jobId', positional[1] ?? flags['job-id']); set('waitMs', num(flags['wait-ms'])); set('after', num(flags.after)); set('limit', num(flags.limit)); set('status', flags.status); break;
    case 'clone':
      set('url', positional[0] && /^https?:/i.test(positional[0]) ? positional[0] : flags.url); set('siteId', positional[0] && !/^https?:/i.test(positional[0]) ? positional[0] : flags['site-id']);
      set('scope', flags.scope); set('level', flags.level); set('pageName', flags['page-name']); set('maxPages', num(flags['max-pages']));
      if (flags['all-discovered']) a.allDiscovered = true; if (flags.force) a.force = true; if (flags['recon-only']) a.reconOnly = true;
      set('reuse', flags.reuse); set('idempotencyKey', flags['idempotency-key']);
      break;
    case 'doctor': set('checks', list(flags.checks)); if (flags.fix) a.fix = true; break;
    case 'qa_status': set('workspace', flags.workspace ? resolve(String(flags.workspace)) : undefined); break;
    case 'qa_run':
      set('workspace', flags.workspace ? resolve(String(flags.workspace)) : undefined);
      set('site', positional[0] ?? flags.site); set('pages', list(flags.pages)); set('viewports', list(flags.viewports)?.map(Number));
      set('checksFile', flags.checks ? resolve(String(flags.checks)) : undefined); set('login', flags.login); set('label', flags.label);
      if (flags['no-links']) a.linkCheck = false; if (flags.texts) a.collectTexts = true;
      break;
    case 'qa_findings': {
      set('workspace', flags.workspace ? resolve(String(flags.workspace)) : undefined);
      set('action', flags.action); set('runId', flags.run); set('id', flags.id); set('status', flags.status); set('limit', num(flags.limit));
      set('title', flags.title); set('path', flags.path); set('verdict', flags.verdict); set('reason', flags.reason);
      set('until', flags.until); set('reopenIf', flags['reopen-if']); set('ruleId', flags['rule-id']);
      if (flags.pattern) a.pattern = true;
      if (flags.file) {
        const data = JSON.parse(readFileSync(resolve(String(flags.file)), 'utf8'));
        a.findings = Array.isArray(data) ? data : data.findings;
      }
      break;
    }
    default: break;
  }
  return a;
}

/** 给人看的输出（非 --json） */
function human(env, id, quiet) {
  if (quiet) return env.ok ? JSON.stringify(env.result) : `${env.error.code}: ${env.error.message}`;
  const lines = [env.summary];
  if (!env.ok) lines.push(`[${env.error.code}] ${env.error.message}`, `下一步：${env.error.hint}`);
  if (id === 'compare' && env.result?.packetText) lines.push('', env.result.packetText.trimEnd(), ...(env.result.runDir ? [`修复包与裁剪图：${env.result.runDir}`] : []));
  if (id === 'brief' && env.ok) {
    const r = env.result;
    if (r.outline) lines.push('', r.outline);
    if (r.sections) lines.push('', ...r.sections.map(s => `${s.id}  ${s.role.padEnd(8)} 1440:${JSON.stringify(s.boxes[1440])}`));
    if (r.slice) lines.push('', r.slice.text, ...(r.slice.cssRules ? ['', r.slice.cssRules] : []));
  }
  if (id === 'doctor' && env.ok) for (const c of env.result.checks) lines.push(`${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.id.padEnd(9)} ${c.detail}${c.fix ? `  → ${c.fix.command}` : ''}`);
  if (id === 'overview' && env.ok && env.result.sites) lines.push('', ...env.result.sites.map(s => `${s.siteId.padEnd(40)} ${String(s.cloned).padStart(4)} 页有镜像`));
  if (id === 'site' && env.ok && env.result.pages) lines.push('', ...env.result.pages.map(p => `${p.page.padEnd(40)} ${p.mirror ? '镜像✓' : '      '} ${p.score ? p.score.grade + ' ' + p.score.total : ''}`));
  if (id === 'artifact' && env.ok) { if (env.result.text) lines.push('', env.result.text); else if (env.result.json) lines.push('', JSON.stringify(env.result.json, null, 2).slice(0, 20000)); if (env.result.savedTo) lines.push(`已保存：${env.result.savedTo}`); }
  if ((id === 'jobs' || id === 'clone') && env.ok && env.result?.jobs) lines.push('', ...env.result.jobs.map(j => `${j.jobId} ${j.capability} ${j.status} ${j.createdAt}`));
  const next = (env.nextActions ?? []).slice(0, 3);
  if (next.length) lines.push('', '下一步：', ...next.map(n => `  ${n.tool}${n.args ? ' ' + JSON.stringify(n.args) : ''} — ${n.reason}`));
  return lines.join('\n');
}

/** 机器可读的命令清单（--help --json） */
export function helpJson(legacyCommands = {}) {
  return {
    ok: true,
    result: {
      agentCommands: describeCapabilities().map(c => ({ command: c.id, usage: `heimdall ${c.cli?.usage ?? c.id}`, tool: c.tool, description: c.description, effects: c.effects, scope: c.scope, input: c.input })),
      cliOnly: Object.entries(CLI_ONLY).map(([command, c]) => ({ command, usage: `heimdall ${c.usage}`, description: c.desc })),
      legacyCommands: Object.entries(legacyCommands).map(([command, c]) => ({ command, usage: `heimdall ${c.usage}`, description: c.desc })),
      globalFlags: ['--json', '--wait', '--no-wait', '--timeout <seconds>', '--quiet', '--yes'],
      exitCodes: { 0: 'success', 1: 'gate failed or partial', 2: 'usage / precondition', 3: 'engine or environment unavailable', 4: 'queued, busy or wait timed out', 5: 'unauthorized / forbidden', 6: 'budget exceeded', 7: 'internal error' },
    },
    summary: `${CAPABILITIES.length} 个代理命令、${Object.keys(CLI_ONLY).length} 个 CLI 专属命令、${Object.keys(legacyCommands).length} 个旧命令。`,
    nextActions: [], evidence: [],
  };
}

/**
 * 运行一个代理命令。返回退出码。
 * out / err：写 stdout / stderr 的函数（测试里可替换）
 */
export async function runAgentCommand(id, argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const parsed = parseArgs(argv);
  const { flags } = parsed;
  const json = !!flags.json;
  const cap = getCapability(id);
  if (flags.help) {
    const d = describeCapabilities().find(c => c.id === id);
    if (json) out(JSON.stringify({ ok: true, result: d, summary: d.title, nextActions: [], evidence: [] }) + '\n');
    else out(`heimdall ${cap.cli?.usage ?? id}\n\n${cap.title}\n${cap.description}\n\n参数（JSON Schema）：\n${JSON.stringify(cap.input, null, 2)}\n`);
    return 0;
  }
  let args;
  try { args = argsFor(id, parsed); } catch (error) { args = null; err(String(error.message) + '\n'); }
  if (!args) { const env = fail('invalid_args', '参数解析失败'); out((json ? JSON.stringify(env) : human(env, id)) + '\n'); return exitCodeOf(env); }
  const noWait = flags['no-wait'] === true || flags.wait === false;
  const timeoutMs = flags.timeout !== undefined ? Math.max(1, Number(flags.timeout)) * 1000 : null;
  const onProgress = json ? (p) => out(JSON.stringify({ kind: 'progress', ...p }) + '\n') : (p) => err(`… ${p.message ?? p.stage}\n`);
  const ctx = { client: 'cli', onProgress, detachEngine: noWait };
  let env = await invoke(id, args, ctx);
  // 长任务：默认等到结束（--wait），--no-wait 立即返回 jobId；--timeout 到点返回 timeout + jobId（退出码 4）
  if (env.ok && env.jobId && !noWait && cap?.longRunning && !['succeeded', 'failed', 'cancelled'].includes(env.result?.status)) {
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    let lastSeq = 0;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        env = fail('timeout', `等待超时，任务 ${env.jobId} 仍在进行`, { hint: `heimdall jobs wait ${env.jobId}`, result: { jobId: env.jobId, status: env.result?.status } });
        env.jobId = env.result.jobId;
        break;
      }
      const w = await invoke('jobs', { action: 'wait', jobId: env.jobId, waitMs: Math.min(30_000, left) }, ctx);
      const ev = await invoke('jobs', { action: 'events', jobId: env.jobId, after: lastSeq, limit: 200 }, ctx);
      for (const e of ev.result?.events ?? []) { lastSeq = e.seq; if (e.kind !== 'progress' || json) onProgress({ stage: e.stage ?? e.kind, pct: e.pct, message: e.message }); }
      if (!w.ok) { env = w; break; }
      if (!w.result.timedOut) {
        const job = w.result;
        env = job.status === 'succeeded'
          ? { ...w, result: { status: job.status, jobId: job.jobId, ...(job.result ?? {}) } }
          : fail('internal', `任务${job.status === 'cancelled' ? '已取消' : '失败'}：${job.error?.message ?? job.status}`, { hint: job.error?.hint, result: { jobId: job.jobId, status: job.status } });
        break;
      }
    }
  }
  if (json) out(JSON.stringify(env) + '\n');
  else out(human(env, id, !!flags.quiet) + '\n');
  return exitCodeOf(env);
}
