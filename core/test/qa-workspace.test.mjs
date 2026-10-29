/**
 * qa：工作区配置、登录档、指纹、裁决记忆、证据门槛、台账查重（纯函数，不开浏览器）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspace, findWorkspace, resolveLogin, describeLogin, scrubSecrets, jwtExpiry } from '../src/qa/workspace.mjs';
import { fingerprintOf, normalizeFinding, stablePath, stableText } from '../src/qa/findings.mjs';
import { recordVerdict, readRules, revokeVerdict, applyVerdicts, normalizeMatch } from '../src/qa/memory.mjs';
import { dice, findSimilar, guidance, readLedger } from '../src/qa/ledger.mjs';

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

    const allowRoot = workspace({ sites: { a: { url: 'http://x/', writes: { allow: ['/api/get/', '/api/getList'] } } } });
    try {
      const allowWs = loadWorkspace(allowRoot);
      assert.deepEqual(allowWs.sites.a.writeAllow, ['/api/get', '/api/getList'], 'writes.allow prefixes normalize (trailing slash dropped)');
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

test('workspace: bad configs are rejected with a readable reason', () => {
  for (const [config, pattern] of [
    [{ sites: {} }, /至少声明一个站点/],
    [{ sites: { a: { url: 'ftp://x' } } }, /http\(s\)/],
    [{ sites: { a: { url: 'http://u:p@x/' } } }, /账号密码/],
    [{ sites: { a: { url: 'http://x/', login: 'nope' } } }, /不存在的登录档/],
    [{ sites: { a: { url: 'http://x/', pages: ['//evil.test/'] } } }, /以 \/ 开头/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: [] } } } }, /非空路径数组/],
    [{ sites: { a: { url: 'http://x/', writes: { allow: ['api/x'] } } } }, /以 \/ 开头/],
    [{ sites: { a: { url: 'http://x/', writes: 3 } } }, /block \/ allow/],
    [{ sites: { a: { url: 'http://x/' } }, logins: { b: { kind: 'script', code: 'alert(1)' } } }, /kind 只能是/],
  ]) {
    const root = workspace(config);
    try { assert.throws(() => loadWorkspace(root), pattern); } finally { rmSync(root, { recursive: true, force: true }); }
  }
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
