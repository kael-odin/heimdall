/**
 * fingerprint — 增量重克隆的判据
 *
 * 这里钉的是**判据的方向性**，因为判反了会静默丢更新（用户以为"没变"，
 * 实际站点改版了却还在看旧克隆）—— 比不做增量更糟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashContent, looksLikeShell, sourceFingerprint, incrementalDecision, decisionNote } from '../src/fingerprint.mjs';

// ---------- looksLikeShell ----------
test('shell: 有空壳特征的 SPA 骨架判为 shell', () => {
  const html = `<!doctype html><html><head><script src="/a.js"></script></head><body><div id="root"></div></body></html>`;
  assert.equal(looksLikeShell(html), true);
});

test('shell: 有正文的 SSR 页不是 shell', () => {
  const body = '这是一段足够长的正文内容。'.repeat(60);   // 720 字
  assert.equal(looksLikeShell(`<html><body><p>${body}</p></body></html>`), false);
});

test('shell: script/style 里的内容不计入正文', () => {
  const filler = 'x'.repeat(2000);
  const html = `<html><head><style>${filler}</style><script>/*${filler}*/</script></head><body><div id=root></div></body></html>`;
  assert.equal(looksLikeShell(html), true, '样式与脚本的字数不该冒充正文');
});

// ---------- sourceFingerprint ----------
const fakeRes = (body, headers = {}) => ({
  ok: true, status: 200,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});

test('fingerprint: 相同内容得到相同 hash', async () => {
  const f = (html) => (url, o) => sourceFingerprint(url, { ...o, fetchImpl: async () => fakeRes(html) });
  const a = await f('<html><body><p>hello world, this is a page</p></body></html>')('https://x.test/');
  const b = await f('<html><body><p>hello world, this is a page</p></body></html>')('https://x.test/');
  assert.equal(a.hash, b.hash);
  assert.equal(a.ok, true);
  assert.equal(a.status, 200);
  assert.equal(typeof a.bytes, 'number');
});

test('fingerprint: 内容变一个字符 hash 就变', async () => {
  const mk = (html) => sourceFingerprint('https://x.test/', { fetchImpl: async () => fakeRes(html) });
  const a = await mk('<p>版本一</p>'.repeat(80));
  const b = await mk('<p>版本二</p>'.repeat(80));
  assert.notEqual(a.hash, b.hash);
});

test('fingerprint: 抓取失败不抛，返回 ok:false', async () => {
  const r = await sourceFingerprint('https://x.test/', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(r.hash, undefined);
});

test('fingerprint: 超时会被 abort（fetchImpl 观察 signal）', async () => {
  let sawSignal = false;
  const r = await sourceFingerprint('https://x.test/', {
    timeoutMs: 10,
    fetchImpl: (url, o) => new Promise((_, rej) => {
      sawSignal = !!o.signal;
      o.signal.addEventListener('abort', () => rej(new Error('aborted')));
    }),
  });
  assert.equal(sawSignal, true, '必须把 signal 传给 fetch，否则超时形同虚设');
  assert.equal(r.ok, false);
});

// ---------- incrementalDecision（方向性）----------
const prevOf = (html, extra = {}) => ({ hash: hashContent(html), shell: false, etag: null, ...extra });

test('决策: 无历史指纹 → 重跑', () => {
  assert.deepEqual(incrementalDecision(null, { ok: true, hash: 'abc' }), { action: 'reforge', reason: 'no-fingerprint' });
});

test('决策: 内容未变 → 跳过', () => {
  const prev = prevOf('<p>same</p>');
  assert.deepEqual(incrementalDecision(prev, { ok: true, hash: prev.hash }), { action: 'keep', reason: 'unchanged' });
});

test('决策: 内容变了 → 重跑（这是最容易判反的一条）', () => {
  const prev = prevOf('<p>old</p>');
  assert.deepEqual(incrementalDecision(prev, { ok: true, hash: hashContent('<p>new</p>') }), { action: 'reforge', reason: 'changed' });
});

test('决策: 源站不可达 → 保留产物，不重跑（重跑也会失败）', () => {
  const prev = prevOf('<p>x</p>');
  assert.deepEqual(incrementalDecision(prev, { ok: false, status: 0 }), { action: 'keep', reason: 'unreachable' });
});

test('决策: 空壳站一律重跑，哪怕 hash 相同', () => {
  const prev = prevOf('<div id=root></div>', { shell: true });
  assert.deepEqual(incrementalDecision(prev, { ok: true, hash: prev.hash, shell: true }), { action: 'reforge', reason: 'shell' });
});

test('决策: ETag 相同即未变（即使 hash 因边角差异不同）', () => {
  const prev = { hash: 'aaa', etag: '"v1"', shell: false };
  assert.deepEqual(incrementalDecision(prev, { ok: true, hash: 'bbb', etag: '"v1"' }), { action: 'keep', reason: 'unchanged' });
});

test('决策: 每条 reason 都有中文解释', () => {
  for (const r of ['unchanged', 'changed', 'no-fingerprint', 'shell', 'unreachable']) {
    assert.ok(decisionNote(r).length > 3);
  }
});
