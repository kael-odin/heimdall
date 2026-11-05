/**
 * heimdall setup —— 小白可用的幂等安装、启动与 AI 接入入口（E3-11）。
 *
 *   heimdall setup [--registry URL] [--port 8900] [--no-open]
 *                  [--no-connect] [--connect codex,claude-desktop]
 *                  [--force-install] [--json]
 *
 * 默认只做本地、安全、可重复的动作：缺依赖才安装、缺 Chromium 才下载、
 * 控制台源码变化才重建、引擎没跑才启动；已有同数据根的引擎则复用。
 * 默认把 MCP 写进检测到的客户端，但根目录双击启动器会显式加 --no-connect，
 * 避免每次打开 UI 都碰全局配置。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { CORE_ROOT, DATA_ROOT } from '../../paths.mjs';
import { ok, fail, fromError, exitCodeOf, nextAction, CapabilityError } from '../envelope.mjs';
import { parseArgs } from '../parse-args.mjs';
import { normalizeRegistry, runPnpm } from '../rebuild/pnpm.mjs';
import { authHeaders, probeEngine, readEngineState } from '../engine-client.mjs';
import {
  CONSOLE_DIST, CONSOLE_ROOT, DEPENDENCY_ROOTS, MCP_ROOT,
  dependencySummary, inspectChromium, inspectConsole, inspectDependencies, inspectMcp,
  nodeVersionSupported, openExternal, processTail,
} from '../installation.mjs';
import { CLIENTS, connectClient, inspectClientConfigs } from './connect.mjs';

export const SETUP_USAGE = 'setup [--registry URL] [--port 8900] [--no-open] [--no-connect] [--connect codex,claude-desktop] [--force-install] [--json]';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const AUTO_CLIENTS = new Set(['claude-code', 'claude-desktop', 'codex']);
const list = value => value === undefined || value === true
  ? []
  : String(value).split(',').map(s => s.trim()).filter(Boolean);

function parsePort(value) {
  const port = value === undefined ? 8900 : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new CapabilityError('invalid_args', '--port 取 1024–65535');
  }
  return port;
}

async function portAvailable(port) {
  return new Promise(done => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

async function uiReady(base, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(base.replace(/\/$/, '') + '/', {
      headers: authHeaders(),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return { ready: false, status: response.status };
    const text = await response.text();
    return { ready: /Heimdall/i.test(text), status: response.status };
  } catch { return { ready: false, status: null }; }
}

function installRoots(ids) {
  const wanted = new Set(ids);
  return DEPENDENCY_ROOTS.filter(root => wanted.has(root.id));
}

function installArgs(registry) {
  return ['install', '--frozen-lockfile', ...(registry ? ['--registry', registry] : [])];
}

async function ensureEngine({
  base, port, consoleDist, log,
  probe = probeEngine, fetchImpl = fetch, spawnProcess = spawn, sleepImpl = sleep,
  available = portAvailable, state = readEngineState(), env = process.env,
}) {
  const running = await probe(base);
  if (running?.unauthorized) {
    throw new CapabilityError('unauthorized', `端口 ${port} 上的 Heimdall 引擎要求令牌`, {
      hint: '把同一个 HEIMDALL_TOKEN 设置到当前终端，或在客户端里配置同一令牌后重试',
    });
  }
  if (running && !running.sameRoot) {
    throw new CapabilityError('data_root_mismatch', `端口 ${port} 上的引擎使用了另一个数据根`, {
      details: { engine: running.dataRoot, local: resolve(DATA_ROOT) },
      hint: '停掉那个引擎，或统一 HEIMDALL_DATA_DIR 后重新运行 setup',
    });
  }
  if (running?.sameRoot) {
    const ui = await uiReady(base, fetchImpl);
    if (!ui.ready) {
      throw new CapabilityError('data_root_mismatch', `端口 ${port} 上的引擎没有加载控制台`, {
        hint: `先停掉这个引擎，再重新运行 heimdall setup；MCP 健康检查仍应看 ${base}/api/status`,
      });
    }
    return { base, status: 'reused', port, ui };
  }

  if (!(await available(port))) {
    throw new CapabilityError('engine_unreachable', `端口 ${port} 已被其它程序占用，但不是可用的 Heimdall 引擎`, {
      hint: `关掉占用 :${port} 的程序，或用 --port 换一个端口`,
    });
  }

  if (state?.base && state.base !== base) {
    const other = await probe(state.base);
    if (other?.sameRoot) {
      throw new CapabilityError('engine_unreachable', `本机已有一台 Heimdall 引擎在 ${state.base}`, {
        hint: '先停掉这台临时引擎再运行 setup；否则单数据根验收锁会让第二台引擎无法启动',
      });
    }
  }

  log(`启动引擎 ${base}（单端口同时提供控制台）…`);
  const child = spawnProcess(process.execPath, [join(CORE_ROOT, 'src', 'engine-server.mjs'), String(port)], {
    cwd: CORE_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env, HEIMDALL_CONSOLE_DIR: consoleDist },
  });
  let childError = null;
  child.once?.('error', error => { childError = error; });
  child.unref?.();

  for (let i = 0; i < 80; i++) {
    if (childError) break;
    if (child.exitCode !== null && child.exitCode !== undefined) break;
    const status = await probe(base);
    if (status?.unauthorized) {
      try { child.kill(); } catch {}
      throw new CapabilityError('unauthorized', `新引擎在 ${base} 要求令牌，但当前终端没有可用令牌`);
    }
    if (status?.sameRoot) {
      const ui = await uiReady(base, fetchImpl);
      if (ui.ready) return { base, status: 'started', port, pid: child.pid ?? null, ui };
    }
    await sleepImpl(250);
  }
  try { child.kill(); } catch {}
  throw new CapabilityError('engine_unreachable', `引擎 20 秒内没有通过 ${base}/api/status 与控制台检查`, {
    details: { childError: childError ? String(childError.message ?? childError).slice(0, 240) : null, exitCode: child.exitCode ?? null },
    hint: '运行 heimdall doctor；若提示验收锁被占用，先停掉另一台 Heimdall 引擎',
  });
}

/**
 * 执行安装；测试和 doctor --fix 都调用这个函数，而不是走 stdout 外壳。
 */
export async function executeSetup(options = {}, io = {}) {
  let registry, port;
  try {
    registry = normalizeRegistry(options.registry);
    port = parsePort(options.port);
  } catch (error) {
    return fromError(error);
  }
  const base = `http://127.0.0.1:${port}`;
  const log = io.log ?? (message => process.stderr.write(`[setup] ${message}\n`));
  const run = io.runPnpm ?? runPnpm;
  const exists = io.exists ?? existsSync;
  const forceInstall = options.forceInstall === true;
  const steps = [];
  const warnings = [];
  const add = (id, state, detail) => {
    steps.push({ id, ...state, detail });
    log(`${state.status === 'reused' ? '复用' : state.status === 'skipped' ? '跳过' : '完成'} ${id}：${detail}`);
  };

  try {
    if (!nodeVersionSupported()) {
      throw new CapabilityError('internal', `Node ${process.versions.node} 太旧，需要 ≥ 22.13`, {
        hint: '安装 Node 22.13 或更新版本，重开终端后再运行 heimdall setup',
      });
    }
    add('node', { status: 'reused' }, `Node ${process.versions.node}`);

    const pnpmVersion = run(['--version'], { cwd: CORE_ROOT, timeoutMs: 30_000 });
    if (pnpmVersion.status !== 0) {
      throw new CapabilityError('internal', '找不到可运行的 pnpm', {
        hint: '运行 corepack enable；若 Corepack 验签失败，运行 npm install -g pnpm@11.28.10',
      });
    }
    add('pnpm', { status: 'reused' }, `pnpm ${String(pnpmVersion.stdout ?? '').trim()}`);

    const inspectDependencyState = io.inspectDependencies ?? inspectDependencies;
    const inspectConsoleState = io.inspectConsole ?? inspectConsole;
    const inspectMcpState = io.inspectMcp ?? inspectMcp;

    let dependencies = inspectDependencyState();
    const missingIds = dependencies.filter(state => !state.ready).map(state => state.id);
    if (forceInstall || missingIds.length) {
      const targets = forceInstall ? DEPENDENCY_ROOTS : installRoots(missingIds);
      for (const target of targets) {
        log(`安装 ${target.id} 依赖…`);
        const result = run(installArgs(registry), { cwd: target.root, timeoutMs: 900_000 });
        if (result.status !== 0) {
          throw new CapabilityError('internal', `${target.id} 依赖安装失败`, {
            details: { tail: processTail(result) },
            hint: `在 ${target.root} 运行 pnpm install --frozen-lockfile 后重试`,
          });
        }
      }
      dependencies = inspectDependencyState();
      if (dependencies.some(state => !state.ready)) {
        throw new CapabilityError('internal', `依赖安装后仍有缺失：${dependencySummary(dependencies)}`);
      }
      add('dependencies', { status: 'installed' }, `${targets.map(t => t.id).join('、')} 依赖已安装`);
    } else {
      add('dependencies', { status: 'reused' }, dependencySummary(dependencies));
    }

    let chromium = await (io.inspectChromium ?? inspectChromium)();
    if (!chromium.ready) {
      log('安装 Playwright Chromium…');
      const result = run(['exec', 'playwright', 'install', 'chromium'], { cwd: CORE_ROOT, timeoutMs: 900_000 });
      if (result.status !== 0) {
        throw new CapabilityError('internal', 'Playwright Chromium 安装失败', {
          details: { tail: processTail(result) },
          hint: '检查网络或 PLAYWRIGHT_DOWNLOAD_HOST，然后运行 heimdall doctor --fix',
        });
      }
      chromium = await (io.inspectChromium ?? inspectChromium)();
      if (!chromium.ready) throw new CapabilityError('internal', `Chromium 安装后仍不可用（${chromium.reason}）`);
      add('chromium', { status: 'installed' }, chromium.executable);
    } else {
      add('chromium', { status: 'reused' }, chromium.executable);
    }

    let consoleState = inspectConsoleState();
    if (!consoleState.ready) {
      log(consoleState.reason === 'stale' ? '控制台源码比产物新，重新构建…' : '构建控制台…');
      const result = run(['build'], { cwd: CONSOLE_ROOT, timeoutMs: 300_000 });
      if (result.status !== 0) {
        throw new CapabilityError('internal', '控制台构建失败', {
          details: { tail: processTail(result) },
          hint: '运行 pnpm -C console build 查看完整日志',
        });
      }
      consoleState = inspectConsoleState();
      if (!consoleState.ready) throw new CapabilityError('internal', `控制台构建后仍不可用（${consoleState.reason}）`);
      add('console', { status: 'built' }, `${consoleState.dist}（${consoleState.reason}）`);
    } else {
      add('console', { status: 'reused' }, consoleState.dist);
    }

    let mcpState = inspectMcpState();
    if (!exists(mcpState.server)) {
      throw new CapabilityError('internal', `MCP 源入口不存在：${mcpState.server}`, { hint: '检查仓库是否完整，重新拉取 packages/mcp' });
    }
    if (!mcpState.ready || forceInstall) {
      log('构建自包含 MCP 插件入口…');
      const result = run(['build:plugin'], { cwd: MCP_ROOT, timeoutMs: 300_000 });
      if (result.status !== 0) {
        throw new CapabilityError('internal', 'MCP 插件入口构建失败', {
          details: { tail: processTail(result) },
          hint: '运行 pnpm -C packages/mcp build:plugin 查看完整日志',
        });
      }
      mcpState = inspectMcpState();
      if (!mcpState.ready) throw new CapabilityError('internal', `MCP 插件入口构建后仍缺失：${mcpState.missing.join('、')}`);
      add('mcp', { status: 'built' }, mcpState.artifact);
    } else {
      add('mcp', { status: 'reused' }, mcpState.artifact);
    }

    const engine = await ensureEngine({
      base, port, consoleDist: CONSOLE_DIST, log,
      probe: io.probeEngine, fetchImpl: io.fetch, spawnProcess: io.spawn, sleepImpl: io.sleep,
      available: io.portAvailable,
      state: Object.prototype.hasOwnProperty.call(io, 'readEngineState') ? io.readEngineState() : readEngineState(),
      env: io.env ?? process.env,
    });
    add('engine', { status: engine.status }, `${engine.base}（${engine.status === 'reused' ? '数据根一致，已复用' : '已启动'}）`);

    const requestedClients = list(options.clients);
    const connectedClients = [];
    const clientFailures = [];
    if (options.noConnect) {
      add('clients', { status: 'skipped' }, '本次没有改客户端配置');
    } else {
      const clientStates = (io.inspectClientConfigs ?? inspectClientConfigs)();
      const pluginManaged = requestedClients.length ? [] : clientStates.filter(client => client.pluginVersion);
      const detected = clientStates
        .filter(client => client.installed && !client.pluginVersion && AUTO_CLIENTS.has(client.client))
        .map(client => client.client);
      const targets = requestedClients.length ? requestedClients : detected;
      for (const client of pluginManaged) {
        connectedClients.push({ client: client.client, changed: false, engine: null, managedBy: 'plugin', version: client.pluginVersion });
      }
      if (!targets.length) {
        const detail = pluginManaged.length
          ? `${pluginManaged.map(client => `${CLIENTS[client.client].label} 插件 ${client.version}`).join('、')} 已安装`
          : '没检测到 Claude Code / Desktop / Cursor / VS Code / Codex';
        add('clients', { status: pluginManaged.length ? 'configured' : 'skipped' }, detail);
        if (!pluginManaged.length) warnings.push({ code: 'clients_not_detected', message: '没有检测到可自动连接的 AI 客户端；装好客户端后运行 heimdall setup 或 heimdall connect <client>' });
      } else {
        for (const client of targets) {
          if (!CLIENTS[client]) {
            clientFailures.push({ client, error: `未知客户端；可选 ${Object.keys(CLIENTS).join(' / ')}` });
            continue;
          }
          log(`连接 ${CLIENTS[client].label}…`);
          const result = await (io.connectClient ?? connectClient)([client, '--json', '--api', base]);
          if (result.ok) connectedClients.push({ client, changed: result.result?.changed === true, engine: result.result?.selfTest?.engine ?? null });
          else clientFailures.push({ client, error: result.error?.message ?? '连接失败' });
        }
        const detail = connectedClients.length
          ? connectedClients.map(c => c.managedBy === 'plugin'
            ? `${CLIENTS[c.client].label} 插件 ${c.version} 已安装`
            : `${CLIENTS[c.client].label} 已配置并通过 MCP 自测`).join('；')
          : '没有客户端配置成功';
        add('clients', { status: connectedClients.length ? 'configured' : 'failed' }, detail);
        for (const failure of clientFailures) warnings.push({ code: 'client_connect_failed', message: `${failure.client}：${failure.error}` });
      }
    }

    if (options.open) {
      try {
        await (io.openExternal ?? openExternal)(base);
        add('browser', { status: 'opened' }, base);
      } catch (error) {
        add('browser', { status: 'failed' }, `服务已就绪，但浏览器没打开：${String(error?.message ?? error).slice(0, 160)}`);
        warnings.push({ code: 'browser_open_failed', message: `手动打开 ${base}` });
      }
    } else {
      add('browser', { status: 'skipped' }, `未自动打开 ${base}`);
    }

    const fatalClientFailure = requestedClients.length > 0 && connectedClients.length === 0 && clientFailures.length > 0;
    if (fatalClientFailure) {
      return fail('internal', '指定的 AI 客户端没有连接成功', {
        details: { failures: clientFailures },
        result: { baseUrl: base, steps, clients: connectedClients },
        warnings,
        hint: '先运行 heimdall connect <client> --dry-run 看配置差异，再运行 heimdall doctor',
      });
    }

    const aiLine = connectedClients.length
      ? `AI 客户端：${connectedClients.map(c => c.managedBy === 'plugin'
        ? `${CLIENTS[c.client].label} 插件 ${c.version} 已安装`
        : `${CLIENTS[c.client].label} 已配置并自测`).join('；')}。`
      : options.noConnect ? 'AI 客户端：本次没有改配置。' : 'AI 客户端：没有自动连接，可运行 heimdall connect <client>。';
    return ok({
      baseUrl: base,
      apiStatus: `${base}/api/status`,
      engine,
      steps,
      clients: connectedClients,
      clientFailures,
      dataRoot: DATA_ROOT,
      note: 'MCP 是 AI 客户端与 Heimdall 之间的插头；克隆、QA、SEO 等服务仍需要本机 :' + port + ' 引擎。',
    }, {
      summary: `Heimdall 已就绪：${base}\n${aiLine}\n看到 engine_unreachable 时检查 ${base}/api/status，不要检查 :5173。`,
      nextActions: [
        nextAction('heimdall_doctor', null, '让 AI 读取同一套环境检查'),
        nextAction('heimdall_overview', null, '查看本机已有站点与任务'),
      ],
      warnings,
    });
  } catch (error) {
    const env = fromError(error);
    env.result = { ...(env.result ?? {}), baseUrl: base, steps, ...(error.details ? { details: error.details } : {}) };
    if (warnings.length) env.warnings = warnings;
    return env;
  }
}

function helpText() {
  return `Heimdall setup\n\n用法：heimdall ${SETUP_USAGE}\n\n`
    + '它按需完成：Node/pnpm 检查 → core/console/MCP 依赖 → Playwright Chromium → 控制台 → 自包含 MCP → 单端口引擎 → 客户端连接。\n'
    + '默认打开 http://127.0.0.1:8900；--no-connect 不改任何客户端配置，--force-install 强制重装依赖并重建 MCP。\n';
}

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({
        ok: true,
        result: {
          command: 'setup', usage: `heimdall ${SETUP_USAGE}`,
          flags: ['--registry URL', '--port 8900', '--no-open', '--no-connect', '--connect client[,client]', '--force-install', '--json'],
        },
        summary: '安装、启动与 AI 客户端接入。',
        nextActions: [], evidence: [],
      }) + '\n');
    } else process.stdout.write(helpText());
    return 0;
  }
  if (positional.length) {
    const env = fail('invalid_args', `setup 不接受位置参数：${positional.join(' ')}`, { hint: `用法：heimdall ${SETUP_USAGE}` });
    process.stdout.write((flags.json ? JSON.stringify(env) : `${env.summary}\n${env.error.hint}`) + '\n');
    return exitCodeOf(env);
  }

  const env = await executeSetup({
    registry: flags.registry,
    port: flags.port,
    noConnect: flags['no-connect'] === true,
    clients: flags.connect,
    forceInstall: flags['force-install'] === true,
    open: flags['no-open'] !== true,
  });
  if (flags.json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    for (const step of env.result?.steps ?? []) process.stdout.write(`  ${step.id.padEnd(12)} ${step.detail}\n`);
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
    for (const warning of env.warnings ?? []) process.stdout.write(`! ${warning.message}\n`);
  }
  return exitCodeOf(env);
}
