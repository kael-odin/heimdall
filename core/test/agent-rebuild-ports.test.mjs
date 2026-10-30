import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { portAvailable, findFreePort } from '../src/agent/rebuild/ports.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

test('rebuild ports: an occupied port is not offered as free', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    assert.equal(await portAvailable(port), false);
    const next = await findFreePort(port, 10);
    assert.notEqual(next, port);
    assert.equal(await portAvailable(next), true);
  } finally {
    await close(server);
  }
});
