import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAcceptanceFixture, ACCEPTANCE_FIXTURE_CASES } from './fixtures/acceptance-site.mjs';
import { acceptanceFixturePlan, localizationHit, LOCALIZATION_TRUTH } from '../scripts/benchmark-acceptance.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { localizeAcceptanceRun, localizationMarkdown, whereText } from '../src/acceptance/localize.mjs';

let fixture, root;
before(async () => { fixture = await startAcceptanceFixture(); root = await mkdtemp(join(tmpdir(), 'heimdall-localize-')); });
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

/** A real run of one fixture case, laid out like a legacy run directory (plan in manifest.json). */
async function runCase(id, { planFile = 'manifest' } = {}) {
  const item = ACCEPTANCE_FIXTURE_CASES.find(entry => entry.id === id);
  const dir = join(root, `${id}-${planFile}`);
  const plan = acceptanceFixturePlan(item, fixture);
  const report = summarizeAcceptanceReport(await runAcceptance(plan, { runId: `localize-${id}`, outputDir: dir }));
  await writeFile(join(dir, 'report.json'), JSON.stringify(report));
  if (planFile === 'manifest') await writeFile(join(dir, 'manifest.json'), JSON.stringify({ runId: `localize-${id}`, status: 'completed', plan }));
  else await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
  return { dir, report };
}
const checkOf = (result, suffix) => result.checks.find(check => check.checkId.endsWith(suffix));
const findingsOf = (check, kind) => check.findings.filter(finding => finding.kind === kind);

test('non-bug runs need no localization and leave the run directory untouched', async () => {
  for (const id of ['identical', 'baseline-error', 'masked-noise', 'blocked-write']) {
    const { dir, report } = await runCase(id);
    const before = await readFile(join(dir, 'report.json'), 'utf8');
    const result = await localizeAcceptanceRun(dir);
    assert.equal(result.status, 'no_failures', id);
    assert.equal(result.checks.length, 0);
    assert.equal(result.runId, report.runId);
    assert.equal(await readFile(join(dir, 'report.json'), 'utf8'), before);
  }
});

test('spec runs are reported as unsupported instead of re-rendered', async () => {
  const dir = join(root, 'spec');
  await rm(dir, { recursive: true, force: true });
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.json'), JSON.stringify({ runId: 'spec-run', mode: 'spec', checks: [{ id: 'x', verdict: 'bug', status: 'failed' }] }));
  const result = await localizeAcceptanceRun(dir);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.mode, 'spec');
});

test('visual shift is traced to the injected rule and the moved elements', async () => {
  const { dir } = await runCase('visual-shift', { planFile: 'plan' });
  const result = await localizeAcceptanceRun(dir);
  assert.equal(result.status, 'completed');
  const check = checkOf(result, '-visual');
  assert.equal(check.level, 'source');
  assert.ok(check.diffRegions?.length, 'diff regions are read from the run diff image');
  const styles = findingsOf(check, 'style');
  const main = styles.find(finding => finding.element === 'main');
  assert.ok(main, 'main transform is reported');
  assert.equal(main.inDiffRegion, true);
  assert.equal(main.box.target.y - main.box.baseline.y, 160);
  assert.equal(main.changes[0].property, 'transform');
  assert.equal(main.source.declaration, 'transform:translateY(160px)');
  const panel = styles.find(finding => finding.element === 'section.panel');
  const background = panel?.changes.find(change => change.property === 'background-color');
  assert.equal(background?.target, 'rgb(143, 37, 0)');
  assert.match(background.source.declaration, /background:#8f2500/);
  assert.match(whereText(panel.source), /^\/target\/visual-shift:\d+:\d+$/);
});

test('hidden mobile control is traced to the media-query rule', async () => {
  const { dir } = await runCase('mobile-menu');
  const result = await localizeAcceptanceRun(dir);
  for (const suffix of ['-structure', '-truth-mobile-menu']) {
    const check = checkOf(result, suffix);
    const [hidden] = findingsOf(check, 'hidden');
    assert.ok(hidden, suffix);
    assert.equal(hidden.selector, '#menu-toggle');
    assert.match(hidden.detail, /max-width: 600px/);
    assert.match(hidden.source.excerpt, /#menu-toggle\{display:none\}/);
    assert.equal(hidden.source.kind, 'inline-style');
  }
});

test('menu state bug is traced to the click handler that never updates aria-expanded', async () => {
  const { dir } = await runCase('menu-state');
  const check = checkOf(await localizeAcceptanceRun(dir), '-truth-menu-state');
  assert.equal(check.replay.reproduced, true);
  assert.equal(check.replay.steps, 1);
  const [handler] = findingsOf(check, 'handler');
  assert.ok(handler, 'handler finding');
  assert.match(handler.detail, /aria-expanded/);
  assert.match(handler.source.excerpt, /addEventListener\('click'/);
  assert.equal(handler.source.kind, 'inline-script');
});

test('missing field is anchored to its baseline neighbour in the target markup', async () => {
  const { dir } = await runCase('missing-field');
  const check = checkOf(await localizeAcceptanceRun(dir), '-truth-missing-field');
  const [missing] = findingsOf(check, 'missing');
  assert.equal(missing.selector, '#quota');
  assert.match(missing.detail, /div\.metric/);
  assert.match(missing.source.excerpt, /class="metric"/);
  assert.match(missing.baselineSource.excerpt, /id="quota"/);
});

test('wrong link is traced to the href attribute in both structure and behaviour checks', async () => {
  const { dir } = await runCase('wrong-link');
  const result = await localizeAcceptanceRun(dir);
  for (const suffix of ['-structure', '-truth-wrong-link']) {
    const [attribute] = findingsOf(checkOf(result, suffix), 'attribute');
    assert.ok(attribute, suffix);
    assert.match(attribute.source.excerpt, /^href="pricing"|href="pricing"/);
    assert.match(attribute.baselineSource.excerpt, /href="details"/);
  }
});

test('runtime error is traced to the throwing script line', async () => {
  const { dir } = await runCase('runtime-error');
  const [error] = findingsOf(checkOf(await localizeAcceptanceRun(dir), '-console'), 'script-error');
  assert.match(error.detail, /approved runtime script failed/);
  assert.match(error.source.excerpt, /throw new Error/);
  assert.ok(error.source.line > 0 && error.source.column > 0);
});

test('missing resource is traced to the tag that requested it, once per broken reference', async () => {
  const { dir } = await runCase('missing-resource');
  const result = await localizeAcceptanceRun(dir);
  for (const suffix of ['-console', '-network']) {
    const resources = findingsOf(checkOf(result, suffix), 'resource');
    assert.equal(resources.length, 1, suffix);
    assert.equal(resources[0].request.status, 404);
    assert.match(resources[0].source.excerpt, /<script src="missing-widget\.js">/);
  }
  const markdown = localizationMarkdown(result);
  assert.match(markdown, /# 元素定位/);
  assert.match(markdown, /missing-widget\.js/);
});

test('benchmark localization truth covers every known bug and grades source, element and miss', () => {
  const bugs = ACCEPTANCE_FIXTURE_CASES.filter(item => item.targetBug).map(item => item.id);
  assert.deepEqual(Object.keys(LOCALIZATION_TRUTH).sort(), bugs.sort());
  const truth = LOCALIZATION_TRUTH['wrong-link'];
  const run = source => ({ checks: [{ checkId: 'c', findings: [{ kind: 'attribute', selector: '#details-link', source }] }] });
  const hit = localizationHit(truth, run({ url: 'http://x/target/wrong-link', line: 14, column: 161, excerpt: '<a id="details-link" href="pricing">' }));
  assert.equal(hit.level, 'source');
  assert.equal(hit.finding.checkId, 'c');
  // Right element but the excerpt points elsewhere, or no line at all: element only.
  assert.equal(localizationHit(truth, run({ line: 3, column: 1, excerpt: '<header>' })).level, 'element');
  assert.equal(localizationHit(truth, run({ excerpt: 'href="pricing"' })).level, 'element');
  // Wrong kind or wrong element is a miss, and so is an empty result.
  assert.equal(localizationHit(truth, { checks: [{ checkId: 'c', findings: [{ kind: 'style', selector: '#details-link', source: { line: 1, excerpt: 'href="pricing"' } }] }] }).level, 'miss');
  assert.equal(localizationHit(truth, { checks: [] }).level, 'miss');
  assert.equal(localizationHit(null, { checks: [] }), null);
});
