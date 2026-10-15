import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replaceYouTubeEmbeds } from '../src/live/youtube-placeholder.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

test('youtube placeholders replace embeds but preserve outbound links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-youtube-unit-'));
  try {
    const liveDir = join(dir, 'live');
    mkdirSync(liveDir);
    writeFileSync(join(liveDir, 'index.html'), '<!doctype html><body>'
      + '<iframe src="https://www.youtube-nocookie.com/embed/private-video?token=hidden" '
      + 'width="560" height="315" title="Demo video" allowfullscreen></iframe>'
      + '<a href="https://www.youtube.com/watch?v=private-video">Watch on YouTube</a>'
      + '</body>');
    const report = replaceYouTubeEmbeds({ liveDir });
    assert.equal(report.status, 'replaced');
    assert.equal(report.files, 1);
    assert.equal(report.replacements, 1);
    assert.equal(report.remainingEmbeds, 0);
    assert.equal(report.failed, 0);
    const html = readFileSync(join(liveDir, 'index.html'), 'utf8');
    assert.match(html, /data-heimdall-youtube-placeholder="1"/);
    assert.match(html, /width:560px;/);
    assert.match(html, /aria-label="Demo video"/);
    assert.doesNotMatch(html, /youtube-nocookie\.com\/embed/);
    assert.match(html, /https:\/\/www\.youtube\.com\/watch\?v=private-video/,
      'ordinary outbound links remain user-controlled navigation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict export blocks YouTube by default and supports explicit placeholders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-youtube-export-'));
  const host = 'youtube-fixture.test';
  const site = join(dir, 'workspace', host);
  const html = '<!doctype html><html><body><main><p>Home</p></main>'
    + '<iframe src="https://www.youtube-nocookie.com/embed/demo" width="560" height="315" title="Demo"></iframe>'
    + '</body></html>';
  mkdirSync(join(site, 'pages', 'home', 'clone'), { recursive: true });
  mkdirSync(join(site, 'live'), { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin: 'https://youtube-fixture.test' }));
  writeFileSync(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: 'https://youtube-fixture.test/' }));
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
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    const blockedHealth = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(blockedHealth.thirdPartyServices.unsupportedRuntimeServices, 1);
    assert.equal(blockedHealth.thirdPartyServices.services[0].id, 'youtube');
    assert.ok(blockedHealth.strictBlockers.unsupportedRuntimeServices > 0);

    const replaced = await run(join(dir, 'deliverable', 'replaced'), '--replace-youtube');
    assert.equal(replaced.status, 0, replaced.output);
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', 'replaced', 'health.json'), 'utf8'));
    assert.equal(health.youtubePlaceholder.status, 'replaced');
    assert.equal(health.youtubePlaceholder.remainingEmbeds, 0);
    assert.equal(health.thirdPartyServices.unsupportedRuntimeServices, 0);
    assert.equal(health.strictBlockers.externalAssets, 0);
    assert.equal(health.strictBlockers.thirdPartyPolicyRemaining, 0);
    assert.match(readFileSync(join(dir, 'deliverable', 'replaced', 'site', 'live', 'index.html'), 'utf8'),
      /data-heimdall-youtube-placeholder="1"/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'deliverable', 'replaced', 'heimdall-live.json'), 'utf8')).youtubePolicy, 'placeholder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
