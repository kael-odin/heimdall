import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.mjs');

test('rebuild status keeps page-level progress separate and points to formal gate', () => {
  const project = mkdtempSync(join(tmpdir(), 'heimdall-rebuild-status-'));
  try {
    mkdirSync(join(project, '.heimdall', 'sections'), { recursive: true });
    mkdirSync(join(project, '.heimdall', 'runs', 'run_page'), { recursive: true });
    writeFileSync(join(project, 'heimdall.config.json'), JSON.stringify({
      schema: 'heimdall.config/1', siteId: 'status.test', stack: 'html-css',
      pages: [{ name: 'home', route: '/' }], viewports: [375, 768, 1440],
      gate: { level: 'silver' }, budget: { maxIterationsPerSection: 4, maxIterationsPerPage: 8 },
    }));
    writeFileSync(join(project, '.heimdall', 'sections', 'home.json'), JSON.stringify({
      sections: [
        { id: 'sec-content-aaaaaa', role: 'content', overlay: false },
        { id: 'sec-content-bbbbbb', role: 'content', overlay: false },
      ],
    }));
    writeFileSync(join(project, '.heimdall', 'ledger.jsonl'), `${JSON.stringify({
      schema: 'heimdall.ledger/1', type: 'iter', runId: 'run_page', page: 'home',
      sectionIds: null, pixel: { 375: 1, 768: 1, 1440: 1 }, verdict: 'pass-candidate', reached: 'gold',
    })}\n`);
    const run = spawnSync(process.execPath, [CLI, 'rebuild', 'status', '--project', project, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const env = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(env.ok, true);
    assert.equal(env.result.page.next.action, 'done');
    assert.equal(env.result.sections.every(section => section.verdict === 'not-started'), true);
    assert.match(env.summary, /0\/2 个分段有独立对比/);
    assert.equal(env.nextActions[0].tool, 'cli:shell');
    assert.match(env.nextActions[0].args.command, /gate formal/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
