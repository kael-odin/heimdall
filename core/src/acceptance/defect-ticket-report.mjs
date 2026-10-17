/** Download-only manual defect artifacts. No target requests or persistence. */
import { DEFECT_TICKET_LIMITS, defectTicketJson, validateDefectTicketChain, defectTicketFail as fail } from './defect-ticket-schema.mjs';

const LIMITATIONS = Object.freeze([
  '仅覆盖此人工缺陷单固定关联的检查；不代表整个页面、项目或业务流程已修复。',
  '人工处理状态与当前核验状态分开；历史关闭不代替当前证据核验。',
  '导出省略 URL 查询参数及已识别的敏感字段，不包含原始报告、截图、网络记录或 AI 原文。',
  '无法保证识别任意人工输入的秘密；共享前仍应检查人工文字。',
]);
// Exported text remains text. Omit query/fragment parts from absolute and
// relative URLs, then known credential assignments. Do not alter stored facts.
export function redactDefectTicketExportText(text) {
  return String(text).replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, value => {
    try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
    catch { return '[URL omitted]'; }
  }).replace(/(^|[\s("'`])(\/\/[^\s<>"'`]+)/g, (_match, prefix, value) => {
    try { const url = new URL('https:' + value); return prefix + '//' + url.host + url.pathname; }
    catch { return prefix + '[URL omitted]'; }
  }).replace(/(^|[\s("'`])([^\s<>"'`?#]*)(?:[?#][^\s<>"'`]+)/g, '$1$2[query omitted]')
    .replace(/(["']?)\b(authorization|cookie)\b\1\s*[:=][^\r\n]*/gi, '$2=[omitted]')
    .replace(/(["']?)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b\1\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/gi, '$2=[omitted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [omitted]');
}
const redact = value => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
  : typeof value === 'string' ? redactDefectTicketExportText(value) : value;
const markdown = value => redactDefectTicketExportText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#+.!|~=-]/g, '\\$&');
const quote = text => String(text).split(/\r?\n/).map(line => '> ' + markdown(line)).join('\n');
const iso = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export function renderDefectTicketExport({ projection: input, records: inputRecords, exportedAt, format } = {}) {
  if (!iso(exportedAt) || !['md', 'json'].includes(format)) fail('INVALID_EXPORT', 'INVALID_INPUT', 400);
  const records = validateDefectTicketChain(inputRecords), projection = defectTicketJson(input, DEFECT_TICKET_LIMITS.factsJsonBytes);
  const first = records[0].event, head = records.at(-1);
  if (projection.ticketId !== first.ticketId || projection.projectId !== first.projectId
    || projection.headSha256 !== head.sha256 || projection.revision !== head.event.revision
    || projection.memberSetDigest !== first.memberSetDigest) fail('EXPORT_SCOPE_MISMATCH');
  const artifact = redact({ schemaVersion: 1, kind: 'manual-defect-ticket', scope: 'declared-members', exportedAt,
    ticketId: first.ticketId, projectId: first.projectId, candidateId: first.candidateId, contentDigest: first.contentDigest,
    revision: head.event.revision, headSha256: head.sha256, memberSetDigest: first.memberSetDigest,
    title: first.title, severity: first.severity, description: first.description, reproduction: first.reproduction,
    source: first.source, members: first.members,
    handling: { status: projection.processingStatus, lastClose: projection.lastClose ? {
      actionId: projection.lastClose.actionId, after: projection.lastClose.after,
      closedAt: projection.lastClose.createdAt, resolution: projection.lastClose.resolution } : null },
    verification: { status: projection.verificationStatus, factsDigest: projection.factsDigest,
      currentOperationId: projection.currentOperationId, counts: projection.counts,
      results: projection.results, reopenReasons: projection.reopenReasons, reason: projection.reason,
      closeEligible: projection.closeEligible, sourceIntegrityVerified: projection.verificationStatus !== 'integrity_blocked',
      repairVerified: projection.verificationStatus === 'verified_passed' },
    history: records.map(({ event, sha256 }) => ({ actionId: event.actionId, kind: event.kind,
      revision: event.revision, previousEventSha256: event.previousEventSha256, eventSha256: sha256,
      requestFingerprint: event.requestFingerprint, createdAt: event.createdAt,
      ...(event.kind === 'close' ? { after: event.after, resolution: event.resolution } : {}) })),
    limitations: LIMITATIONS });
  let body;
  if (format === 'json') body = JSON.stringify(artifact, null, 2) + '\n';
  else {
    const lines = ['# 人工缺陷单', '', '范围：固定关联检查。', '', quote(artifact.title), '',
      `编号：${markdown(artifact.ticketId)}`, `严重度：${markdown(artifact.severity)}`,
      `人工处理状态：${markdown(artifact.handling.status)}`, `当前核验状态：${markdown(artifact.verification.status)}`,
      `关联检查数量：${artifact.members.length}`, `导出时间：${markdown(exportedAt)}`, '', '## 问题说明', '',
      quote(artifact.description), '', '## 复现说明', '', quote(artifact.reproduction), '', '## 固定来源', '',
      `操作：${markdown(artifact.source.operationId)}`, `报告 SHA256：${artifact.source.reportSha256}`,
      `登记 SHA256：${artifact.source.observationsSha256}`, `成员集合 SHA256：${artifact.memberSetDigest}`, '', '## 关联检查与证据', ''];
    for (const member of artifact.members) {
      lines.push(`- 检查：${markdown(member.checkId)}；路由：${markdown(member.route)}；BUG：${markdown(member.bugId)}`);
      for (const evidence of member.evidence) lines.push(`  - ${markdown(evidence.role)}：${markdown(evidence.file)}；${evidence.bytes} bytes；SHA256 ${evidence.sha256}`);
    }
    lines.push('', '## 当前逐项核验', '');
    if (!artifact.verification.results.length) lines.push('当前证据未核验；不能据此声称已修复。');
    for (const result of artifact.verification.results) lines.push(`- ${markdown(result.sourceCheckId)}：${markdown(result.relation)}（${markdown(result.reason)}）`);
    lines.push('', '## 人工处理历史', '');
    for (const event of artifact.history) {
      lines.push(`- revision ${event.revision} · ${markdown(event.kind)} · ${markdown(event.createdAt)} · ${markdown(event.actionId)} · SHA256 ${event.eventSha256}`);
      if (event.resolution) lines.push('', quote(event.resolution), '');
    }
    lines.push('', '## 范围限制', '', ...LIMITATIONS.map(value => '- ' + markdown(value)), '');
    body = lines.join('\n');
  }
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length > DEFECT_TICKET_LIMITS.factsJsonBytes) fail('EXPORT_BUDGET', 'CAPACITY', 503);
  return { bytes, filename: first.ticketId + '.' + format,
    contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8' };
}
