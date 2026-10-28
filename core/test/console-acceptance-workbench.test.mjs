import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceEvidenceEntries, acceptanceEvidenceFilename, acceptanceScore, acceptanceViewport,
  buildAcceptanceInput, filterAcceptanceChecks,
  acceptanceSpecFingerprint, buildOpenApiPreviewInput, SPEC_CHECK_EXAMPLE,
  acceptanceComparisonQuery, filterAcceptanceComparison,
  acceptanceLocalizationResult, localizationWhere,
  ACCEPTANCE_DEFAULT_VIEWPORTS, acceptanceRoutes, buildExplorationInput, mergeExploredPoints,
} from '../../console/src/acceptance-workbench.js';
import { DEFAULT_VIEWPORTS } from '../src/acceptance/schema.mjs';

test('element localization payloads are validated before the panel renders them', () => {
  const finding = { kind: 'hidden', detail: '目标页面隐藏了 #menu-toggle', source: { kind: 'inline-style', url: 'http://127.0.0.1/target/mobile-menu', line: 9, column: 23, excerpt: '#menu-toggle{display:none}' } };
  const value = { status: 'completed', summary: '1 个可靠失败中，1 个定位到源码位置。', checks: [{ checkId: 'route-1-1-mobile-structure', status: 'completed', level: 'source', findings: [finding] }] };
  assert.equal(acceptanceLocalizationResult(value), value);
  for (const status of ['no_failures', 'unsupported']) assert.equal(acceptanceLocalizationResult({ status, summary: '无需定位', checks: [] }).status, status);
  for (const broken of [null, [], { status: 'running', summary: '', checks: [] }, { status: 'completed', checks: [] },
    { ...value, checks: [{ ...value.checks[0], level: 'guess' }] },
    { ...value, checks: [{ ...value.checks[0], findings: [{ kind: 'hidden' }] }] },
    { ...value, checks: [{ ...value.checks[0], findings: [{ ...finding, source: { ...finding.source, line: '9' } }] }] }])
    assert.throws(() => acceptanceLocalizationResult(broken), /元素定位结果格式无效/);
});

test('localized sources render as path:line:column without leaking the origin', () => {
  assert.equal(localizationWhere({ url: 'http://127.0.0.1:4000/target/mobile-menu?token=x', line: 9, column: 23 }), '/target/mobile-menu:9:23');
  assert.equal(localizationWhere({ url: 'http://127.0.0.1:4000/app.js', file: '/target/app.js', line: 2 }), '/target/app.js:2:1');
  assert.equal(localizationWhere({ origin: 'user-agent', property: 'display' }), '浏览器默认样式');
  assert.equal(localizationWhere({ kind: 'stylesheet' }), '未知位置');
  assert.equal(localizationWhere(null), '未知位置');
});

test('comparison selection requires an explicit distinct valid pair and an allowed export format', () => {
  const a = 'ac-00000000-0000-4000-8000-000000000001', b = 'ac-00000000-0000-4000-8000-000000000002';
  assert.deepEqual(Object.fromEntries(new URLSearchParams(acceptanceComparisonQuery(a, b).slice(1))), { before: a, after: b, format: 'json' });
  assert.equal(new URLSearchParams(acceptanceComparisonQuery(a, b, 'md').slice(1)).get('format'), 'md');
  for (const pair of [['', b], [a, ''], [a, a], ['../report', b], [a + '&format=md', b]]) assert.throws(() => acceptanceComparisonQuery(...pair));
  assert.throws(() => acceptanceComparisonQuery(a, b, 'html'));
});

test('comparison filters keep unverified and incomparable reasons searchable without hiding observations', () => {
  const rows = [
    { relation: 'verified_passed', title: 'Quota', route: '/quota', before: { checkId: 'old' }, after: { checkId: 'new' }, reasons: [] },
    { relation: 'unverified', title: 'Missing route', route: '/other', reasons: [{ code: 'check-not-rerun', message: '缺测不能算修复' }] },
    { relation: 'incomparable', title: 'Changed source', route: '/quota', reasons: [{ code: 'oracle-changed', message: '来源变化' }] },
  ];
  assert.equal(filterAcceptanceComparison(rows).length, 3);
  assert.deepEqual(filterAcceptanceComparison(rows, { query: 'ORACLE-CHANGED' }).map(row => row.relation), ['incomparable']);
  assert.deepEqual(filterAcceptanceComparison(rows, { query: '缺测' }).map(row => row.relation), ['unverified']);
  assert.deepEqual(filterAcceptanceComparison(rows, { relation: 'verified_passed', query: 'OLD' }).map(row => row.title), ['Quota']);
  assert.equal(rows.length, 3);
});

const form = overrides => ({ name: '首页验收', mode: 'mirror', baselineUrl: 'https://baseline.test',
  targetUrl: 'http://127.0.0.1:3000', routes: '/', points: '', maskSelectors: '', ...overrides });

test('acceptance form submits distinct routes and lets the engine choose default viewports', () => {
  assert.deepEqual(buildAcceptanceInput(form({ routes: '/\n /products?category=all \n/\n' })), {
    name: '首页验收', mode: 'mirror', baselineUrl: 'https://baseline.test/', targetUrl: 'http://127.0.0.1:3000/',
    routes: ['/', '/products?category=all'],
  });
});

test('acceptance form keeps behavior points and normalization configuration', () => {
  const points = [{ id: 'MENU', title: '菜单', assertions: [{ kind: 'visible', selector: 'nav' }] }];
  const result = buildAcceptanceInput(form({ name: ' ', mode: 'regression', points: JSON.stringify(points), maskSelectors: '[".clock"]' }));
  assert.equal(result.name, '项目回归验收');
  assert.deepEqual(result.points, points);
  assert.deepEqual(result.normalization, { maskSelectors: ['.clock'] });
});

test('invalid URLs, routes and advanced configuration fail before creating a task', () => {
  for (const value of ['javascript:alert(1)', 'file:///test', 'https://user:password@test/', 'https://test/#fragment']) {
    assert.throws(() => buildAcceptanceInput(form({ baselineUrl: value })), /基线 URL/);
  }
  assert.throws(() => buildAcceptanceInput(form({ targetUrl: 'https://baseline.test/' })), /不同的地址/);
  for (const routes of ['', 'https://foreign.test', '//foreign.test', '/%2fexample.com', '/%252e%252e/private', '/a\\b', '/a#fragment', '/bad%encoding']) {
    assert.throws(() => buildAcceptanceInput(form({ routes })), /路由/);
  }
  assert.throws(() => buildAcceptanceInput(form({ routes: Array.from({ length: 9 }, (_, i) => `/route-${i}`).join('\n') })), /8 条/);
  for (const points of ['{', '{}', '[null]', '["click"]']) assert.throws(() => buildAcceptanceInput(form({ points })), /验收点/);
  for (const maskSelectors of ['{}', '[12]', '[""]']) assert.throws(() => buildAcceptanceInput(form({ maskSelectors })), /忽略区域/);
});

const checks = [
  { id: 'visual', title: '视觉像素差异', dimension: 'visual', route: '/', status: 'failed', verdict: 'bug', expected: { score: 0.97 }, actual: { score: 0.8 } },
  { id: 'baseline', title: '基线交互失败', dimension: 'behavior', route: '/menu', status: 'blocked', verdict: 'baseline_failed' },
  { id: 'review', title: '交互需复核', dimension: 'behavior', route: '/products', status: 'needs_review', verdict: 'needs_review' },
  { id: 'passed', title: '页面结构一致', dimension: 'structure', route: '/', status: 'passed', verdict: 'match' },
];

test('attention filters preserve baseline and review findings without classifying them as target bugs', () => {
  assert.deepEqual(filterAcceptanceChecks(checks).map(x => x.id), ['visual', 'baseline', 'review']);
  assert.deepEqual(filterAcceptanceChecks(checks, { verdict: 'bug' }).map(x => x.id), ['visual']);
  assert.deepEqual(filterAcceptanceChecks(checks, { dimension: 'behavior' }).map(x => x.id), ['baseline', 'review']);
  assert.deepEqual(filterAcceptanceChecks(checks, { verdict: 'all', query: '0.97' }).map(x => x.id), ['visual']);
  assert.deepEqual(filterAcceptanceChecks(checks, { verdict: 'all', query: '/products' }).map(x => x.id), ['review']);
  assert.equal(filterAcceptanceChecks(checks, { verdict: 'all' }).length, 4);
  assert.equal(checks.length, 4);
});

test('evidence accepts only flat PNG/JSON files from the acceptance API', () => {
  assert.equal(acceptanceEvidenceFilename('run-1.desktop-target.png'), 'run-1.desktop-target.png');
  assert.equal(acceptanceEvidenceFilename('details.json'), 'details.json');
  for (const value of ['https://remote.test/a.png', '../a.png', '/a.png', 'nested/a.png', 'nested\\a.png', 'a.svg', 'a.png?token=secret', '..', null, { filename: 'a.png' }]) {
    assert.equal(acceptanceEvidenceFilename(value), '');
  }
});

test('unmeasured values remain unmeasured in report presentation', () => {
  assert.equal(acceptanceScore(null), '未测量');
  assert.equal(acceptanceScore(0.97), '97.0%');
  assert.equal(acceptanceScore(97), '97.0%');
  assert.equal(acceptanceScore(0), '0.0%');
  assert.equal(acceptanceViewport({ width: 375, height: 812 }), '375 × 812');
  assert.equal(acceptanceViewport('desktop'), 'desktop');
});

test('paired JSON evidence is available for current and persisted report layouts', () => {
  const current = acceptanceEvidenceEntries({ evidence: { baselineScreenshot: 'base.png', baselineDetails: 'base.json', targetDetails: 'target.json', diff: 'diff.png' } });
  assert.deepEqual(current.map(item => item.filename), ['base.png', 'diff.png', 'base.json', 'target.json']);
  const previous = acceptanceEvidenceEntries({ evidence: { baselineDetails: 'base.json', details: { baseline: 'base.json', target: 'target.json' }, diff: 'https://foreign.test/diff.png' } });
  assert.deepEqual(previous.map(item => item.filename), ['base.json', 'target.json']);
});

const specForm = overrides => form({ mode: 'spec', baselineUrl: '', specSourceId: 'quota-requirement', specRevision: 'v1',
  specSourceTitle: '额度接口需求', specSourceType: 'manual', specSourceSha256: '',
  specChecks: JSON.stringify(SPEC_CHECK_EXAMPLE), specOmissions: '[]', openApiDocument: '', specApproved: false, ...overrides });
const approve = draft => ({ ...draft, specApproved: true, specApprovedFingerprint: acceptanceSpecFingerprint(draft) });

test('approved spec draft submits only target and its traceable contract', () => {
  const input = buildAcceptanceInput(approve(specForm()));
  assert.equal(input.mode, 'spec');
  assert.equal(input.schemaVersion, 1);
  assert.equal(input.targetUrl, 'http://127.0.0.1:3000/');
  assert.deepEqual(input.spec.source, { id: 'quota-requirement', revision: 'v1', title: '额度接口需求', type: 'manual' });
  assert.deepEqual(input.spec.checks, SPEC_CHECK_EXAMPLE);
  assert.deepEqual(input.spec.omissions, []);
  assert.equal(input.spec.approved, true);
  for (const field of ['baselineUrl', 'routes', 'points', 'normalization', 'viewports']) assert.equal(Object.hasOwn(input, field), false);
});

test('spec approval is explicit and cannot approve changed targets, requirements, checks or omissions', () => {
  assert.throws(() => buildAcceptanceInput(specForm()), /明确批准/);
  for (const [key, value] of Object.entries({ targetUrl: 'https://different.test', specSourceId: 'other', specRevision: 'v2',
    specSourceTitle: '新需求', specSourceType: 'openapi', specSourceSha256: 'document-sha',
    specChecks: JSON.stringify([{ ...SPEC_CHECK_EXAMPLE[0], title: '新契约' }]),
    specOmissions: '[{"id":"POST-OMITTED","path":"/api/orders","method":"POST","reason":"未执行写请求"}]',
    openApiDocument: '{"openapi":"3.0.3"}',
  })) {
    const draft = approve(specForm());
    draft[key] = value;
    assert.throws(() => buildAcceptanceInput(draft), /修改后需要重新批准/, key);
  }
});

test('manual API contracts validate read-only methods and supported JSON assertions', () => {
  const build = checks => buildAcceptanceInput(approve(specForm({ specChecks: JSON.stringify(checks) })));
  const check = SPEC_CHECK_EXAMPLE[0];
  const assertions = [
    { pointer: '/code', kind: 'equals', value: null }, { pointer: '/data', kind: 'required' },
    { pointer: '/data/name', kind: 'type', type: 'string' }, { pointer: '/data/plan', kind: 'enum', values: ['free', 'pro'] },
  ];
  assert.deepEqual(build([{ ...check, expect: { status: 200, json: assertions, schema: { type: 'object' } } }]).spec.checks[0].expect.json, assertions);
  for (const schema of [true, false]) assert.equal(build([{ ...check, expect: { status: 200, schema } }]).spec.checks[0].expect.schema, schema);
  assert.throws(() => build([{ ...check, expect: { json: assertions } }]), /HTTP status/);
  for (const checks of [[], [null], [{ ...check, method: 'POST' }], [{ ...check, path: 'https://other.test/api' }], [check, check]]) assert.throws(() => build(checks));
  for (const assertion of [{ pointer: '/code', kind: 'equals' }, { pointer: '/code', kind: 'type', type: 'undefined' },
    { pointer: '/code', kind: 'enum', values: [] }, { pointer: 'data', kind: 'required' }, { pointer: '/', kind: 'execute' }]) {
    assert.throws(() => build([{ ...check, expect: { status: 200, json: [assertion] } }]));
  }
});

test('OpenAPI preview input keeps the document and never assumes approval', () => {
  const document = { openapi: '3.0.3', info: { title: 'Quota API', version: '1.0' }, paths: {} };
  assert.deepEqual(buildOpenApiPreviewInput(specForm({ name: '', openApiDocument: JSON.stringify(document) })), {
    document, targetUrl: 'http://127.0.0.1:3000/', name: 'OpenAPI 需求验收',
  });
  for (const openApiDocument of ['', '{', '[]', 'null']) assert.throws(() => buildOpenApiPreviewInput(specForm({ openApiDocument })), /OpenAPI/);
});

test('approved OpenAPI plans retain the complete source document for evidence', () => {
  const document = { openapi: '3.1.0', info: { title: 'Quota API', version: '1.0' }, paths: {}, 'x-evidence-note': '原始需求依据' };
  const draft = specForm({ specSourceType: 'openapi', specSourceSha256: 'a'.repeat(64), openApiDocument: JSON.stringify(document) });
  assert.deepEqual(buildAcceptanceInput(approve(draft)).spec.document, document);
  assert.equal(Object.hasOwn(buildAcceptanceInput(approve(specForm())).spec, 'document'), false);
  for (const openApiDocument of ['', '{', '[]', 'null']) {
    assert.throws(() => buildAcceptanceInput(approve({ ...draft, openApiDocument })), /OpenAPI/);
  }
});

test('spec evidence is JSON-only with API presentation', () => {
  const files = acceptanceEvidenceEntries({ evidence: { request: 'request.json', response: 'response.json', contract: 'contract.json', source: 'requirement-source.json' } });
  assert.deepEqual(files.map(item => item.filename), ['request.json', 'response.json', 'contract.json', 'requirement-source.json']);
  assert.equal(files.find(item => item.key === 'source').label, '需求源文档');
  assert.equal(acceptanceViewport('api'), 'API');
});

test('explicit omissions can be reviewed while an empty contract cannot silently pass', () => {
  const draft = approve(specForm({ specChecks: '[]', specOmissions: '[{"id":"POST-OMITTED","path":"/api/orders","method":"POST","reason":"未执行写请求"}]' }));
  assert.equal(buildAcceptanceInput(draft).spec.checks.length, 0);
  assert.equal(buildAcceptanceInput(draft).spec.omissions.length, 1);
  assert.throws(() => buildAcceptanceInput(approve(specForm({ specChecks: '[]' }))), /至少声明/);
});

test('exploration uses the runner default viewports and the same route validation as a new run', () => {
  assert.deepEqual(ACCEPTANCE_DEFAULT_VIEWPORTS.map(({ name, width, height }) => ({ name, width, height })),
    DEFAULT_VIEWPORTS.map(({ name, width, height }) => ({ name, width, height })));
  const input = buildExplorationInput({ baselineUrl: 'http://127.0.0.1:9087/baseline', routes: '/identical\n/menu-state' });
  assert.deepEqual(input.routes, ['/identical', '/menu-state']);
  assert.deepEqual(input.viewports, DEFAULT_VIEWPORTS.map(({ name, width, height }) => ({ name, width, height })));
  assert.throws(() => buildExplorationInput({ baselineUrl: 'file:///etc/passwd', routes: '/' }), /HTTP/);
  assert.throws(() => buildExplorationInput({ baselineUrl: 'http://127.0.0.1/', routes: '../up' }), /路由/);
  assert.throws(() => acceptanceRoutes(''), /至少填写/);
  assert.throws(() => acceptanceRoutes(Array.from({ length: 9 }, (_, i) => `/p${i}`).join('\n')), /最多/);
});

test('explored points merge without duplicating what the user already declared', () => {
  const toggle = { id: 'a', title: '点击菜单', route: '/identical', severity: 'high',
    steps: [{ action: 'click', selector: '#menu-toggle' }], assertions: [{ kind: 'visible', selector: '#menu' }] };
  const quota = { id: 'b', title: '页面文案', route: '/identical', severity: 'medium',
    assertions: [{ kind: 'text', selector: '#quota', equals: '剩余配额：128 个任务' }] };
  const existing = JSON.stringify([toggle]);
  const merged = mergeExploredPoints(existing, [toggle, quota, { id: 'bad' }, null]);
  assert.equal(merged.added, 1);
  assert.equal(merged.points.length, 2);
  assert.equal(merged.points[1].id, 'b');
  // Same steps but a different assertion is a different point; the same triple is not.
  assert.equal(mergeExploredPoints('', [toggle, { ...toggle, id: 'c' }]).added, 1);
  assert.deepEqual(mergeExploredPoints('', []), { points: [], added: 0 });
  assert.throws(() => mergeExploredPoints('[not json', []), /不是有效 JSON/);
  assert.throws(() => mergeExploredPoints('{}', []), /必须是 JSON 数组/);
  assert.throws(() => mergeExploredPoints('', null), /探索结果格式无效/);
});
