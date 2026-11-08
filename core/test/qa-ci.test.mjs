import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCiMarkdown, renderGithubAnnotations, runQaCi, selectGateFindings } from '../src/qa/ci.mjs';

const FINDINGS = [
  { id: 'F1', tier: 'wall', basis: 'failed', kind: 'broken-link', path: '/', title: '链接打不开', observed: '404' },
  { id: 'F2', tier: 'degrade', basis: 'wrong', kind: 'console', path: '/pricing', title: '控制台报错', observed: 'boom' },
  { id: 'F3', tier: 'tolerable', basis: 'cosmetic', kind: 'overflow', path: '/', title: '轻微溢出', observed: '3px' },
];

test('qa ci: fail-on selects only the configured tier', () => {
  assert.deepEqual(selectGateFindings(FINDINGS, 'all').map(f => f.id), ['F1', 'F2', 'F3']);
  assert.deepEqual(selectGateFindings(FINDINGS, 'degrade').map(f => f.id), ['F1', 'F2']);
  assert.deepEqual(selectGateFindings(FINDINGS, 'wall').map(f => f.id), ['F1']);
  assert.deepEqual(selectGateFindings(FINDINGS, 'none'), []);
});

test('qa ci: an expired login is incomplete even with fail-on none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-ci-incomplete-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'ci-incomplete', sites: { web: { url: 'https://example.test/', pages: ['/'] } },
  }));
  try {
    const result = await runQaCi({
      args: { workspace: root, site: 'web' }, failOn: 'none',
      execute: async () => ({ ok: true, summary: 'QA finished.', nextActions: [], result: {
        runId: 'qa-incomplete', site: 'web', runDir: '.heimdall/qa/runs/qa-incomplete',
        report: 'report.md', bugs: 'bugs.md', summary: { fileable: 0, environment: 1 },
        fileable: [], environment: ['登录档没生效或已过期'],
      } }),
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.env.ok, false);
    assert.equal(result.env.error.code, 'qa_incomplete');
    assert.equal(result.env.result.ci.status, 'incomplete');
    assert.match(readFileSync(join(root, '.heimdall/qa/runs/qa-incomplete/qa-ci.md'), 'utf8'), /未完成/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('qa ci: an unverified check is incomplete even without fileable findings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-ci-unverified-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'ci-unverified', sites: { web: { url: 'https://example.test/', pages: ['/'] } },
  }));
  try {
    const result = await runQaCi({ args: { workspace: root }, failOn: 'none', execute: async () => ({
      ok: true, summary: 'QA finished.', nextActions: [], result: {
        runId: 'qa-unverified', site: 'web', runDir: '.heimdall/qa/runs/qa-unverified',
        report: 'report.md', bugs: 'bugs.md', summary: { fileable: 0, checkNeedsFix: 1 }, fileable: [], environment: [],
      },
    }) });
    assert.equal(result.exitCode, 3);
    assert.equal(result.env.error.code, 'qa_incomplete');
    assert.equal(result.env.result.ci.status, 'incomplete');
    assert.match(result.env.result.ci.markdown, /检查点/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('qa ci: GitHub annotations and Markdown escape user-visible content', () => {
  const annotations = renderGithubAnnotations([{ ...FINDINGS[0], title: 'bad%:\nline', observed: 'a|b,c' }]);
  assert.match(annotations, /^::error title=/);
  assert.match(annotations, /bad%25%3A%0Aline/);
  assert.match(annotations, /a\|b%2Cc/);
  const md = renderCiMarkdown({
    result: { runId: 'qa-1', site: 'web', summary: { fileable: 1 }, report: '.heimdall/report.md', bugs: '.heimdall/bugs.md' },
    gate: { status: 'failed', failOn: 'all', findings: [{ ...FINDINGS[0], title: '@team [x](https://bad.test) <script> a|b' }] },
    generatedAt: '2026-11-04T00:00:00.000Z',
  });
  assert.match(md, /Heimdall QA CI/);
  assert.match(md, /&#64;team &#91;x&#93;/);
  assert.match(md, /&lt;script&gt; a&#124;b/);
  assert.doesNotMatch(md, /@team \[x\]\(https:\/\/bad\.test\) <script>/);
  assert.match(md, /结果：\*\*失败\*\*/);
});

test('qa ci: writes sidecars and returns exit code 1 when the gate fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-ci-'));
  const runDir = join(root, '.heimdall', 'qa', 'runs', 'qa-test');
  const summaryPath = join(root, 'github-summary.md');
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    schema: 'heimdall.qa/1',
    project: 'ci-test',
    sites: { web: { url: 'https://example.test/', pages: ['/'] } },
  }));
  const oldSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  try {
    const result = await runQaCi({
      args: { workspace: root, site: 'web', viewports: [390], linkCheck: false },
      failOn: 'wall',
      github: true,
      execute: async () => ({
        ok: true,
        result: {
          runId: 'qa-test', site: 'web', runDir: '.heimdall/qa/runs/qa-test',
          report: '.heimdall/qa/runs/qa-test/report.md', bugs: '.heimdall/qa/runs/qa-test/bugs.md',
          summary: { fileable: 2 }, fileable: FINDINGS,
        },
        summary: 'QA finished.',
        nextActions: [],
        evidence: [],
      }),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.env.ok, false);
    assert.equal(result.env.error.code, 'gate_failed');
    assert.match(result.annotations, /::error/);
    assert.ok(existsSync(join(runDir, 'qa-ci.json')));
    assert.ok(existsSync(join(runDir, 'qa-ci.md')));
    assert.match(readFileSync(summaryPath, 'utf8'), /Heimdall QA CI/);
    const sidecar = JSON.parse(readFileSync(join(runDir, 'qa-ci.json'), 'utf8'));
    assert.equal(sidecar.gate.findings.length, 1);
    assert.equal(sidecar.gate.findings[0].id, 'F1');
  } finally {
    if (oldSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = oldSummary;
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa ci: reports a sidecar write failure without claiming files exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-ci-write-fail-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    schema: 'heimdall.qa/1',
    project: 'ci-write-fail',
    sites: { web: { url: 'https://example.test/', pages: ['/'] } },
  }));
  writeFileSync(join(root, 'blocked-run-dir'), 'not a directory');
  try {
    const result = await runQaCi({
      args: { workspace: root, site: 'web', viewports: [390], linkCheck: false },
      failOn: 'none',
      execute: async () => ({
        ok: true,
        result: {
          runId: 'qa-write-fail', site: 'web', runDir: 'blocked-run-dir',
          report: '.heimdall/qa/runs/qa-write-fail/report.md', bugs: '.heimdall/qa/runs/qa-write-fail/bugs.md',
          summary: { fileable: 0 }, fileable: [],
        },
        summary: 'QA finished.',
        nextActions: [],
        evidence: [],
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.env.result.ci.files, null);
    assert.ok(result.env.result.ci.sidecarError);
    assert.match(result.env.summary, /CI 附件未写成/);
    assert.ok(result.env.warnings?.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa ci: reusable composite action keeps the documented entrypoint', () => {
  const action = readFileSync(fileURLToPath(new URL('../../actions/qa-ci/action.yml', import.meta.url)), 'utf8');
  const readme = readFileSync(fileURLToPath(new URL('../../actions/qa-ci/README.md', import.meta.url)), 'utf8');
  assert.match(action, /using: composite/);
  assert.match(action, /kael-odin\/heimdall\/actions\/qa-ci@main/);
  assert.match(action, /github\.action_path \}\}\/\.\.\/\.\.\/core/);
  assert.match(action, /GITHUB_ACTION_PATH\/\.\.\/\.\.\/core\/src\/cli\.mjs/);
  assert.match(action, /args\+=\(--checks "\$QA_WORKSPACE\/\$QA_CHECKS"\)/);
  assert.match(action, /QA result is valid/);
  assert.match(action, /qa ci/);
  assert.match(readme, /kael-odin\/heimdall\/actions\/qa-ci@main/);
});
