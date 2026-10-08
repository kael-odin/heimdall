/**
 * jobs/store 单测：SQLite 与 JSON 两种实现都能持久化，重启后 running → interrupted
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openJobStore, recoverInterrupted } from '../src/jobs/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'heimdall-jobs-'));

for (const forceJson of [false, true]) {
  const label = forceJson ? 'json' : 'sqlite';
  test(`jobs(${label}): upsert/list/events persist across reopen`, () => {
    const dir = tmp();
    const path = join(dir, 'jobs' + (forceJson ? '.json' : '.db'));
    let store = openJobStore(path, { forceJson });
    store.upsert({ id: 'f1', kind: 'forge', url: 'https://x.test/a', status: 'running', pageName: 'a', createdAt: 1000 });
    store.appendEvent('f1', { kind: 'forge-stage', stage: 'capture' });
    store.appendEvent('f1', { kind: 'exit', status: 'done' });
    store.upsert({ id: 'f1', kind: 'forge', url: 'https://x.test/a', status: 'done', pageName: 'a', createdAt: 1000, endedAt: 2000 });
    assert.equal(store.get('f1').status, 'done');
    assert.equal(store.events('f1').length, 2);
    store.close();

    store = openJobStore(path, { forceJson });
    const jobs = store.list({ limit: 10 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'done');
    assert.equal(jobs[0].url, 'https://x.test/a');
    assert.equal(store.events('f1')[0].data.stage, 'capture');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test(`jobs(${label}): recoverInterrupted marks stale running jobs`, () => {
    const dir = tmp();
    const path = join(dir, 'jobs' + (forceJson ? '.json' : '.db'));
    const store = openJobStore(path, { forceJson });
    store.upsert({ id: 'r1', kind: 'recon', url: 'https://x.test', status: 'running', createdAt: 1 });
    assert.equal(recoverInterrupted(store), 1);
    assert.equal(store.get('r1').status, 'interrupted');
    assert.equal(recoverInterrupted(store), 0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}
