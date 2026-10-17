import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defectTicketRequestFingerprint, defectTicketMemberSetDigest, defectTicketEventBytes } from '../src/acceptance/defect-ticket-schema.mjs';
import { projectDefectTicket } from '../src/acceptance/defect-ticket-model.mjs';
import { renderDefectTicketExport, redactDefectTicketExportText } from '../src/acceptance/defect-ticket-report.mjs';

const uid = prefix => prefix + '-00000000-0000-0000-0000-000000000001';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(overrides = {}) {
  // Format-only event. This fixture makes no claim about source eligibility.
  const request = { ticketId: uid('dt'), actionId: uid('da'), sourceOperationId: uid('bo'), memberCheckIds: ['menu'],
    title: '<img src=x onerror=alert(1)> | [click](javascript:alert(1))', severity: 'high',
    description: 'https://user:pass@example.test/path?token=URL_SENTINEL#private\napi_key=KEY_SENTINEL\ntoken=BARE_TOKEN_SENTINEL',
    reproduction: 'Open /app?token=RELATIVE_SENTINEL\nVisit dashboard?session=BARE_SENTINEL\n'
      + '//schemeuser:schemepass@example.test/app?session=SCHEME_SENTINEL\n?session=QUERY_SENTINEL\n'
      + '# injected heading\n```html\n<script>TEXT</script>', ...overrides };
  const members = [{ checkId: 'menu', bugId: 'bug-' + sha('bug'), route: '/app?token=ROUTE_SENTINEL',
    identity: { version: 1, kind: 'browser', facet: 'visual', caseKey: sha('case'), contextKey: sha('context'),
      ruleKey: sha('rule'), oracleKey: sha('oracle'), environmentKey: sha('environment'), viewport: { width: 375, height: 640 } },
    verifierFingerprint: sha('verifier'), evidence: [{ role: 'targetScreenshot', file: 'target.png', bytes: 4, sha256: sha('png') }] }];
  const event = { ticketContractVersion: 1, kind: 'create', ticketId: request.ticketId, actionId: request.actionId,
    projectId: uid('ap'), candidateId: uid('bc'), contentDigest: sha('content'), revision: 0, previousEventSha256: null,
    requestFingerprint: defectTicketRequestFingerprint({ projectId: uid('ap'), ticketId: request.ticketId, kind: 'create', request }),
    createdAt: '2026-10-18T00:00:00.000Z', actor: { kind: 'local-operator' }, title: request.title, severity: request.severity,
    description: request.description, reproduction: request.reproduction,
    source: { operationId: request.sourceOperationId, targetReleaseId: uid('ar'), acceptedAt: '2026-10-17T23:00:00.000Z',
      recordedAt: '2026-10-17T23:01:00.000Z', dispatchSha256: sha('dispatch'), reportSha256: sha('report'), observationsSha256: sha('obs') },
    members, memberSetDigest: defectTicketMemberSetDigest(members) };
  const records = [{ event, sha256: sha(defectTicketEventBytes(event)) }], projection = projectDefectTicket({ records, facts: null });
  return { records, projection, exportedAt: '2026-10-18T01:00:00.000Z' };
}

test('exports preserve integrity-blocked history and exact action/raw source digests', () => {
  const f = fixture(), original = JSON.stringify(f);
  const result = renderDefectTicketExport({ ...f, format: 'json' }), artifact = JSON.parse(result.bytes);
  assert.equal(artifact.schemaVersion, 1); assert.equal(artifact.scope, 'declared-members');
  assert.equal(artifact.handling.status, 'open'); assert.equal(artifact.verification.status, 'integrity_blocked');
  assert.equal(artifact.verification.repairVerified, false); assert.equal(artifact.verification.sourceIntegrityVerified, false);
  assert.equal(artifact.history[0].eventSha256, f.records[0].sha256);
  assert.equal(artifact.source.reportSha256, f.records[0].event.source.reportSha256);
  assert.equal(artifact.members[0].evidence[0].sha256, sha('png'));
  assert.equal(result.filename, f.projection.ticketId + '.json'); assert.match(result.contentType, /^application\/json/);
  assert.equal(JSON.stringify(f), original, 'export redaction must never rewrite stored facts');
});

test('both formats omit URL queries, URL credentials and known credential assignments', () => {
  const f = fixture();
  for (const format of ['md', 'json']) {
    const text = renderDefectTicketExport({ ...f, format }).bytes.toString('utf8');
    for (const secret of ['URL_SENTINEL', 'KEY_SENTINEL', 'RELATIVE_SENTINEL', 'ROUTE_SENTINEL', 'user:pass', '#private',
      'BARE_SENTINEL', 'SCHEME_SENTINEL', 'QUERY_SENTINEL', 'schemeuser:schemepass', 'BARE_TOKEN_SENTINEL'])
      assert.equal(text.includes(secret), false, format + ':' + secret);
    assert.equal(/Cookie|headers|rawPrompt|absolutePath/.test(text), false);
  }
  assert.equal(redactDefectTicketExportText('Authorization: Bearer SECRET'), 'Authorization=[omitted]');
  assert.equal(redactDefectTicketExportText('Cookie: a=ONE; b=TWO'), 'Cookie=[omitted]');
  assert.equal(redactDefectTicketExportText('api_key="TWO WORDS"'), 'api_key=[omitted]');
  assert.equal(redactDefectTicketExportText('Bearer ABC.def-123'), 'Bearer [omitted]');
  assert.equal(redactDefectTicketExportText('token=BARE_TOKEN_SENTINEL'), 'token=[omitted]');
});

test('Markdown treats HTML, links, table delimiters, headings and fences as quoted text', () => {
  const text = renderDefectTicketExport({ ...fixture(), format: 'md' }).bytes.toString('utf8');
  assert.equal(text.includes('<img'), false); assert.equal(text.includes('<script>'), false);
  assert.equal(text.includes('[click]('), false); assert.equal(text.includes('\n# injected'), false);
  assert.equal(text.includes('\n```html'), false);
  assert.match(text, /&lt;img/); assert.match(text, /> \\# injected heading/);
  assert.match(text, /当前证据未核验/);
});

test('both formats omit quoted credential keys and complete escaped string values in manual text', () => {
  const keys = ['token', 'password', 'secret', 'api_key', 'api-key', 'access_token', 'refresh-token', 'Authorization', 'Cookie'];
  for (const key of keys) {
    const value = 'JSON_SECRET_' + key.replaceAll('-', '_') + '_WITH_"_QUOTE';
    const input = JSON.stringify({ [key]: value });
    assert.equal(redactDefectTicketExportText(input).includes('JSON_SECRET_'), false, key);
    for (const field of ['description', 'reproduction']) {
      const f = fixture({ [field]: input + '\n' + "{'" + key + "': 'SINGLE_QUOTED_SECRET'}" });
      const original = JSON.stringify(f);
      for (const format of ['md', 'json']) {
        const text = renderDefectTicketExport({ ...f, format }).bytes.toString('utf8');
        assert.equal(text.includes('JSON_SECRET_'), false, key + ':' + field + ':' + format);
        assert.equal(text.includes('SINGLE_QUOTED_SECRET'), false, key + ':' + field + ':' + format);
        assert.equal(text.includes('QUOTE'), false, 'escaped quotes must not leave the secret suffix');
      }
      assert.equal(JSON.stringify(f), original);
    }
  }
  assert.match(redactDefectTicketExportText('{"token":"FIRST_SECRET","password":"SECOND_SECRET"}'), /token=\[omitted\],password=\[omitted\]/);
});

test('exports reject mismatched ticket revisions, unsupported formats and malformed dates', () => {
  const f = fixture();
  assert.throws(() => renderDefectTicketExport({ ...f, projection: { ...f.projection, headSha256: sha('other') }, format: 'md' }),
    error => error.details.reason === 'EXPORT_SCOPE_MISMATCH');
  for (const patch of [{ format: 'html' }, { format: 'md', exportedAt: '2026-10-18' }])
    assert.throws(() => renderDefectTicketExport({ ...f, ...patch }), { code: 'INVALID_INPUT' });
});
