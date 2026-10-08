/**
 * 浏览器书签入口单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBookmarklet, renderInstallPage, MODES } from '../src/browser/bookmarklet.mjs';

test('bookmarklet: builds valid javascript: URLs for every mode', () => {
  for (const mode of Object.keys(MODES)) {
    const bm = buildBookmarklet(mode, { api: 'http://127.0.0.1:8900', token: 'sec' });
    assert.ok(bm.startsWith('javascript:'), mode + ' should be a javascript: URL');
    const code = decodeURIComponent(bm.replace(/^javascript:/, ''));
    assert.ok(code.includes('location.href'), mode + ' must use the current page URL');
    assert.ok(code.includes(MODES[mode].path), mode + ' must call ' + MODES[mode].path);
    assert.ok(code.includes('token=sec'), mode + ' must carry the token');
    assert.ok(code.includes('no-cors'), mode + ' must use a simple request');
  }
});

test('bookmarklet: install page renders draggable links and api', () => {
  const html = renderInstallPage({ api: 'http://10.0.0.5:8900', token: '' });
  assert.ok(html.includes('http://10.0.0.5:8900'));
  assert.ok((html.match(/draggable="true"/g) || []).length >= 4);
  assert.ok(html.includes('Heimdall 克隆此页'));
});
