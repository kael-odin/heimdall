/**
 * capability: doctor —— 环境自检，每项给出人话原因与修复命令（附录 A §2.8，E11-01、E11-07）
 *
 * MCP / HTTP 版只诊断；自动修复（--fix：装 Chromium、起引擎）只在 CLI（见 agent/cli.mjs）。
 */
import { existsSync, accessSync, constants, statfsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { DATA_ROOT } from '../../../paths.mjs';
import { getEnv } from '../../../env.mjs';
import { ok, fail, exitCodeOf, nextAction } from '../../envelope.mjs';
import { probeEngine, readEngineState } from '../../engine-client.mjs';
import { dependencySummary, inspectChromium, inspectConsole, inspectDependencies, inspectMcp } from '../../installation.mjs';
import { inspectClientConfigs } from '../../commands/connect.mjs';
import { parseArgs } from '../../parse-args.mjs';

const CHECKS = ['node', 'pnpm', 'dependencies', 'chromium', 'console', 'mcp', 'engine', 'dataRoot', 'port', 'token', 'disk', 'llm', 'clients'];

async function portInUse(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(true));
    s.listen(port, '127.0.0.1', () => s.close(() => done(false)));
  });
}

export async function runChecks(names = CHECKS) {
  const out = [];
  const add = (id, status, detail, fix) => out.push({ id, status, detail, ...(fix ? { fix } : {}) });
  for (const id of names) {
    if (id === 'node') {
      const [maj, min] = process.versions.node.split('.').map(Number);
      const good = maj > 22 || (maj === 22 && min >= 13);
      add('node', good ? 'ok' : 'fail', `Node ${process.versions.node}${good ? '' : '，需要 ≥ 22.13'}`, good ? null : { command: '安装 Node 22.13 或更新版本', auto: false });
    } else if (id === 'pnpm') {
      // Windows 上 pnpm 是 .cmd，需要经 shell；把整条命令写成一个字符串，避免「带参数的 shell 调用」告警
      const r = process.platform === 'win32'
        ? spawnSync('pnpm --version', { encoding: 'utf8', shell: true, timeout: 10_000, windowsHide: true })
        : spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 10_000 });
      const v = (r.stdout ?? '').trim();
      add('pnpm', r.status === 0 && v ? 'ok' : 'warn', r.status === 0 && v ? `pnpm ${v}` : '没找到 pnpm（只影响安装依赖与重建工作区的 pnpm dev）', r.status === 0 && v ? null : { command: 'corepack enable', auto: false });
    } else if (id === 'dependencies') {
      const states = inspectDependencies();
      const ready = states.every(state => state.ready);
      add('dependencies', ready ? 'ok' : 'fail', dependencySummary(states),
        ready ? null : { command: 'heimdall setup', auto: true });
    } else if (id === 'chromium') {
      const state = await inspectChromium();
      const good = state.ready;
      const detail = good ? 'Playwright Chromium 已安装'
        : state.reason === 'dependency_missing' ? 'core 依赖尚未安装，无法找到 Playwright Chromium'
          : '没有可用的 Playwright Chromium（简报、对比都需要它）';
      add('chromium', good ? 'ok' : 'fail', detail,
        good ? null : { command: 'pnpm -C core exec playwright install chromium', auto: true });
    } else if (id === 'console') {
      const state = inspectConsole();
      add('console', state.ready ? 'ok' : 'fail',
        state.ready ? `控制台产物已就绪：${state.dist}`
          : state.reason === 'stale' ? '控制台源码比 dist 新，需要重新构建' : '控制台尚未构建（仍可使用 CLI/MCP，但没有网页界面）',
        state.ready ? null : { command: 'pnpm -C console build', auto: true });
    } else if (id === 'mcp') {
      const state = inspectMcp();
      add('mcp', state.ready ? 'ok' : 'fail',
        state.ready ? `MCP 源入口与插件单文件都在：${state.artifact}` : `MCP 产物缺失 ${state.missing.length} 个`,
        state.ready ? null : { command: 'heimdall setup', auto: true });
    } else if (id === 'engine') {
      const bases = [...new Set([process.env.HEIMDALL_API, readEngineState()?.base, 'http://127.0.0.1:8900'].filter(Boolean))];
      let found = null;
      for (const b of bases) { const p = await probeEngine(b); if (p) { found = p; break; } }
      if (!found) add('engine', 'warn', '引擎没在跑：读类工具照常可用，clone 会自起临时引擎', { command: 'heimdall serve', auto: true });
      else if (found.unauthorized) add('engine', 'fail', `引擎 ${found.base} 要求令牌`, { command: '设置 HEIMDALL_TOKEN', auto: false });
      else if (!found.sameRoot) add('engine', 'fail', `引擎 ${found.base} 的数据根与本机不一致`, { command: '统一 HEIMDALL_DATA_DIR，或停掉那个引擎', auto: false });
      else add('engine', 'ok', `引擎在 ${found.base}`);
    } else if (id === 'dataRoot') {
      try { mkdirSync(DATA_ROOT, { recursive: true }); accessSync(DATA_ROOT, constants.W_OK); add('dataRoot', 'ok', `数据根可写：${DATA_ROOT}`); }
      catch { add('dataRoot', 'fail', `数据根不可写：${DATA_ROOT}`, { command: '设置可写的 HEIMDALL_DATA_DIR', auto: false }); }
    } else if (id === 'port') {
      const busy = await portInUse(8900);
      add('port', 'ok', busy ? '8900 已被占用（多半是在跑的引擎；clone 会自动换端口）' : '8900 空闲');
    } else if (id === 'token') {
      add('token', 'ok', process.env.HEIMDALL_TOKEN ? '已设置 HEIMDALL_TOKEN（不回显）' : '未设置令牌：仅本机回环可访问引擎');
    } else if (id === 'disk') {
      try {
        const s = statfsSync(DATA_ROOT);
        const freeGb = s.bavail * s.bsize / 1e9;
        add('disk', freeGb < 2 ? 'warn' : 'ok', `数据根所在盘剩余 ${freeGb.toFixed(1)} GB`, freeGb < 2 ? { command: '清理磁盘或迁移数据根（HEIMDALL_DATA_DIR）', auto: false } : null);
      } catch { add('disk', 'warn', '读不到磁盘剩余空间'); }
    } else if (id === 'llm') {
      const env = getEnv();
      const configured = !!(env.LLM_API_KEY || process.env.LLM_API_KEY);
      add('llm', configured ? 'ok' : 'warn', configured ? '已配置模型服务（只用于 fixup 校准与验收解读；外部代理不需要它）' : '没有配置模型服务（外部代理用自己的模型，不影响重建环）');
    } else if (id === 'clients') {
      const clients = inspectClientConfigs();
      const installed = clients.filter(c => c.installed);
      const configured = clients.filter(c => c.configured);
      const invalid = clients.filter(c => c.error);
      const detail = `${installed.length} 个已安装，${configured.length} 个已配置 Heimdall`
        + (configured.length ? `（${configured.map(c => `${c.label}${c.pluginVersion ? ` 插件 ${c.pluginVersion}` : ''}`).join('、')}）` : '')
        + (invalid.length ? `；${invalid.map(c => c.label).join('、')} 配置读取失败` : '');
      add('clients', invalid.length ? 'fail' : installed.length && !configured.length ? 'warn' : 'ok', detail,
        invalid.length ? { command: '修复对应客户端的 JSON/TOML 后运行 heimdall setup', auto: false }
          : installed.length && !configured.length ? { command: 'heimdall setup', auto: false } : null);
    }
  }
  return out;
}

export default {
  id: 'doctor',
  title: '自检：环境与修复命令',
  description: 'Check the local environment: Node, pnpm, installed dependencies, Playwright Chromium, console and MCP artifacts, the engine, '
    + 'data root, port 8900, token, disk space, the optional model service and configured AI clients. Each check returns ok/warn/fail with a plain-language reason and the command that fixes it. Run it first, '
    + 'and after any engine_unreachable, chromium_missing or data_root_mismatch error. Diagnosis only (the CLI "heimdall doctor --fix" applies safe fixes).',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      checks: { type: 'array', items: { type: 'string', enum: CHECKS } },
      fix: { type: 'boolean', default: false, description: 'CLI only: install missing dependencies/Chromium, build console/MCP and start the engine' },
    },
  },
  cli: { usage: 'doctor [--fix] [--checks a,b]', positional: [] },
  async handler(args) {
    let checks = await runChecks(args.checks ?? CHECKS);
    // --fix 只在 CLI：装 Chromium、起引擎（本机模式下不鉴权，只听回环）。MCP 版只诊断。
    if (args.fix) {
      const { applyFixes } = await import('../../doctor-fix.mjs');
      checks = await applyFixes(checks);
    }
    const failed = checks.filter(c => c.status === 'fail');
    const warned = checks.filter(c => c.status === 'warn');
    const summary = failed.length ? `${failed.length} 项需要处理：${failed.map(c => c.id).join('、')}。` : warned.length ? `可以开始；${warned.length} 项提醒：${warned.map(c => c.id).join('、')}。` : '环境就绪。';
    const nextActions = failed.length
      ? failed.filter(c => c.fix).map(c => nextAction(`cli:${c.fix.auto ? 'doctor --fix' : 'shell'}`, { command: c.fix.command }, `修复 ${c.id}`))
      : [nextAction('heimdall_overview', null, '查看本机站点与任务')];
    return ok({ checks }, { summary, nextActions });
  },
};

/**
 * CLI 专用轻量入口。core/src/cli.mjs 会在能力注册表之前分派 doctor，
 * 这样 node_modules 缺失时仍能拿到“先跑 setup”的可执行诊断。
 */
export async function runDoctorCli(argv) {
  const { flags } = parseArgs(argv);
  const json = !!flags.json;
  if (flags.help) {
    const result = {
      command: 'doctor', usage: 'heimdall doctor [--fix] [--checks a,b] [--json]',
      checks: CHECKS,
      fixable: ['dependencies', 'chromium', 'console', 'mcp', 'engine'],
    };
    if (json) process.stdout.write(JSON.stringify(ok(result, { summary: '环境与 AI 接入自检。' })) + '\n');
    else process.stdout.write(`Heimdall doctor\n\n用法：${result.usage}\n检查：${CHECKS.join(' / ')}\n--fix：按需安装依赖/Chromium、构建控制台/MCP、启动引擎（不会擅自改 Node、磁盘或客户端文件）\n`);
    return 0;
  }
  const requested = flags.checks && flags.checks !== true
    ? String(flags.checks).split(',').map(s => s.trim()).filter(name => CHECKS.includes(name))
    : CHECKS;
  if (!requested.length) {
    const env = fail('invalid_args', `--checks 没有有效项；可选 ${CHECKS.join(' / ')}`);
    process.stdout.write((json ? JSON.stringify(env) : `${env.summary}\n${env.error.hint}`) + '\n');
    return exitCodeOf(env);
  }
  let checks = await runChecks(requested);
  if (flags.fix) {
    const { applyFixes } = await import('../../doctor-fix.mjs');
    checks = await applyFixes(checks);
  }
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');
  const summary = failed.length
    ? `${failed.length} 项需要处理：${failed.map(c => c.id).join('、')}。`
    : warned.length ? `可以开始；${warned.length} 项提醒：${warned.map(c => c.id).join('、')}。` : '环境就绪。';
  const env = ok({ checks }, {
    summary,
    nextActions: failed.filter(c => c.fix)
      .map(c => nextAction(`cli:${c.fix.auto ? 'doctor --fix' : 'shell'}`, { command: c.fix.command }, `修复 ${c.id}`)),
  });
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(summary + '\n');
    for (const check of checks) {
      process.stdout.write(`${check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗'} ${check.id.padEnd(12)} ${check.detail}${check.fix ? `  -> ${check.fix.command}` : ''}\n`);
    }
  }
  return failed.length ? 3 : 0;
}
