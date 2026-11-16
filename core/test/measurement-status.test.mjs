import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMeasurementReader, measurementCoverage, scanMeasurementsAsync } from '../src/verify/measurement-status.mjs';

test('busy measurement scans report unknown coverage instead of a false zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-measurement-workers-'));
  try {
    const unavailable = await scanMeasurementsAsync(() => {}, ['one']);
    assert.equal(unavailable.status, 'unavailable');
    const first = scanMeasurementsAsync(dir, ['one']);
    const second = scanMeasurementsAsync(dir, ['two']);
    const busy = await scanMeasurementsAsync(dir, ['three']);
    assert.equal(busy.status, 'busy');
    assert.deepEqual(measurementCoverage(busy, 1), { status: 'busy', verified: null, unmeasured: null, average: null });
    assert.deepEqual((await first).pages, [{ page: 'one', status: 'missing' }]);
    assert.deepEqual((await second).pages, [{ page: 'two', status: 'missing' }]);
    // A score measured while the clone still called out to the network has no proof. That is not outdated evidence.
    for (const [page, extra] of [['scored', { measured: true, overall: 1 }], ['unscored', { measured: false }]]) {
      mkdirSync(join(dir, 'verify', page), { recursive: true });
      writeFileSync(join(dir, 'verify', page, 'verify.json'), JSON.stringify({ scoreVersion: 2, ...extra }));
    }
    const reader = createMeasurementReader(dir);   // read directly: the worker slots above are released asynchronously
    assert.deepEqual(reader.read('scored'), { status: 'stale', reason: 'unproven' });
    assert.deepEqual(reader.read('unscored'), { status: 'incomplete' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
