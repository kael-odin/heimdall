import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptanceDemoContext, acceptanceDemoDraft } from '../../console/src/acceptance-demo.js';
import { buildAcceptanceInput } from '../../console/src/acceptance-workbench.js';

const consoleOrigin = 'http://127.0.0.1:8902';
const fixtureOrigin = 'http://127.0.0.1:39137';
const link = (fixture = fixtureOrigin, marker = 'local-fixed-v1') => consoleOrigin + '/?' + new URLSearchParams({ acceptanceDemo: marker, fixtureOrigin: fixture });

test('CI preserves D7 failure diagnostics without the browser profile or full runtime', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const prefix = 'core/workspace/_runs/acceptance-demo-console-*/';
  const paths = workflow.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(prefix));
  for (const name of ['summary.json', 'capture-failures.json', 'ui-requests.json', 'ui-responses.json']) {
    assert.ok(paths.includes(prefix + name), name + ' must be preserved after a CI failure');
  }
  assert.ok(paths.every(path => !path.includes('chromium-profile') && !path.includes('session/runtime') && !path.includes('**')));
});

test('demo context accepts only the launcher marker and a plain explicit-port loopback origin', () => {
  assert.deepEqual(acceptanceDemoContext(link()), { kind: 'local-fixed-v1', fixtureOrigin });
  const reversed = consoleOrigin + '/?' + new URLSearchParams({ fixtureOrigin, acceptanceDemo: 'local-fixed-v1' });
  assert.deepEqual(acceptanceDemoContext(reversed), acceptanceDemoContext(link()));
  const acceptanceView = link() + '&view=acceptance';
  assert.deepEqual(acceptanceDemoContext(acceptanceView), acceptanceDemoContext(link()));
  for (const fixture of ['http://127.0.0.1:1', 'http://127.0.0.1:65535']) assert.equal(acceptanceDemoContext(link(fixture)).fixtureOrigin, fixture);
  assert(Object.isFrozen(acceptanceDemoContext(link())));
});

test('remote, disguised, credentialed and non-origin fixture addresses cannot prefill', () => {
  for (const fixture of [
    'https://127.0.0.1:39137', 'http://localhost:39137', 'http://[::1]:39137', 'http://127.0.0.2:39137',
    'http://2130706433:39137', 'http://127.1:39137', 'http://0177.0.0.1:39137', 'http://0x7f000001:39137',
    'http://127%2e0.0.1:39137', 'http://127.0.0.1.example.com:39137', 'https://example.com',
    'http://user@127.0.0.1:39137', 'http://user:secret@127.0.0.1:39137', 'http://127.0.0.1:39137@evil.test',
    fixtureOrigin + '/', fixtureOrigin + '/reference', fixtureOrigin + '/..', fixtureOrigin + '?token=secret', fixtureOrigin + '#x',
    'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:80', 'http://127.0.0.1:65536', 'http://127.0.0.1:039137',
    ' ' + fixtureOrigin, fixtureOrigin + '\n', 'http:\\127.0.0.1:39137', fixtureOrigin + '%00',
  ]) assert.equal(acceptanceDemoContext(link(fixture)), null, fixture);
});

test('unknown, duplicate, secret and payload parameters do not create a demo context', () => {
  for (const href of [
    consoleOrigin + '/', consoleOrigin + '/?acceptanceDemo=local-fixed-v1', link(fixtureOrigin, 'other'),
    link() + '&acceptanceDemo=local-fixed-v1', link() + '&fixtureOrigin=' + encodeURIComponent(fixtureOrigin),
    link() + '&token=secret', link() + '&apiKey=secret', link() + '&projectId=ap-anything', link() + '&plan=%7B%7D',
    link() + '&view=atlas', link() + '&view=acceptance&view=acceptance', link() + '&view=acceptance&site=fixture.test',
    link() + '#fragment', link() + '#', link().replace(consoleOrigin, 'https://example.com'),
    link().replace(consoleOrigin, 'https://127.0.0.1:8902'), link().replace(consoleOrigin, 'http://localhost:8902'),
    link().replace(consoleOrigin, 'http://2130706433:8902'), link().replace('/?', '/other?'),
    ' ' + link(), link() + '\n', null, undefined, {}, 'x'.repeat(2049),
  ]) assert.equal(acceptanceDemoContext(href), null, String(href));
});

test('demo draft uses fixed selectors, normal input building and default viewports without approvals', () => {
  const context = acceptanceDemoContext(link());
  const draft = acceptanceDemoDraft(context);
  assert.equal(draft.mode, 'regression');
  assert.equal(draft.baselineUrl, fixtureOrigin + '/reference');
  assert.equal(draft.targetUrl, fixtureOrigin + '/bug');
  assert.equal(draft.specApproved, false);
  assert.equal(draft.specApprovedFingerprint, '');
  const input = buildAcceptanceInput(draft);
  assert.deepEqual(input.routes, ['/']);
  assert.deepEqual(input.points[0].steps, [{ action: 'click', selector: '#menu-toggle' }]);
  assert.deepEqual(input.points[0].assertions, [
    { kind: 'visible', selector: '#menu' },
    { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' },
  ]);
  for (const field of ['viewports', 'timeoutMs', 'approved', 'candidateId', 'projectId', 'ticketId', 'truth', 'expectedVerdict']) assert.equal(Object.hasOwn(input, field), false, field);
  const changed = acceptanceDemoDraft(context); changed.targetUrl = 'http://example.test/changed';
  assert.equal(acceptanceDemoDraft(context).targetUrl, fixtureOrigin + '/bug');
});

test('a caller cannot bypass fixture validation when requesting a draft', () => {
  for (const context of [null, {}, { kind: 'other', fixtureOrigin }, { kind: 'local-fixed-v1', fixtureOrigin: 'https://evil.test' }]) {
    assert.throws(() => acceptanceDemoDraft(context), /validated local demo context/);
  }
});
