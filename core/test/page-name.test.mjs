import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafePageName, assertPageName } from '../src/page-name.mjs';
import { sandboxPaths } from '../src/sandbox/core.mjs';
import { snapPage } from '../src/crawler/multi-snapshot.mjs';

test('page names accept existing single-directory forms and reject path aliases', () => {
  for (const name of ['home', 'pricing--d838e883', 'old.page', '旧版 页面', ' leading']) {
    assert.equal(isSafePageName(name), true, name);
    assert.equal(assertPageName(name), name);
  }
  for (const name of ['', ' ', '.', '..', '../escape', '..\\escape', '/tmp', 'C:\\temp',
    'foo/bar', 'foo\\bar', 'foo.', 'foo ', 'CON', 'LPT1.txt', 'bad\0name', 'bad\nname']) {
    assert.equal(isSafePageName(name), false, JSON.stringify(name));
    assert.throws(() => assertPageName(name), error => error.code === 'invalid-page-name');
    assert.throws(() => sandboxPaths('fixture.test', name), error => error.code === 'invalid-page-name');
  }
});

test('imported multi-snapshot writer validates page before locating manifest', async () => {
  await assert.rejects(snapPage(null, 'fixture.test', '../escape'),
    error => error.code === 'invalid-page-name');
});
