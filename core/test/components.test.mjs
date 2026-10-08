/**
 * 组件抽取单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentCandidates, matchingCssRules, parseCssRules, renderComponentPreview, renderGallery } from '../src/extract/components.mjs';

const HTML = `<!doctype html><html><body>
<header class="site-header"><nav class="main-nav"><a href="/">Home</a><a href="/pricing">Pricing</a></nav></header>
<section class="hero"><h1>Ship faster</h1><p>Start at $19 / month with a deterministic workflow for everyone.</p><a class="btn btn-primary" href="/start">Start free</a></section>
<div class="pricing-grid"><div class="plan-card"><h3>Free</h3><p>$0</p><button class="btn">Choose</button></div><div class="plan-card"><h3>Team</h3><p>$19</p><button class="btn">Choose</button></div></div>
<details class="faq-item"><summary>Is it free?</summary><p>Yes, there is a free tier.</p></details>
<footer class="site-footer"><p>© Example</p></footer>
</body></html>`;

const CSS = `:root{--brand:#0f766e}
.hero{padding:60px;background:#f8fafc}.hero h1{font-size:44px}
.btn{border-radius:8px;background:var(--brand);color:#fff}
.plan-card{border:1px solid #e2e8f0;border-radius:10px}
.site-header{position:sticky;top:0}
@media (max-width:600px){.hero{padding:24px}}
.unrelated{color:red}`;

test('components: detects header/hero/pricing/faq/footer/cta from DOM', () => {
  const found = componentCandidates(HTML, { max: 20 });
  const names = new Set(found.map(c => c.name));
  for (const n of ['header', 'hero', 'pricing', 'faq', 'footer']) assert.ok(names.has(n), 'missing ' + n);
  assert.ok(found.some(c => c.name === 'cta'), 'missing cta');
  assert.ok(found.every(c => c.html && c.bytes > 0));
});

test('components: nested same-name candidates are deduped (outer kept)', () => {
  const nested = '<div class="nav-wrapper"><nav class="main-nav"><a href="/">x</a></nav></div><p>hello world content</p>';
  const found = componentCandidates(nested, { minText: 1 }).filter(c => c.name === 'header');
  assert.equal(found.length, 1);
  assert.ok(found[0].html.includes('main-nav'));
});

test('components: css rule matcher keeps :root, element rules and media queries', () => {
  const rules = parseCssRules(CSS);
  assert.ok(rules.length >= 6);
  const m = matchingCssRules(CSS, { classes: ['hero'], tag: 'section' });
  assert.ok(m.css.includes(':root'));
  assert.ok(m.css.includes('.hero{padding:60px'));
  assert.ok(m.css.includes('@media (max-width:600px)'));
  assert.ok(!m.css.includes('.unrelated'));
  assert.ok(!m.css.includes('.plan-card'));
});

test('components: preview and gallery render component content', () => {
  const c = componentCandidates(HTML, { max: 20 }).find(x => x.name === 'hero');
  const m = matchingCssRules(CSS, c);
  const preview = renderComponentPreview(c, m.css, { host: 'x.test' });
  assert.ok(preview.includes('Ship faster'));
  assert.ok(preview.includes('.hero{padding:60px'));
  const gallery = renderGallery('x.test', [{ ...c, file: 'home-hero.html', matchedRules: m.rules }]);
  assert.ok(gallery.includes('home-hero.html'));
  assert.ok(gallery.includes('x.test'));
});
