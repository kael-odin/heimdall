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

  /**
   * 保留策略。两张表原先只增不删，界面上却只看得到最近 50 条 ——
   * "看不到的那部分"就一直在磁盘上长。这里钉住"有界"这件事本身，
   * 尤其是**事件要跟着任务一起走**：只删 jobs 不删 events 等于没裁。
   */
  test(`jobs(${label}): prune 只留最近 keep 个任务，事件跟着一起删`, () => {
    const dir = tmp();
    const path = join(dir, 'jobs' + (forceJson ? '.json' : '.db'));
    const store = openJobStore(path, { forceJson });
    for (let i = 1; i <= 7; i++) {
      store.upsert({ id: 'j' + i, kind: 'forge', url: 'https://x.test/' + i, status: 'done', createdAt: i * 1000, endedAt: i * 1000 + 500 });
      store.appendEvent('j' + i, { kind: 'exit', status: 'done' });
    }
    assert.equal(store.prune({ keep: 3 }), 4, '超出 3 条的 4 个任务应被删掉');
    assert.deepEqual(store.list({ limit: 50 }).map(j => j.id).sort(), ['j5', 'j6', 'j7'], '留下的必须是最新的三个');
    assert.equal(store.events('j1').length, 0, '被裁掉的任务，它的事件也要跟着走 —— 否则 events 表照样无限长');
    assert.equal(store.events('j7').length, 1, '留下的任务事件不能丢');
    assert.equal(store.prune({ keep: 3 }), 0, '没超限时什么都不删');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}
