import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ENGINE = fileURLToPath(new URL('../../../core/src/engine-server.mjs', import.meta.url));
const PROXY = fileURLToPath(new URL('../../../plugin/server/heimdall-mcp.mjs', import.meta.url));

test('bundled MCP proxy forwards response checks to a fresh isolated engine', { timeout: 90_000 }, async () => {
  let queries = 0;
  let requestMethod = 'POST';
  const methods = [];
  const fixture = createServer((req, res) => {
    if (req.url === '/blank' || req.url === '/page') {
      res.setHeader('content-type', 'text/html');
      return res.end(req.url === '/blank' ? '<title>Blank</title>'
        : `<title>Page</title><div id="ready" hidden>Ready</div><script>fetch("/api/list",{method:"${requestMethod}"}).then(()=>document.querySelector("#ready").hidden=false)</script>`);
    }
    if (req.url === '/api/list' && ['POST', 'PATCH'].includes(req.method)) {
      queries++;
      methods.push(req.method);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ code: 0, total: 2, private: 'proxy-fixture-private-do-not-record' }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-mcp-response-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({ sites: { web: { url: origin,
    writes: { allow: [{ method: 'POST', origin, path: '/api/list' }] } } }, defaults: { settleMs: 100, timeoutMs: 5000 } }));
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const api = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_API: api, HEIMDALL_HOST: '127.0.0.1',
    HEIMDALL_TOKEN: '', HEIMDALL_PSI_KEY: '', HEIMDALL_JOBS_DB: join(root, 'jobs.db') };
  const engine = spawn(process.execPath, [ENGINE, String(port)], { env, stdio: 'ignore', windowsHide: true });
  let client;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (engine.exitCode !== null) throw new Error(`engine exited: ${engine.exitCode}`);
      try { ready = (await fetch(api + '/api/status', { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'isolated engine should start');
    client = new Client({ name: 'heimdall-response-proxy', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [PROXY], env }));
    assert.match(client.getInstructions(), /state-changing/);
    const { tools } = await client.listTools();
    for (const id of ['clone', 'seo_audit', 'seo_matrix', 'site_watch', 'qa_run', 'qa_ci']) {
      const tool = tools.find(item => item.name === `heimdall_${id}`);
      assert.equal(tool?.annotations.destructiveHint, true, id);
      assert.equal(tool.annotations.idempotentHint, false, id);
      if (id.startsWith('qa_')) assert.deepEqual(tool.inputSchema.properties.checks.items.properties.responses.items.properties.method.enum,
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    }
    const check = { title: 'List response', path: '/page', steps: [{ action: 'waitFor', selector: '#ready' }],
      expect: [{ kind: 'visible', selector: '#ready' }],
      responses: [{ method: 'POST', origin, path: '/api/list', json: [{ path: ['code'], equals: 0 }, { path: ['total'], equals: 2 }] }] };
    const args = { workspace: root, site: 'web', pages: ['/blank'], viewports: [1280], linkCheck: false,
      detect: false, baseline: false, checks: [check] };
    const ok = await client.callTool({ name: 'heimdall_qa_run', arguments: args });
    assert.equal(ok.isError, false, JSON.stringify(ok.structuredContent.error));
    assert.equal(ok.structuredContent.result.checks[0].responses[0].state, 'matched');
    assert.doesNotMatch(JSON.stringify(ok.structuredContent), /proxy-fixture-private-do-not-record/);
    requestMethod = 'PATCH';
    writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({ sites: { web: { url: origin, writes: 'allow' } },
      defaults: { settleMs: 100, timeoutMs: 5000 } }));
    const mismatch = { ...check, responses: [{ ...check.responses[0], method: 'PATCH', json: [{ path: ['code'], equals: 0 }, { path: ['total'], equals: 3 }] }] };
    const failed = await client.callTool({ name: 'heimdall_qa_ci', arguments: { ...args, checks: [mismatch], failOn: 'none' } });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.error.code, 'qa_incomplete');
    assert.equal(failed.structuredContent.result.checks[0].responses[0].state, 'json-mismatch');
    assert.equal(failed.structuredContent.result.checks[0].responses[0].failedJsonIndex, 1);
    assert.match(failed.structuredContent.result.checks[0].responses[0].detail, /JSON 断言 2/);
    assert.deepEqual(methods, ['POST', 'PATCH']);
    assert.equal(queries, 2);
  } finally {
    await client?.close().catch(() => {});
    if (engine.exitCode === null && engine.signalCode === null) {
      const stopped = once(engine, 'exit');
      engine.kill();
      await stopped;
    }
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
