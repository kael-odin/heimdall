import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measurementCoverage, scanMeasurementsAsync } from '../src/verify/measurement-status.mjs';

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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
