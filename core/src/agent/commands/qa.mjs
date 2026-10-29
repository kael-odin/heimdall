/**
 * heimdall qa —— 测试工作区命令组
 *
 *   qa init [--project 名称] [--url URL]     在当前目录建 .heimdall/qa.json 模板
 *   qa login <登录档>                         打开有界面的浏览器，人工登录一次，保存 storageState
 *   qa status                                 站点、登录档、最近运行、测试须知
 *   qa run [站点] [--pages /a,/b] [--viewports 1440,390] [--checks 文件] [--no-links] [--texts]
 *   qa findings [--status fileable|new|suppressed|known-bug|all] [--run ID]
 *   qa show <F编号>    qa similar "问题标题"    qa submit <文件.json>
 *   qa verdict <F编号> <裁决> "理由" [--pattern] [--until 日期] [--reopen-if 条件]
 *   qa revoke <规则编号>    qa rules
 *
 * status / run / findings 系列是注册表能力（MCP、HTTP 同样可用）；init 和 login 要人在场，只在 CLI。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { runAgentCommand, parseArgs } from '../cli.mjs';
import { CONFIG_DIR, CONFIG_FILE, QA_SCHEMA, inWorkspace } from '../../qa/workspace.mjs';
import { openWorkspace } from '../../qa/run.mjs';
import { BROWSER_PROFILE } from '../../qa/probe.mjs';

const USAGE = `heimdall qa <子命令>

  init [--project 名称] [--url URL]   在当前目录建 .heimdall/qa.json
  login <登录档>                      人工登录一次，保存登录态
  status                              站点、登录档、最近运行、测试须知
  run [站点] [--pages /a,/b] [--viewports 1440,390] [--checks 文件] [--no-links] [--texts]
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

async function login(name, flags) {
  if (!name) { process.stderr.write('用法：heimdall qa login <登录档>\n'); return 2; }
  const ws = openWorkspace(flags.workspace);
  const profile = ws.logins[name];
  if (!profile) { process.stderr.write(`qa.json 里没有登录档 ${name}；有：${Object.keys(ws.logins).join('、') || '（无）'}\n`); return 2; }
  if (profile.kind !== 'storageState') {
    process.stderr.write(`登录档 ${name} 是 ${profile.kind}，值来自配置里写的环境变量或文件，不需要人工登录\n`);
    return 0;
  }
  const site = Object.values(ws.sites).find(s => s.login === name);
  const startUrl = flags.url ? String(flags.url) : site ? new URL(site.loginPath ?? '/', site.url).href : profile.origin;
  if (!startUrl) { process.stderr.write(`不知道从哪里登录：给登录档 ${name} 写 origin，或加 --url\n`); return 2; }
  const file = inWorkspace(ws, profile.file);
  mkdirSync(resolve(file, '..'), { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ ...BROWSER_PROFILE, viewport: null, ...(existsSync(file) ? { storageState: file } : {}) });
    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    process.stdout.write(`已打开 ${startUrl}\n在浏览器里登录（验证码、扫码都可以），登录成功、能看到登录后的页面后，回到这里按回车保存。\n`);
    await new Promise((done) => { const rl = createInterface({ input: process.stdin }); rl.once('line', () => { rl.close(); done(); }); });
    await context.storageState({ path: file });
    process.stdout.write(`登录态已保存到 ${profile.file}（不要提交到仓库，.heimdall/.gitignore 已忽略 logins/）\n`);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function run(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { flags, positional } = parseArgs(rest);
  if (!sub || sub === 'help' || sub === '--help') { process.stdout.write(USAGE + '\n'); return sub ? 0 : 2; }
  try {
    switch (sub) {
      case 'init': return await init(flags);
      case 'login': return await login(positional[0], flags);
      case 'status': return runAgentCommand('qa_status', passthrough(flags, COMMON));
      case 'run': return runAgentCommand('qa_run', [...positional.slice(0, 1).flatMap(s => ['--site', s]), ...passthrough(flags, [...COMMON, 'site', 'pages', 'viewports', 'checks', 'no-links', 'texts', 'login', 'label', 'link-limit'])]);
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
