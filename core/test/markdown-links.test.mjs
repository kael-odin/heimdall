import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkMarkdownLinks, isLocalRelativeTarget, scanMarkdownText } from '../scripts/check-markdown-links.mjs';

test('markdown link checker scans real links and ignores prose examples', () => {
  const source = 'C:/repo/docs/guide.md';
  const text = [
    '[inline](../README.md)',
    '[external](https://example.com/docs)',
    '[anchor](#section)',
    '`[inline code](missing.md)`',
    '[reference][guide]',
    '[guide]: ../USAGE.md',
    '<img src="../assets/readme/hero.svg">',
    '<a href="../PRD.md">PRD</a>',
    '```md',
    '[fenced](missing.md)',
    '```',
  ].join('\n');

  const records = scanMarkdownText(text, source);
  const local = records.filter((record) => isLocalRelativeTarget(record.target));
  assert.deepEqual(local.map((record) => record.target), [
    '../README.md',
    '../USAGE.md',
    '../assets/readme/hero.svg',
    '../PRD.md',
  ]);
  assert.equal(records.some((record) => record.target === 'missing.md'), false);
});

test('markdown link checker does not treat URL schemes or root paths as repository files', () => {
  assert.equal(isLocalRelativeTarget('https://example.com'), false);
  assert.equal(isLocalRelativeTarget('mailto:docs@example.com'), false);
  assert.equal(isLocalRelativeTarget('#section'), false);
  assert.equal(isLocalRelativeTarget('/docs/README.md'), false);
  assert.equal(isLocalRelativeTarget('../docs/README.md'), true);
});

test('markdown link checker reports missing current targets and skips archive and runtime output', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-doc-links-'));
  try {
    mkdirSync(join(root, 'docs', 'archive'), { recursive: true });
    mkdirSync(join(root, 'core', 'assets-cas'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '[exists](USAGE.md) [missing](LOST.md)');
    writeFileSync(join(root, 'USAGE.md'), '# usage');
    writeFileSync(join(root, 'docs', 'archive', 'old.md'), '[old](missing.md)');
    writeFileSync(join(root, 'core', 'assets-cas', 'cached.md'), '[cached](missing.md)');

    const result = checkMarkdownLinks(root);
    assert.equal(result.checked, 2);
    assert.deepEqual(result.broken.map((record) => record.target), ['LOST.md']);
    assert.equal(result.files.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
