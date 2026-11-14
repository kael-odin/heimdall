import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobManager } from '../src/agent/jobs.mjs';
import { nextForJob } from '../src/agent/registry/capabilities/jobs.mjs';

test('failed staged jobs retain the capability result for partial coverage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-agent-jobs-'));
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/stage') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ taskId: 't-1' }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"kind":"exit","code":1,"status":"failed"}\n\n');
      return;
    }
    if (req.method === 'GET' && req.url === '/api/jobs') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jobs: [{ id: 't-1', status: 'failed' }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  const jobs = createJobManager({
    selfBase: () => `http://127.0.0.1:${address.port}`,
    token: () => '',
    storePath: join(dir, 'jobs.json'),
  });
  const { job } = jobs.create({
    capability: 'clone',
    args: { url: 'https://example.test/' },
    plan: [{ name: 'verify', route: '/stage', body: {} }],
    finish: async () => ({ siteId: 'example.test', coverage: { measured: 7, unmeasured: 1 } }),
  });
  const settled = (await jobs.wait(job.jobId, 2_000)).job;
  assert.equal(settled.status, 'failed');
  assert.deepEqual(settled.result.coverage, { measured: 7, unmeasured: 1 });
  assert.equal(nextForJob(settled)[0].tool, 'heimdall_site');
});
