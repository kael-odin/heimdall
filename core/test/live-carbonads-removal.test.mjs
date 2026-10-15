import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeCarbonAds } from '../src/live/carbonads-removal.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

test('carbonads removal removes the script, container, and nested pixels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-carbonads-unit-'));
  try {
    const liveDir = join(dir, 'live');
    mkdirSync(liveDir);
    writeFileSync(join(liveDir, 'index.html'), '<!doctype html><html><body>'
      + '<main><p>Keep this content</p></main>'
      + '<aside class="VPDocAsideCarbonAds"><div class="VPCarbonAds">'
      + '<script id="_carbonads_js" src="https://cdn.carbonads.com/carbon.js?serve=private" async></script>'
      + '<div id="carbonads"><span><a href="https://srv.carbonads.net/click">Ad</a>'
      + '<img src="https://secure.adnxs.com/px"><img src="https://ad.doubleclick.net/ddm/activity">'
      + '</span></div></div></aside>'
      + '<img src="https://unrelated.example/tracker.png">'
      + '</body></html>');
    const report = removeCarbonAds({ liveDir });
    assert.equal(report.status, 'removed');
    assert.equal(report.files, 1);
    assert.equal(report.removedScripts, 0,
      'the enclosing CarbonAds container is removed as one node, including its script');
    assert.equal(report.removedContainers, 1);
    assert.equal(report.removedNodes, 1);
    assert.equal(report.remainingHtmlReferences, 0);
    assert.equal(report.failed, 0);
    const html = readFileSync(join(liveDir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /carbonads|secure\.adnxs|doubleclick/);
    assert.match(html, /Keep this content/);
    assert.match(html, /unrelated\.example\/tracker\.png/,
      'the policy must not silently remove unrelated external tracking');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit carbonads removal reports unmatched references instead of pretending success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-carbonads-incomplete-'));
  try {
    const liveDir = join(dir, 'live');
    mkdirSync(liveDir);
    writeFileSync(join(liveDir, 'index.html'), '<!doctype html><p>https://cdn.carbonads.com/missed.js</p>');
    const report = removeCarbonAds({ liveDir });
    assert.equal(report.status, 'incomplete');
    assert.equal(report.removedNodes, 0);
    assert.equal(report.remainingHtmlReferences, 1);
    assert.equal(report.failed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict export keeps carbonads blocked by default and supports explicit removal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-carbonads-export-'));
  const host = 'carbon-fixture.test';
  const site = join(dir, 'workspace', host);
  const html = '<!doctype html><html><body><main><p>Home</p></main>'
    + '<aside class="VPCarbonAds"><script id="_carbonads_js" src="https://cdn.carbonads.com/carbon.js"></script></aside>'
    + '</body></html>';
  mkdirSync(join(site, 'pages', 'home', 'clone'), { recursive: true });
  mkdirSync(join(site, 'live'), { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin: 'https://carbon-fixture.test' }));
  writeFileSync(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: 'https://carbon-fixture.test/' }));
  writeFileSync(join(site, 'pages', 'home', 'clone', 'index.html'), html);
  writeFileSync(join(site, 'live', 'index.html'), html);

  const run = (out, ...flags) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT, host, '--offline', '--strict', '--root', 'mirror', '--out', out, ...flags], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-20_000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-20_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, output }); });
  });

  try {
    const blocked = await run(join(dir, 'deliverable', 'blocked'));
    assert.equal(blocked.status, 1, blocked.output);
    const blockedCandidate = readdirSync(join(dir, 'deliverable'))
      .find(name => name.startsWith('.candidate-'));
    assert.ok(blockedCandidate, 'blocked candidate remains for diagnosis');
    const blockedHealth = JSON.parse(readFileSync(join(dir, 'deliverable', blockedCandidate, 'health.json'), 'utf8'));
    assert.equal(blockedHealth.thirdPartyServices.unsupportedRuntimeServices, 1);
    assert.equal(blockedHealth.thirdPartyServices.services[0].id, 'carbonads');
    assert.ok(blockedHealth.strictBlockers.unsupportedRuntimeServices > 0);

    const removed = await run(join(dir, 'deliverable', 'removed'), '--remove-carbonads');
    assert.equal(removed.status, 0, removed.output);
    const removedHealth = JSON.parse(readFileSync(join(dir, 'deliverable', 'removed', 'health.json'), 'utf8'));
    assert.equal(removedHealth.carbonAdsRemoval.status, 'removed');
    assert.equal(removedHealth.carbonAdsRemoval.remainingHtmlReferences, 0);
    assert.equal(removedHealth.thirdPartyServices.unsupportedRuntimeServices, 0);
    assert.equal(removedHealth.strictBlockers.unsupportedRuntimeServices, 0);
    assert.equal(removedHealth.strictBlockers.thirdPartyPolicyRemaining, 0);
    assert.doesNotMatch(readFileSync(join(dir, 'deliverable', 'removed', 'site', 'live', 'index.html'), 'utf8'), /carbonads/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'deliverable', 'removed', 'heimdall-live.json'), 'utf8')).carbonAdsPolicy, 'remove');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
