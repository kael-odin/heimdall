/**
 * store/cas 单测：重复文件 → CAS + 硬链接，内容不变
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dedupeTree, casPath, sha256File } from '../src/store/cas.mjs';

test('cas: dedupeTree links duplicates and preserves content', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-cas-'));
  const store = join(root, '_cas');
  const a = join(root, 'a'); const b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  const payload = Buffer.from('same-content-'.repeat(100));
  writeFileSync(join(a, 'x.bin'), payload);
  writeFileSync(join(b, 'y.bin'), payload);
  writeFileSync(join(a, 'unique.bin'), Buffer.from('unique-content'));

  const ledger = dedupeTree(root, store, { skip: ['_cas'] });
  assert.equal(ledger.files, 3);
  assert.equal(ledger.unique, 2);
  assert.equal(ledger.duplicates, 1);
  assert.ok(ledger.bytesSaved >= payload.length, 'should report saved bytes');
  assert.equal(readFileSync(join(a, 'x.bin')).equals(payload), true);
  assert.equal(readFileSync(join(b, 'y.bin')).equals(payload), true);

  const hash = sha256File(join(a, 'x.bin'));
  assert.ok(casPath(store, hash, '.bin').includes(hash), 'CAS path uses sha256');
  const nlink = statSync(join(b, 'y.bin')).nlink;
  assert.ok(nlink >= 2, 'duplicate should be a hard link (nlink=' + nlink + ')');
  rmSync(root, { recursive: true, force: true });
});
