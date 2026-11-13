/**
 * qa：工作区配置、登录档、指纹、裁决记忆、证据门槛、台账查重（纯函数，不开浏览器）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspace, findWorkspace, resolveLogin, describeLogin, scrubSecrets, scrubValues, jwtExpiry } from '../src/qa/workspace.mjs';
import { fingerprintOf, normalizeFinding, stablePath, stableText } from '../src/qa/findings.mjs';
import { recordVerdict, readRules, revokeVerdict, applyVerdicts, normalizeMatch } from '../src/qa/memory.mjs';
import { dice, findSimilar, guidance, readLedger } from '../src/qa/ledger.mjs';
import { renderReport } from '../src/qa/report.mjs';
import { invoke } from '../src/agent/registry/invoke.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeJwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${b64(payload)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;

function workspace(config, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify(config));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

test('workspace: found upward, validated, logins resolved without leaking values', () => {
  const token = fakeJwt({ user_id: 7, username: 'tester', permissions: ['a', 'b'], exp: 4102444800 });
  const root = workspace({
    project: 'Demo',
    sites: { admin: { url: 'http://127.0.0.1:1/admin/', login: 'admin', pages: ['/admin/', { path: '/admin/users', name: '用户' }], environment: 'test' } },
    logins: {
      admin: { kind: 'localStorage', origin: 'http://127.0.0.1:1', items: { _token: { fromFile: 'keys.md', match: 'jwt', section: '## 后台' } },
        jwtClaims: { _user_info: { from: '_token', pick: ['user_id', 'username'] }, _permission: { from: '_token', claim: 'permissions' } } },
      api: { kind: 'headers', headers: { Authorization: { env: 'DEMO_TOKEN' } } },
      web: { kind: 'storageState', file: '.heimdall/logins/web.json' },
    },
    conventions: ['【】是强调写法', { id: 'policy', text: '政策页不查', match: { pathPrefix: '/policy' } }],
  }, { 'keys.md': `# keys\n## 前台\neyJxxxxxxxxxxxx.yyyyyyyyyyyy.zzzzzz\n## 后台\nJWT: ${token}\n` });
  try {
    mkdirSync(join(root, 'sub', 'deeper'), { recursive: true });
    assert.equal(findWorkspace(join(root, 'sub', 'deeper')).root, root);
    const ws = loadWorkspace(join(root, 'sub'));
    assert.equal(ws.project, 'Demo');
    assert.equal(ws.sites.admin.origin, 'http://127.0.0.1:1');
    assert.deepEqual(ws.sites.admin.pages.map(p => p.path), ['/admin/', '/admin/users']);
    assert.equal(ws.conventions.length, 2);

    const rules = [{ method: 'POST', origin: 'http://x', path: '/api/get/' },
      { method: 'POST', origin: 'https://api.example.test:8443', path: '/api/getList' }];
    const allowRoot = workspace({ sites: { a: { url: 'http://x/', writes: { allow: rules } } } });
    try {
      const allowWs = loadWorkspace(allowRoot);
      assert.deepEqual(allowWs.sites.a.writeAllow, rules, 'the origin and exact trailing slash are retained');
      assert.equal(allowWs.sites.a.writes, 'block');
    } finally { rmSync(allowRoot, { recursive: true, force: true }); }

    const admin = resolveLogin(ws, 'admin');
    const items = Object.fromEntries(admin.storage[0].items);
    assert.equal(items._token, token, 'JWT picked from the named section, not the first one in the file');
    assert.deepEqual(JSON.parse(items._user_info), { user_id: 7, username: 'tester' });
    assert.deepEqual(JSON.parse(items._permission), ['a', 'b']);
    assert.equal(admin.expiresAt, '2100-01-01T00:00:00.000Z');
    assert.ok(admin.secrets.includes(token));
    assert.ok(!JSON.stringify(describeLogin(ws, 'admin')).includes(token), 'describe never contains values');

    assert.throws(() => resolveLogin(ws, 'api', {}), /DEMO_TOKEN/);
    assert.equal(resolveLogin(ws, 'api', { DEMO_TOKEN: 'Bearer abcdefghijklmnop' }).contextOptions.extraHTTPHeaders.Authorization, 'Bearer abcdefghijklmnop');
    assert.throws(() => resolveLogin(ws, 'web'), (e) => e.code === 'login_missing' && /qa login web/.test(e.message));
    assert.equal(scrubSecrets(`token=${token}`, admin.secrets), 'token=[凭据已移除]');
    assert.equal(jwtExpiry('not-a-jwt'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace: known Bearer credentials redact both headers and bare tokens', () => {
  const token = 'fixture-bearer-token-value';
  for (const header of [`Bearer ${token}`, `bearer ${token}`, `  BEARER\t${token}  `]) {
    assert.equal(scrubSecrets(`header=${header}; token=${token}; again=${token}`, [header]),
      'header=[凭据已移除]; token=[凭据已移除]; again=[凭据已移除]');
    assert.deepEqual(scrubValues({ [token]: [token] }, [header]), { '[凭据已移除]': ['[凭据已移除]'] });
  }
  assert.equal(scrubSecrets('unknown-token-value', [`Bearer ${token}`]), 'unknown-token-value');
  assert.equal(scrubSecrets('tiny', ['Bearer tiny']), 'tiny', 'short fragments keep the existing length guard');
  assert.equal(scrubSecrets(token, [`Basic ${token}`]), token, 'unrelated credential schemes are not decoded');
});

test('workspace: bad configs are rejected with a readable reason', () => {
  for (const [config, pattern] of [
    [{ sites: {} }, /至少声明一个站点/],
    [{ sites: { a: { url: 'ftp://x' } } }, /http\(s\)/],
    [{ sites: { a: { url: 'http://u:p@x/' } } }, /账号密码/],
    [{ sites: { a: { url: 'http://x/', login: 'nope' } } }, /不存在的登录档/],
    [{ sites: { a: { url: 'http://x/', pages: ['//evil.test/'] } } }, /以 \/ 开头/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: [] } } } }, /1 到 40 条/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: ['/api/x'] } } } }, /不再支持路径前缀/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: [{ method: 'DELETE', origin: 'http://x', path: '/api/x' }] } } } }, /只能是 POST/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: [{ method: 'POST', path: '/api/x' }] } } } }, /完整来源/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: [{ method: 'POST', origin: 'http://x/api', path: '/api/x' }] } } } }, /协议、主机和端口/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: [{ method: 'POST', origin: 'http://x?token=x', path: '/api/x' }] } } } }, /协议、主机和端口/],
    ...['//api/x', '/api/x?foo=1', '/api/x#fragment', '/api/%2fdelete', '/api/../x', '/api\\delete', '/api/x y'].map(path =>
      [{ sites: { a: { url: 'http://x/', writes: { allow: [{ method: 'POST', origin: 'http://x', path }] } } } }, /精确路径/]),
    [{ sites: { a: { url: 'http://x/', writes: { allow: [{ method: 'POST', origin: 'http://x', path: '/api/x', prefix: true }] } } } }, /只包含/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: Array(41).fill({ method: 'POST', origin: 'http://x', path: '/api/x' }) } } } }, /1 到 40 条/],
    [{ sites: { a: { url: 'http://x/', writes: 3 } } }, /block \/ allow/],
    [{ sites: { a: { url: 'http://x/' } }, logins: { b: { kind: 'script', code: 'alert(1)' } } }, /kind 只能是/],
  ]) {
    const root = workspace(config);
    try { assert.throws(() => loadWorkspace(root), pattern); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('workspace: declared coverage and login checks are never silently truncated', () => {
  const entries = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, 'fixture']));
  const claims = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`claim${i}`, { from: 'token', claim: 'sub' }]));
  const invalid = [
    [{ sites: { web: { url: 'http://x/', pages: Array(41).fill('/') } } }, /40/],
    [{ sites: { web: { url: 'http://x/', pages: '/' } } }, /pages/],
    [{ sites: { web: { url: 'http://x/', pages: ['/\\other.test/'] } } }, /同源/],
    [{ sites: { web: { url: 'http://x/', loggedOutText: Array(11).fill('expired') } } }, /10/],
    [{ sites: { web: { url: 'http://x/' } }, conventions: Array(201).fill('rule') }, /200/],
    [{ sites: { web: { url: 'http://x/' } }, logins: { user: { kind: 'localStorage', origin: 'http://x', items: entries(41) } } }, /40/],
    [{ sites: { web: { url: 'http://x/' } }, logins: { user: { kind: 'headers', headers: entries(21) } } }, /20/],
    [{ sites: { web: { url: 'http://x/' } }, logins: { user: { kind: 'localStorage', origin: 'http://x', items: entries(1), jwtClaims: claims(21) } } }, /20/],
    [{ sites: { web: { url: 'http://x/' } }, logins: { user: { kind: 'localStorage', origin: 'http://x', items: entries(1), jwtClaims: { info: { from: 'token', pick: Array(31).fill('sub') } } } } }, /30/],
  ];
  for (const [config, pattern] of invalid) {
    const root = workspace(config);
    try { assert.throws(() => loadWorkspace(root), pattern); } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const root = workspace({ sites: { web: { url: 'http://x/', pages: Array(40).fill('/'), loggedOutText: Array(10).fill('expired') } },
    conventions: Array(200).fill('rule'), logins: { user: { kind: 'localStorage', origin: 'http://x', items: entries(40) } } });
  try {
    const ws = loadWorkspace(root);
    assert.equal(ws.sites.web.pages.length, 40);
    assert.equal(ws.sites.web.loggedOutText.length, 10);
    assert.equal(ws.logins.user.items.length, 40);
    assert.equal(ws.conventions.length, 200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reports describe the actual request policy without promising read-only behavior', () => {
  const base = { runId: 'qa-fixture', site: 'web', siteUrl: 'http://x', environment: 'test', startedAt: '2026-01-01T00:00:00Z',
    login: null, summary: { suppressed: 0, knownBug: 0 }, coverage: { viewports: [], pages: [], checks: [] } };
  const report = policy => renderReport({ ws: { project: 'fixture' }, run: { ...base, ...(policy ? { requestPolicy: policy } : {}) }, findings: [], hits: [] });
  assert.match(report({ mode: 'block', allowedQueries: [] }), /0 条精确 POST 例外/);
  assert.match(report({ mode: 'block', allowedQueries: [{}] }), /1 条精确 POST 例外/);
  assert.match(report({ mode: 'allow', allowedQueries: [] }), /放行所有 HTTP 方法，可能修改数据/);
  assert.match(report(null), /历史运行未记录请求策略/);
  assert.doesNotMatch(report({ mode: 'block', allowedQueries: [] }), /拦下了所有写请求/);
});

test('legacy allowlists fail closed in MCP and CLI with a migration hint and no edits', async () => {
  const root = workspace({ sites: { web: { url: 'http://x/', writes: { allow: ['/api/query'] } } } });
  const file = join(root, '.heimdall', 'qa.json');
  try {
    const before = readFileSync(file, 'utf8');
    const mcp = await invoke('qa_status', { workspace: root, guidance: false }, { client: 'mcp' });
    assert.equal(mcp.error.code, 'invalid_args');
    assert.match(mcp.error.message, /不再支持路径前缀/);
    assert.match(mcp.error.hint, /保留原工作区/);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
      'qa', 'status', '--workspace', root, '--json'], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(cli.status, 0);
    const envelope = JSON.parse(cli.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(envelope.error.code, 'invalid_args');
    assert.match(envelope.error.hint, /保留原工作区/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findings: fingerprint ignores numbers, hashes and queries; evidence gate', () => {
  assert.equal(stablePath('/orders/12345/detail?x=1#a'), '/orders/:n/detail');
  assert.equal(stableText('HTTP 500 https://a.test/api/x?t=9 at 12:30'), 'http # https://a.test/api/x at #');
  const a = fingerprintOf({ site: 's', path: '/p/1', kind: 'network', target: 'https://a.test/api?x=1', text: '返回 500，耗时 31ms' });
  const b = fingerprintOf({ site: 's', path: '/p/2', kind: 'network', target: 'https://a.test/api?x=2', text: '返回 500，耗时 87ms' });
  assert.equal(a, b);

  const spec = normalizeFinding({ title: '复制按钮点了没反应', basis: 'failed', tier: 'wall', loss: '用户可能复制不了', evidence: { observed: 'x' } }, { site: 's', source: 'agent' });
  assert.ok(spec.problems.some(p => /推测词/.test(p)));
  const cos = normalizeFinding({ title: '按钮文案多了空格', basis: 'cosmetic', tier: 'degrade', loss: '看着别扭', evidence: { observed: 'x' } }, { source: 'agent' });
  assert.equal(cos.finding.tier, 'tolerable');
  const noLoss = normalizeFinding({ title: '保存失败', basis: 'failed', tier: 'wall', evidence: { observed: '点保存后提示 500' } }, { source: 'agent' });
  assert.equal(noLoss.finding.tier, 'tolerable');
  const noEvidence = normalizeFinding({ title: '感觉加载慢', basis: 'friction' }, { source: 'agent' });
  assert.ok(noEvidence.problems.some(p => /缺证据/.test(p)));
});

test('memory: exact and pattern rules, specificity, deferral expiry, revoke', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-qa-mem-'));
  try {
    const f1 = { fingerprint: 'fp_aaaaaaaaaaaa', site: 'web', path: '/pricing', kind: 'agent', title: '套餐名用了【】括号', target: null };
    const f2 = { fingerprint: 'fp_bbbbbbbbbbbb', site: 'web', path: '/policy/privacy', kind: 'broken-link', title: '链接打不开', target: '/x' };
    const f3 = { fingerprint: 'fp_cccccccccccc', site: 'web', path: '/', kind: 'network', title: '接口返回 500', target: '/api/a' };
    assert.throws(() => normalizeMatch({ site: 'web' }), /吞掉整个站点/);
    recordVerdict(dir, { verdict: 'convention', reason: '【】是强调写法', match: { kind: 'agent', text: '【】' } });
    recordVerdict(dir, { verdict: 'deferred', reason: '下个版本再说', match: { pathPrefix: '/policy' }, until: '2000-01-01' });
    const bug = recordVerdict(dir, { verdict: 'bug', reason: '已提单 #12', match: { fingerprint: f3.fingerprint } });
    const fp = recordVerdict(dir, { verdict: 'false-positive', reason: '本地网络', match: { kind: 'network' } });
    const t = applyVerdicts([f1, f2, f3], readRules(dir));
    assert.equal(t[0].triage.status, 'suppressed');
    assert.equal(t[1].triage.status, 'reopened', 'deferral past its date reopens');
    assert.equal(t[2].triage.status, 'known-bug', 'exact rule beats the broader false-positive rule');
    revokeVerdict(dir, bug.id, 'oops');
    assert.equal(applyVerdicts([f3], readRules(dir))[0].triage.rule, fp.id);
    assert.throws(() => recordVerdict(dir, { verdict: 'bug', reason: '', match: { kind: 'x' } }), /理由/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: similar search and lessons from an existing issue ledger', () => {
  const root = workspace({ sites: { web: { url: 'http://x/' } }, ledger: { file: 'issues.json' } }, {
    'issues.json': { issues: [
      { id: 'O22', title: '三处「联系客户经理」是纯文字,没做成链接', status: 'closed', close_reason: '复核后不成立:页脚有企业邮箱' },
      { id: 'H7', title: '导航「使用场景/资源」在产品页和定价页点了没反应', status: 'open', where: '页头导航' },
      { id: 'A1', title: '审计日志缺失', status: 'accepted', accepted_reason: '下季度', reopen_if: '上合规' },
    ] },
  });
  try {
    const ws = loadWorkspace(root);
    assert.equal(readLedger(ws).length, 3);
    assert.ok(dice('导航使用场景点了没反应', '导航「使用场景/资源」在产品页和定价页点了没反应') > 0.4);
    const hits = findSimilar(ws, { title: '定价页导航的使用场景点击无反应' });
    assert.equal(hits[0].id, 'H7');
    const g = guidance(ws);
    assert.deepEqual(g.lessons.map(l => l.id), ['O22', 'A1']);
    assert.ok(g.triageRules.some(r => /element\.click/.test(r)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
