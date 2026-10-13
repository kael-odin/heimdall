/**
 * jobs/store — 任务与事件的持久化存储
 *
 * 主实现：Node 内置 node:sqlite（零依赖，WAL）。旧版 Node 或显式
 * HEIMDALL_JOBS_FORCE_JSON=1 时降级为原子写 JSON 文件，接口一致。
 *
 * 用途：引擎重启后任务历史/事件不丢；上次崩溃时 running 的任务可标记为 interrupted。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * 任务历史的保留条数。
 *
 * jobs / events 两张表原先**只增不删**：每跑一次克隆就多几行 + 十几条事件，
 * 一台长期开着的引擎会把 jobs.db 一直撑大（实测这台机器上 241 个任务 / 6836 条事件
 * 已经 1.4MB，而这是从 9 月底到现在断断续续用的量）。界面上又只看得到最近 50 条，
 * 所以"看不到的那部分"在磁盘上一直长。
 *
 * 500 条远大于界面用得上的量，纯粹当上限用 —— 目的是"有界"，不是"省空间"。
 */
export const DEFAULT_KEEP_JOBS = 500;

function openSqlite(path) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT, url TEXT, status TEXT, page_name TEXT,
      created_at INTEGER, ended_at INTEGER, payload TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, ts INTEGER, data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
  `);
  return new SqliteJobStore(db);
}

class SqliteJobStore {
  constructor(db) { this.db = db; this.kind = 'sqlite'; }
  upsert(job) {
    this.db.prepare(`INSERT INTO jobs (id, kind, url, status, page_name, created_at, ended_at, payload, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, ended_at=excluded.ended_at, page_name=excluded.page_name, payload=excluded.payload, error=excluded.error`)
      .run(job.id, job.kind ?? '', job.url ?? '', job.status ?? 'running', job.pageName ?? null, job.createdAt ?? Date.now(), job.endedAt ?? null, job.payload ? JSON.stringify(job.payload) : null, job.error ?? null);
  }
  appendEvent(jobId, ev) {
    this.db.prepare('INSERT INTO events (job_id, ts, data) VALUES (?, ?, ?)').run(jobId, Date.now(), JSON.stringify(ev));
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? mapRow(row) : null;
  }
  list({ limit = 50 } = {}) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(mapRow);
  }
  events(jobId, { limit = 500 } = {}) {
    return this.db.prepare('SELECT ts, data FROM events WHERE job_id = ? ORDER BY id ASC LIMIT ?').all(jobId, limit)
      .map(r => ({ ts: r.ts, data: JSON.parse(r.data) }));
  }
  /** 只留最近 keep 个任务，连同它们的事件一起删。返回删掉的任务数。 */
  prune({ keep = DEFAULT_KEEP_JOBS } = {}) {
    const ids = this.db.prepare('SELECT id FROM jobs ORDER BY created_at DESC').all().map(r => r.id).slice(keep);
    if (!ids.length) return 0;
    const delEvents = this.db.prepare('DELETE FROM events WHERE job_id = ?');
    const delJob = this.db.prepare('DELETE FROM jobs WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) { delEvents.run(id); delJob.run(id); }
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
    return ids.length;
  }
  close() { try { this.db.close(); } catch {} }
}

function mapRow(row) {
  return {
    id: row.id, kind: row.kind, url: row.url, status: row.status,
    pageName: row.page_name ?? null, createdAt: row.created_at, endedAt: row.ended_at ?? null,
    payload: row.payload ? JSON.parse(row.payload) : null, error: row.error ?? null,
  };
}

function openJson(path) {
  const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { jobs: {}, events: {} };
  return new JsonJobStore(path, data);
}

class JsonJobStore {
  constructor(path, data) { this.path = path; this.data = data ?? { jobs: {}, events: {} }; this.kind = 'json'; }
  persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
  upsert(job) { this.data.jobs[job.id] = { ...(this.data.jobs[job.id] ?? {}), ...job }; this.persist(); }
  appendEvent(jobId, ev) {
    const list = (this.data.events[jobId] ??= []);
    list.push({ ts: Date.now(), data: ev });
    if (list.length > 2000) list.splice(0, list.length - 1000);
    this.persist();
  }
  get(id) { return this.data.jobs[id] ?? null; }
  list({ limit = 50 } = {}) { return Object.values(this.data.jobs).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, limit); }
  events(jobId, { limit = 500 } = {}) { return (this.data.events[jobId] ?? []).slice(0, limit); }
  /** 与 SqliteJobStore.prune 同一套语义：只留最近 keep 个任务。 */
  prune({ keep = DEFAULT_KEEP_JOBS } = {}) {
    const jobs = Object.values(this.data.jobs).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const drop = jobs.slice(keep);
    if (!drop.length) return 0;
    for (const j of drop) { delete this.data.jobs[j.id]; delete this.data.events[j.id]; }
    this.persist();
    return drop.length;
  }
  close() {}
}

export function openJobStore(path, { forceJson = process.env.HEIMDALL_JOBS_FORCE_JSON === '1' } = {}) {
  if (!forceJson) {
    try { return openSqlite(path); }
    catch (e) { console.warn('[jobs] sqlite unavailable, falling back to JSON:', String(e).slice(0, 120)); }
  }
  return openJson(path);
}

/** 启动时把上次进程遗留的 running 任务标记为 interrupted，返回数量 */
export function recoverInterrupted(store) {
  let n = 0;
  for (const job of store.list({ limit: 500 })) {
    if (job.status === 'running' || job.status === 'queued') { store.upsert({ ...job, status: 'interrupted', endedAt: Date.now(), error: job.error ?? 'engine restarted while running' }); n++; }
  }
  return n;
}
