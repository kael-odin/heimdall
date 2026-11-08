import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SEO agent reports incomplete coverage without linking a stale diff', async t => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-agent-seo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.HEIMDALL_DATA_DIR = root;
  const { default: capability } = await import('../src/agent/registry/capabilities/seo-audit.mjs');
  const directory = join(root, 'workspace', 'example.test', 'seo');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'seo.json'), JSON.stringify({
    origin: 'https://example.test', score: 100, summary: { initialHtmlUnchecked: 1 }, categories: {},
  }));
  writeFileSync(join(directory, 'diff.md'), 'old comparison');
  const jobs = {
    TERMINAL: new Set(['succeeded']),
    create: ({ finish }) => ({ job: { jobId: 'job_coverage', status: 'succeeded', result: finish() } }),
  };
  const response = await capability.handler({ url: 'https://example.test/', maxPages: 1, waitMs: 0 }, { jobs });
  assert.equal(response.ok, true);
  assert.match(response.summary, /部分完成.*1 页未核对初始 HTML/);
  assert.equal(response.result.result.summary.initialHtmlUnchecked, 1);
  assert.equal(response.result.result.reports.diff, null);
});
