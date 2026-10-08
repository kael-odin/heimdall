/**
 * 设计 token 提取单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTokens, topEntries, buildTokensCss, renderTokensHtml } from '../src/extract/tokens.mjs';

const CSS = `
:root { --brand: #0f766e; --space: 8px; --radius: 6px; }
body { color: #0f766e; font-family: 'Inter', sans-serif; font-size: 16px; line-height: 1.5; }
.card { background: #ffffff; border-radius: 6px; padding: 8px 16px; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
a { color: #0f766e; font-size: 16px; font-weight: 600; }
h1 { font-size: 40px; color: #111827; padding: 16px 0; }
@media (max-width: 768px) { h1 { font-size: 28px; } }
`;

test('tokens: extracts variables, colors, typography and spacing with counts', () => {
  const t = extractTokens(CSS);
  assert.equal(t.variables['--brand'].value, '#0f766e');
  assert.ok(t.colors['#0f766e'] >= 2, 'brand color frequency');
  assert.ok(t.fontFamilies["'Inter', sans-serif"] >= 1);
  assert.ok(t.fontSizes['16px'] >= 2);
  assert.ok(t.spacings['8px'] >= 1);
  assert.ok(t.spacings['16px'] >= 2);
  assert.ok(t.radii['6px'] >= 1);
  assert.ok(Object.keys(t.shadows).length >= 1);
  assert.ok(Object.keys(t.breakpoints).length >= 1);
});

test('tokens: topEntries sorts by frequency then value', () => {
  const t = extractTokens(CSS);
  const top = topEntries(t.colors, 2, 1);
  assert.equal(top[0].value, '#0f766e');
});

test('tokens: buildTokensCss emits usable variables and keeps source variables', () => {
  const t = extractTokens(CSS);
  const css = buildTokensCss(t, { host: 'x.test' });
  assert.ok(css.includes(':root {'));
  assert.ok(css.includes('--hmd-color-1: #0f766e;'));
  assert.ok(css.includes('--hmd-space-'));
  assert.ok(css.includes('--src-brand: #0f766e;'));
});

test('tokens: renderTokensHtml contains swatches and host', () => {
  const html = renderTokensHtml('x.test', extractTokens(CSS));
  assert.ok(html.includes('x.test'));
  assert.ok(html.includes('#0f766e'));
  assert.ok(html.includes('设计 Token'));
});
