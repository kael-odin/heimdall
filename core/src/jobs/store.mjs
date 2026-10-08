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
