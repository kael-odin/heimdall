import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('journey capability lists and reads sanitized metadata without exposing raw HAR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-journey-capability-'));
  const previous = process.env.HEIMDALL_DATA_DIR;
  process.env.HEIMDALL_DATA_DIR = root;
  const { invoke } = await import('../src/agent/registry/invoke.mjs');
  const journeyId = 'journey-1794787993231-f8a2e67d';
  const dir = join(root, 'workspace', 'example.test', 'agent', 'journeys', journeyId);
  try {
    mkdirSync(join(dir, 'steps'), { recursive: true });
    writeFileSync(join(dir, 'journey.json'), JSON.stringify({ schema: 'heimdall.journey/1', id: journeyId,
      siteId: 'example.test', origin: 'https://example.test', startedAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z',
      steps: 1, network: { sanitizedEntries: 1, apiEntries: 1, excluded: 0 }, contract: { status: 'observed', tier: 'B1', endpoints: 1, path: 'api-contract.json' } }));
    writeFileSync(join(dir, 'steps', '0001.json'), JSON.stringify({ type: 'input', path: '/', valuePresent: true }));
    writeFileSync(join(dir, 'network.journey.har'), 'Bearer secret@example.com');
    const listed = await invoke('journey', { action: 'list', siteId: 'example.test' }, { client: 'mcp' });
    assert.equal(listed.ok, true);
    assert.equal(listed.result.journeys[0].id, journeyId);
    const read = await invoke('journey', { action: 'read', siteId: 'example.test', journeyId }, { client: 'mcp' });
    assert.equal(read.ok, true);
    assert.equal(read.result.steps[0].valuePresent, true);
    assert.doesNotMatch(JSON.stringify(read), /Bearer secret|example\.com/);
    const waiting = await invoke('journey', { action: 'start', siteId: 'example.test' }, { client: 'mcp' });
    assert.equal(waiting.ok, true);
    assert.equal(waiting.result.status, 'waiting_input');
    assert.equal(waiting.result.requiresHumanApproval, true);
  } finally {
    if (previous === undefined) delete process.env.HEIMDALL_DATA_DIR; else process.env.HEIMDALL_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
