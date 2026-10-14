import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewedOperationPlan } from '../src/crawler/reviewed-operation-states.mjs';

const scope = { origin: 'https://example.test', pageNames: ['home', 'catalog'] };
const candidate = { index: 0, kind: 'tab', selector: 'body > :nth-child(2) > :nth-child(1)' };

test('review plan only accepts exact captured pages and structural discovered candidates', () => {
  const valid = validateReviewedOperationPlan({ version: 1, origin: scope.origin,
    pages: [{ pageName: 'home', candidates: [candidate] }],
  }, scope);
  assert.equal(valid.total, 1);
  assert.deepEqual(valid.byPage.get('home'), [candidate]);

  for (const changed of [
    { ...candidate, selector: 'button#delete' },
    { ...candidate, selector: 'body > :nth-child(1), form button' },
    { ...candidate, kind: 'submit' },
    { ...candidate, index: -1 },
  ]) {
    assert.throws(() => validateReviewedOperationPlan({ version: 1, origin: scope.origin,
      pages: [{ pageName: 'home', candidates: [changed] }],
    }, scope), /invalid operation review plan/);
  }
  assert.throws(() => validateReviewedOperationPlan({ version: 1, origin: scope.origin,
    pages: [{ pageName: 'missing', candidates: [candidate] }],
  }, scope), /invalid operation review plan/);
  assert.throws(() => validateReviewedOperationPlan({ version: 1, origin: scope.origin,
    pages: [{ pageName: 'home', candidates: [candidate, candidate] }],
  }, scope), /invalid operation review plan/);
});
