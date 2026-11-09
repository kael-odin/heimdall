import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Public, self-signed test certificate and key, never used outside this fixture.
const certificate = `-----BEGIN CERTIFICATE-----
MIIBfjCCASOgAwIBAgIUW5VSgBLDKW3z0XlEuCKvQB5VivkwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEwOTIxNTgzOVoXDTM2MTEwNjIx
NTgzOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEdx95QGN9Keup7u6kJ0eSXb4W1MMOLfIfXrecWU1k8bwG39RujIWuTE4X
U8AzW9G5ysCGiOTsGkUSXtKDpPJsMaNTMFEwHQYDVR0OBBYEFL98UGb51YInv8hT
k5+bufNDjPmTMB8GA1UdIwQYMBaAFL98UGb51YInv8hTk5+bufNDjPmTMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAOVXTsNSfmZqoRYomIPr37K2
lbjIttQZ4SMe/LRHrxh8AiEA3dAKdtLwicTXzfnzZ+OwZH57aJ+km5YZnXQzA0BH
zj4=
-----END CERTIFICATE-----`;
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg8SXuHLwPjsR651av
L2IcCmrorE3J4K/HwIhhT+nNucKhRANCAAR3H3lAY30p66nu7qQnR5JdvhbUww4t
8h9et5xZTWTxvAbf1G6Mha5MThdTwDNb0bnKwIaI5OwaRRJe0oOk8mwx
-----END PRIVATE KEY-----`;

test('invalid HTTPS certificates block session reuse in SEO and interaction verification', { timeout: 45_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-certificate-'));
  const previousRoot = process.env.HEIMDALL_DATA_DIR;
  process.env.HEIMDALL_DATA_DIR = root;
  const sessionDir = join(root, 'workspace', '127.0.0.1');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    cookies: [{ name: 'fixture', value: 'fake', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
  }));
  let requests = 0;
  let authenticated = 0;
  const server = createServer({ key, cert: certificate }, (req, res) => {
    requests++;
    if ((req.headers.cookie ?? '').includes('fixture=')) authenticated++;
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>fixture</title></head><body><button>Test</button></body></html>');
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (previousRoot === undefined) delete process.env.HEIMDALL_DATA_DIR;
    else process.env.HEIMDALL_DATA_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();

  const { collectPage } = await import('../src/seo/collect.mjs');
  const { verifyInteractions, scoreInteractions } = await import('../src/verify/interactions.mjs');
  const url = `https://127.0.0.1:${server.address().port}/`;
  const page = await collectPage(browser, url, { settleMs: 10 });
  assert.equal(page.ok, false, 'SEO must not treat an invalid certificate as a successful capture');
  assert.equal(page.status, 0);
  assert.match(page.error, /ERR_CERT/i);
  const interactions = await verifyInteractions(browser, { sourceUrl: url, cloneUrl: url, max: 1 });
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].unverified, true);
  assert.match(interactions[0].error, /ERR_CERT/i);
  assert.equal(scoreInteractions(interactions), null, 'an unavailable source cannot produce an interaction score');
  assert.equal(requests, 0, 'the invalid certificate must prevent HTTP requests');
  assert.equal(authenticated, 0, 'the fixture session must not reach the server');
});
