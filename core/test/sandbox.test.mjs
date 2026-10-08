/**
 * 沙盒单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectSandboxEdits, sandboxPaths, renderEditorPage } from '../src/sandbox/core.mjs';

test('sandbox: inject prints base and style into head', () => {
  const html = '<!doctype html><html><head><base href="/x/"><title>t</title></head><body>hi</body></html>';
  const out = injectSandboxEdits(html, 'body{background:#000}');
  assert.ok(out.includes('<base href="/clone/">'));
  assert.ok(!out.includes('href="/x/"'));
  assert.ok(out.includes('<style id="hmd-sandbox">'));
  assert.ok(out.indexOf('hmd-sandbox') < out.indexOf('</head>'));
});

test('sandbox: inject handles html without head', () => {
  const out = injectSandboxEdits('<body>x</body>', 'body{}');
  assert.ok(out.includes('<base href="/clone/">'));
  assert.ok(out.includes('hmd-sandbox'));
});

test('sandbox: paths and editor page render host/page', () => {
  const p = sandboxPaths('x.test', 'pricing');
  assert.ok(p.html.endsWith('sandbox.html'));
  const html = renderEditorPage({ host: 'x.test', page: 'pricing', port: 1 });
  assert.ok(html.includes('x.test / pricing'));
  assert.ok(html.includes('/api/diff'));
});
