import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const BUILD = join(CORE, 'src', 'crawler', 'build_live.mjs');

function put(root, relative, value) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

test('live build removes Cloudflare Insights beacon but preserves other external scripts', () => {
  const data = mkdtempSync(join(tmpdir(), 'heimdall-live-tracking-'));
  const siteId = 'fixture.test';
  const site = join(data, 'workspace', siteId);
  try {
    const page = join(site, 'pages', 'home');
    put(page, 'manifest.json', JSON.stringify({ target: 'https://fixture.test/' }));
    put(page, 'dom.html', '<!doctype html><html><head></head><body>'
      + '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v4" data-cf-beacon="{}"></script>'
      + '<script src="https://cdn.example.net/app.js"></script>'
      + '<script src="https://cdn.example.net/beacon.min.js"></script>'
      + '</body></html>');

    const result = spawnSync(process.execPath, [BUILD, siteId], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: data, HEIMDALL_SELF_URL: 'http://127.0.0.1:1' },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const html = readFileSync(join(site, 'live', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /static\.cloudflareinsights\.com\/beacon\.min\.js/);
    assert.match(html, /<!-- heimdall: widget script stripped -->/);
    assert.match(html, /<script src="https:\/\/cdn\.example\.net\/app\.js"><\/script>/);
    assert.match(html, /<script src="https:\/\/cdn\.example\.net\/beacon\.min\.js"><\/script>/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
