import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireAcceptanceOwner, assertAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { ACCEPTANCE_ROOT, ACCEPTANCE_SNAPSHOT_LIMITS } from '../src/acceptance/constants.mjs';
import * as store from '../src/acceptance/store.mjs';

test('only an acquired live owner passes the private writer capability check', t => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-owner-capability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = acquireAcceptanceOwner({ root }); t.after(() => owner.release());
  assert.equal(assertAcceptanceOwner(owner), true);
  let calls = 0;
  const fake = { root, assertOwned() { calls++; return true; } };
  const proxy = new Proxy(owner, { get() { calls++; throw Error('unexpected accessor'); } });
  for (const value of [fake, { ...owner }, proxy, null, undefined, 1]) {
    assert.throws(() => assertAcceptanceOwner(value), { code: 'ACCEPTANCE_OWNER_UNAVAILABLE' });
  }
  assert.equal(calls, 0);
  owner.release(); assert.throws(() => assertAcceptanceOwner(owner), { code: 'ACCEPTANCE_OWNER_LOST' });
});

test('store retains the shared constants and legacy export identities', () => {
  assert.equal(store.ACCEPTANCE_ROOT, ACCEPTANCE_ROOT);
  assert.equal(store.ACCEPTANCE_SNAPSHOT_LIMITS, ACCEPTANCE_SNAPSHOT_LIMITS);
  assert.equal(Object.isFrozen(ACCEPTANCE_SNAPSHOT_LIMITS), true);
});
