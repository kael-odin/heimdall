import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStaticHtml, staticCloneChooserHtml } from '../src/static-html-safety.mjs';

test('static chooser references only present variants for every partial set', () => {
  const sets = [[375], [768], [1440], [375, 768], [375, 1440], [768, 1440], [375, 768, 1440]];
  for (const widths of sets) {
    const html = staticCloneChooserHtml(widths);
    const referenced = [...html.matchAll(/index-(375|768|1440)\.html/g)].map(match => Number(match[1]));
    assert.ok(referenced.length >= 4);
    assert.ok(referenced.every(width => widths.includes(width)), `${widths}: ${referenced}`);
    assert.match(html, /<noscript><meta http-equiv="refresh"/);
  }
});

test('static chooser rejects unknown or missing widths', () => {
  assert.throws(() => staticCloneChooserHtml([]), /known, available/);
  assert.throws(() => staticCloneChooserHtml([375, 999]), /known, available/);
  assert.throws(() => staticCloneChooserHtml(), /requires available/);
});

test('tablet falls back to desktop when only mobile and desktop snapshots exist', () => {
  const html = staticCloneChooserHtml([375, 1440]);
  assert.match(html, /innerWidth<=600\?"index-375\.html":innerWidth<=1100\?"index-1440\.html"/);
});

test('static form neutralization also covers templates and is idempotent', () => {
  const html = '<form id="f" action="https://fixture.test/submit" method="post"><input></form>'
    + '<button form="f" formaction="https://fixture.test/other" formmethod="get">Send</button>'
    + '<template><form action="https://fixture.test/template"><input></form></template>';
  const cleaned = sanitizeStaticHtml(html);
  assert.equal(sanitizeStaticHtml(cleaned), cleaned);
  assert.equal((cleaned.match(/action="about:blank"/g) ?? []).length, 2);
  assert.equal((cleaned.match(/method="dialog"/g) ?? []).length, 2);
  assert.equal((cleaned.match(/inert=""/g) ?? []).length, 3);
  assert.doesNotMatch(cleaned, /fixture\.test|formaction|formmethod/);
});
