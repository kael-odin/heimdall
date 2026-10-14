import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const FONT = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(28, 7)]);
const image = new PNG({ width: 2, height: 2 });
image.data.fill(255);
const IMAGE = PNG.sync.write(image);

function runCapture(url, out, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/crawler/capture.mjs', url, out], { cwd: CORE, env });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, log }));
  });
}

test('capture downloads session-protected assets without sending site cookies to another origin', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-auth-assets-'));
  const siteDir = join(root, 'workspace', '127.0.0.1');
  const out = join(root, 'capture');
  const seen = { private: [], other: [] };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    const cookie = req.headers.cookie ?? '';
    const respond = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    };
    if (path === '/') {
      const other = `http://localhost:${server.address().port}/other.png`;
      return respond(200, 'text/html', `<!doctype html><html><head>
        <meta property="og:image" content="/private.png">
        <meta name="twitter:image" content="${other}">
        <link rel="preload" href="/private.woff2" as="font" type="font/woff2" crossorigin>
        </head><body><button>Accept</button><img data-src="/missing.png"></body></html>`);
    }
    if (path === '/private.png' || path === '/private.woff2') {
      seen.private.push({ path, cookie });
      if (!cookie.includes('sid=authorized')) return respond(401, 'text/plain', 'login required');
      return respond(200, path.endsWith('.png') ? 'image/png' : 'font/woff2', path.endsWith('.png') ? IMAGE : FONT);
    }
    if (path === '/other.png') {
      seen.other.push(cookie);
      return respond(200, 'image/png', IMAGE);
    }
    if (path === '/missing.png') return respond(200, 'text/html', '<!doctype html><title>not found</title>');
    return respond(404, 'text/plain', 'not found');
  });
  try {
    await new Promise(resolve => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'session.json'), JSON.stringify({
      cookies: [{ name: 'sid', value: 'authorized', domain: '127.0.0.1', path: '/', expires: -1,
        httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [],
    }));
    writeFileSync(join(siteDir, 'site.json'), JSON.stringify({ capture: { scrollSweep: false, settleMs: 0 } }));

    const result = await runCapture(origin + '/', out, {
      ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_LLM: '0', HEIMDALL_ASSET_TIMEOUT_MS: '5000',
    });
    assert.equal(result.code, 0, result.log);

    const map = JSON.parse(readFileSync(join(out, 'asset-map.json'), 'utf8'));
    for (const [url, signature] of [[`${origin}/private.png`, IMAGE], [`${origin}/private.woff2`, FONT]]) {
      const local = map.resMap[url];
      assert.ok(local, `protected asset missing from map: ${url}\n${result.log}`);
      assert.deepEqual(readFileSync(join(out, local)), signature);
    }
    assert.ok(map.resMap[`http://localhost:${server.address().port}/other.png`]);
    assert.ok(seen.private.some(item => item.path === '/private.png' && item.cookie.includes('sid=authorized')));
    assert.ok(seen.private.some(item => item.path === '/private.woff2' && item.cookie.includes('sid=authorized')));
    assert.ok(seen.other.length > 0, 'cross-origin resource must be requested');
    assert.ok(seen.other.every(cookie => !cookie.includes('sid=authorized')), 'site cookie leaked to localhost origin');
    assert.equal(map.resMap[`${origin}/missing.png`], undefined);
    const gaps = JSON.parse(readFileSync(join(out, 'gaps.json'), 'utf8'));
    assert.ok(gaps.failed.some(item => item.url === `${origin}/missing.png` && item.error.includes('soft-404')));
    assert.equal(existsSync(join(out, 'session.json')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
