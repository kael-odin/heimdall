/**
 * heimdall qa —— 测试工作区命令组
 *
 *   qa init [--project 名称] [--url URL]     在当前目录建 .heimdall/qa.json 模板
 *   qa login <登录档>                         打开有界面的浏览器，人工登录一次，保存 storageState
 *   qa status                                 站点、登录档、最近运行、测试须知
 *   qa run [站点] [--pages /a,/b] [--viewports 1440,390] [--checks 文件] [--no-links] [--texts] [--explore]
 *   qa baseline [--run ID] [--off]            把某次运行登记为跨运行视觉基线 / 清除基线
 *   qa findings [--status fileable|new|suppressed|known-bug|all] [--run ID]
 *   qa show <F编号>    qa similar "问题标题"    qa submit <文件.json>
 *   qa verdict <F编号> <裁决> "理由" [--pattern] [--until 日期] [--reopen-if 条件]
 *   qa revoke <规则编号>    qa rules
 *
 * status / run / findings 系列是注册表能力（MCP、HTTP 同样可用）；init 和 login 要人在场，只在 CLI。
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { runAgentCommand, parseArgs, argsFor } from '../cli.mjs';
import { runQaCi } from '../../qa/ci.mjs';
import { CONFIG_DIR, CONFIG_FILE, QA_SCHEMA, inWorkspace } from '../../qa/workspace.mjs';
import { openWorkspace, readRun } from '../../qa/run.mjs';
import { writeBaseline, clearBaseline } from '../../qa/baseline.mjs';
import { BROWSER_PROFILE } from '../../qa/probe.mjs';

const USAGE = `heimdall qa <子命令>

  init [--project 名称] [--url URL]   在当前目录建 .heimdall/qa.json
  login <登录档> [--allow-insecure-http]  人工登录一次，保存登录态
  status                              站点、登录档、最近运行、测试须知
  run [站点] [--pages /a,/b] [--viewports 1440,390] [--checks 文件] [--no-links] [--texts] [--explore] [--no-baseline]
      --explore                       显式开启交互探索：每页点最多 6 个控件，找「点了没反应 / 点出异常 / 点出 404」
  ci [站点] [--fail-on all|wall|degrade|none] [--max-findings N] [--require-baseline] [--github|--no-github]
      在 CI 中运行同一套只读 QA，写 qa-ci.json / qa-ci.md，并输出 GitHub Actions 注解
  baseline [--run ID] [--off]         把某次运行登记为跨运行视觉基线；--off 清除
  findings [--status all] [--run ID]  列出发现（默认只列建议提单的）
  show <F编号>                        一条发现的全部证据
  similar "标题"                      在台账和以往运行里查相似问题
  submit <文件.json>                  提交自己测出的问题（{ "findings": [...] }）
  verdict <F编号> <裁决> "理由" [--pattern] [--until YYYY-MM-DD] [--reopen-if 条件]
      裁决：bug 真问题 · false-positive 误报 · convention 团队约定 · deferred 暂缓
            by-design 设计如此 · wont-fix 不修 · env 环境问题
  revoke <规则编号>                   撤销一条裁决规则
  rules                               列出裁决规则

通用：--workspace 目录（默认从当前目录向上找 .heimdall/qa.json）  --json`;

const passthrough = (flags, keys) => keys.flatMap(k => (flags[k] === undefined ? [] : flags[k] === true ? [`--${k}`] : [`--${k}`, String(flags[k])]));
const COMMON = ['workspace', 'json', 'quiet'];

function template({ project, url }) {
  const origin = (() => { try { return new URL(url).origin; } catch { return 'https://example.com'; } })();
  return {
    schema: QA_SCHEMA,
    project,
    sites: {
      web: { label: '官网', url: url || 'https://example.com/', environment: 'production', pages: ['/'], login: null, writes: 'block' },
    },
    logins: {
      user: { kind: 'storageState', file: '.heimdall/logins/user.json', origin },
    },
    conventions: [
      { id: 'example', text: '示例：【】是作者的强调写法，不算格式问题', match: { kind: 'agent', text: '【】' } },
    ],
    ledger: { file: null },
    knowledge: { prd: [], notes: [] },
    defaults: { viewport: { width: 1440, height: 900 }, settleMs: 1500, timeoutMs: 30000 },
  };
}

async function init(flags) {
  const root = resolve(String(flags.dir ?? process.env.HEIMDALL_INVOKE_CWD ?? process.cwd()));
  const dir = join(root, CONFIG_DIR);
  const file = join(dir, CONFIG_FILE);
  if (existsSync(file) && !flags.force) {
    process.stderr.write(`已存在 ${file}；要覆盖加 --force\n`);
    return 2;
  }
  mkdirSync(join(dir, 'logins'), { recursive: true });
  const project = String(flags.project ?? root.split(/[/\\]/).at(-1));
  writeFileSync(file, JSON.stringify(template({ project, url: flags.url }), null, 2) + '\n');
  writeFileSync(join(dir, '.gitignore'), '# 登录态等同账号；运行记录里有登录后页面的截图\nlogins/\nqa/runs/\n');
  process.stdout.write(`已创建 ${file}\n下一步：改 sites 里的地址和页面；需要登录的站点配一个登录档，再运行 heimdall qa login <登录档>\n`);
  return 0;
}

function loginFileFingerprint(file) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('登录态路径不是普通文件');
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function loginUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function insecureRemote(url) {
  return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function readLoginConfirmation(input, browser, context) {
  return new Promise(done => {
    const rl = createInterface({ input });
    const pages = new Set();
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      browser.off('disconnected', cancelled);
      context.off('page', watchPage);
      for (const page of pages) page.off('close', pageClosed);
      rl.close();
      done(value);
    };
    const cancelled = () => finish(null);
    const pageClosed = () => { if (!context.pages().some(page => !page.isClosed())) cancelled(); };
    const watchPage = page => { pages.add(page); page.once('close', pageClosed); };
    rl.once('line', line => finish(line));
    rl.once('close', cancelled);
    rl.once('SIGINT', cancelled);
    browser.once('disconnected', cancelled);
    context.on('page', watchPage);
    for (const page of context.pages()) watchPage(page);
    if (input.readableEnded || input.destroyed || !browser.isConnected()) cancelled();
    else pageClosed();
  });
}

export async function login(name, flags, io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  if (!name) { err.write('用法：heimdall qa login <登录档>\n'); return 2; }
  const ws = openWorkspace(flags.workspace);
  const profile = ws.logins[name];
  if (!profile) { err.write(`qa.json 里没有登录档 ${name}；有：${Object.keys(ws.logins).join('、') || '（无）'}\n`); return 2; }
  if (profile.kind !== 'storageState') {
    err.write(`登录档 ${name} 是 ${profile.kind}，值来自配置里写的环境变量或文件，不需要人工登录\n`);
    return 0;
  }
  const site = Object.values(ws.sites).find(s => s.login === name);
  const startUrl = flags.url ? String(flags.url) : site ? new URL(site.loginPath ?? '/', site.url).href : profile.origin;
  if (!startUrl) { err.write(`不知道从哪里登录：给登录档 ${name} 写 origin，或加 --url\n`); return 2; }
  const start = loginUrl(startUrl);
  if (!start) { err.write('登录地址必须是 http(s)，且不能包含账号密码。\n'); return 2; }
  if (insecureRemote(start) && flags['allow-insecure-http'] !== true) {
    err.write('登录入口使用未加密的 HTTP，未打开浏览器。请优先使用可信 HTTPS；确认风险后可加 --allow-insecure-http。\n');
    return 2;
  }
  if (start.protocol === 'http:') err.write('注意：HTTP 不加密，后续跳转和表单提交也需要自行确认安全。\n');
  const file = inWorkspace(ws, profile.file);
  const initial = loginFileFingerprint(file);
  const chromium = io.chromium ?? (await import('playwright')).chromium;
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ ...BROWSER_PROFILE, viewport: null });
    const page = await context.newPage();
    let response;
    try { response = await page.goto(start.href, { waitUntil: 'domcontentloaded' }); }
    catch { err.write('无法打开登录页，未保存登录态。请检查地址、网络和证书。\n'); return 3; }
    if (!response || response.status() >= 400) {
      err.write('登录页没有成功加载，未保存登录态。请检查地址、网络和站点状态。\n');
      return 3;
    }
    const landed = loginUrl(page.url());
    if (!landed || (insecureRemote(landed) && flags['allow-insecure-http'] !== true)) {
      err.write('登录页跳转到不受支持或未加密的地址，未保存登录态；跳转请求可能已经发出。\n');
      return 3;
    }
    out.write(`已打开登录页（${start.origin}）。在浏览器里完成登录。\n`);
    out.write(initial === null
      ? '确认已登录后回到终端按回车保存；输入其他内容取消。\n'
      : '此登录档已有文件。确认已登录后输入 REPLACE 并回车替换；其他输入取消。\n');
    const answer = await readLoginConfirmation(io.stdin ?? process.stdin, browser, context);
    if (answer === null || (initial === null ? answer.trim() !== '' : answer.trim() !== 'REPLACE')) {
      err.write('已取消，原登录态未修改。\n');
      return 2;
    }
    const openPages = context.pages().filter(current => !current.isClosed());
    if (!browser.isConnected() || !openPages.length) { err.write('浏览器已关闭，未保存登录态。\n'); return 3; }
    const locations = openPages.map(current => loginUrl(current.url()));
    if (locations.some(current => !current || (insecureRemote(current) && flags['allow-insecure-http'] !== true))) {
      err.write('打开的页面包含不允许的登录地址，未保存登录态；页面请求可能已经发出。\n');
      return 3;
    }
    const state = await context.storageState();
    if (loginFileFingerprint(file) !== initial) { err.write('登录档在等待期间已变化，未覆盖。\n'); return 3; }
    mkdirSync(dirname(file), { recursive: true });
    const temporary = join(dirname(file), `.${basename(file)}.${(io.randomUUID ?? randomUUID)()}.tmp`);
    let created = false, identity = null;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      created = true;
      try {
        const stat = fstatSync(fd);
        identity = { dev: stat.dev, ino: stat.ino };
        writeFileSync(fd, JSON.stringify(state, null, 2) + '\n');
      } finally { closeSync(fd); }
      if (loginFileFingerprint(file) !== initial) { err.write('登录档在保存期间已变化，未覆盖。\n'); return 3; }
      if (initial === null) linkSync(temporary, file);
      else renameSync(temporary, file);
    } finally {
      if (created) {
        try {
          const stat = lstatSync(temporary);
          if (identity?.ino && stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino) unlinkSync(temporary);
          else err.write(`无法确认临时文件归属，未清除：${temporary}\n`);
        } catch (error) { if (error.code !== 'ENOENT') err.write(`无法清除临时登录态文件：${temporary}\n`); }
      }
    }
    out.write(`登录态已保存到 ${profile.file}；是否仍有业务权限需要另行验证，不要提交到仓库。\n`);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 把一次运行登记为跨运行视觉基线；之后每次 qa run 都会与它比对同页同视口截图。 */
async function baseline(flags) {
  const ws = openWorkspace(flags.workspace);
  if (flags.off) {
    clearBaseline(ws);
    process.stdout.write('已清除跨运行视觉基线。\n');
    return 0;
  }
  const { run } = readRun(ws, flags.run);
  const result = writeBaseline(ws, run, run.coverage.pages);
  process.stdout.write(`已把 ${run.runId} 登记为基线：${result.pages.length} 个页面/视口截图。\n`);
  return 0;
}

async function ci(flags, positional) {
  const args = argsFor('qa_run', { flags, positional });
  const github = flags.github === true || (process.env.GITHUB_ACTIONS === 'true' && flags['no-github'] !== true);
  const maxFindings = Number(flags['max-findings'] ?? 0);
  if (!Number.isInteger(maxFindings) || maxFindings < 0) {
    process.stderr.write('--max-findings 必须是非负整数\n');
    return 2;
  }
  const result = await runQaCi({
    args,
    failOn: String(flags['fail-on'] ?? 'all'),
    maxFindings,
    requireBaseline: flags['require-baseline'] === true,
    github,
    onProgress: p => process.stderr.write(`… ${p.message ?? p.stage ?? 'progress'}\n`),
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify(result.env) + '\n');
  } else {
    process.stdout.write(result.env.summary + '\n');
    if (!result.env.ok) process.stdout.write(`[${result.env.error.code}] ${result.env.error.message}\n下一步：${result.env.error.hint}\n`);
    if (github && result.annotations) process.stdout.write(result.annotations + '\n');
  }
  return result.exitCode;
}

export async function run(argv) {  const sub = argv[0];
  const rest = argv.slice(1);
  const { flags, positional } = parseArgs(rest);
  if (!sub || sub === 'help' || sub === '--help') { process.stdout.write(USAGE + '\n'); return sub ? 0 : 2; }
  try {
    switch (sub) {
      case 'init': return await init(flags);
      case 'login': return await login(positional[0], flags);
      case 'status': return runAgentCommand('qa_status', passthrough(flags, COMMON));
      case 'run': return runAgentCommand('qa_run', [...positional.slice(0, 1).flatMap(s => ['--site', s]), ...passthrough(flags, [...COMMON, 'site', 'pages', 'viewports', 'checks', 'no-links', 'texts', 'login', 'label', 'link-limit', 'explore', 'no-baseline', 'no-detect', 'explore-max', 'explore-budget'])]);
      case 'ci': return await ci(flags, positional);
      case 'baseline': return await baseline(flags);;
      case 'findings': case 'list': return runAgentCommand('qa_findings', ['--action', 'list', ...passthrough(flags, [...COMMON, 'status', 'run', 'limit'])]);
      case 'show': return runAgentCommand('qa_findings', ['--action', 'show', '--id', String(positional[0] ?? ''), ...passthrough(flags, [...COMMON, 'run'])]);
      case 'similar': return runAgentCommand('qa_findings', ['--action', 'similar', '--title', positional.join(' '), ...passthrough(flags, [...COMMON, 'path', 'limit'])]);
      case 'submit': return runAgentCommand('qa_findings', ['--action', 'submit', '--file', String(positional[0] ?? flags.file ?? ''), ...passthrough(flags, [...COMMON, 'run'])]);
      case 'verdict': {
        const [id, verdict, ...why] = positional;
        return runAgentCommand('qa_findings', ['--action', 'verdict', ...(id ? ['--id', id] : []), ...(verdict ? ['--verdict', verdict] : []), ...(why.length ? ['--reason', why.join(' ')] : []),
          ...passthrough(flags, [...COMMON, 'run', 'pattern', 'until', 'reopen-if', 'reason'])]);
      }
      case 'revoke': return runAgentCommand('qa_findings', ['--action', 'revoke', '--rule-id', String(positional[0] ?? ''), ...passthrough(flags, [...COMMON, 'run', 'reason'])]);
      case 'rules': return runAgentCommand('qa_findings', ['--action', 'rules', ...passthrough(flags, COMMON)]);
      default:
        process.stderr.write(`未知子命令：${sub}\n\n${USAGE}\n`);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return e.code === 'not_found' || e.code === 'invalid_args' ? 2 : 7;
  }
}
