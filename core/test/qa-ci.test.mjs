import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('qa ci: GitHub annotations and Markdown escape user-visible content', () => {
  const annotations = renderGithubAnnotations([{ ...FINDINGS[0], title: 'bad%:\nline', observed: 'a|b,c' }]);
  assert.match(annotations, /^::error title=/);
  assert.match(annotations, /bad%25%3A%0Aline/);
  assert.match(annotations, /a\|b%2Cc/);
  const md = renderCiMarkdown({
    result: { runId: 'qa-1', site: 'web', summary: { fileable: 1 }, report: '.heimdall/report.md', bugs: '.heimdall/bugs.md' },
    gate: { status: 'failed', failOn: 'all', findings: [{ ...FINDINGS[0], title: 'a|b' }] },
    generatedAt: '2026-11-04T00:00:00.000Z',
  });
  assert.match(md, /Heimdall QA CI/);
  assert.match(md, /a\\\|b/);
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
