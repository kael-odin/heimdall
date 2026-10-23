/** HTTP/list projection. The store's validated heads may contain plans and
 * complete provenance; the console only needs this explicit view. */
const VIEW_FIELDS = ['runId', 'taskId', 'name', 'mode', 'baselineUrl', 'targetUrl', 'status', 'gate',
  'createdAt', 'updatedAt', 'endedAt', 'summary', 'progress', 'error', 'reasonCode', 'reportSha256',
  'triageAvailable', 'code'];

export function acceptanceRunView(manifest, { includePlan = false } = {}) {
  const view = {};
  for (const field of VIEW_FIELDS) if (Object.hasOwn(manifest, field)) view[field] = manifest[field];
  if (manifest.managed) {
    view.provenance = { kind: 'managed-spec', projectId: manifest.managed.projectId,
      targetReleaseId: manifest.managed.target.releaseId, sourceRunId: manifest.managed.source.runId };
    view.triageSupported = false;
    view.triageAvailable = false;
    // Stored infrastructure errors are preserved for local investigation, but
    // their raw paths or credentials must not reach the HTTP console view.
    if (Object.hasOwn(manifest, 'error')) view.error = manifest.status === 'interrupted' ? '验收已中断，现场已保留。'
      : manifest.status === 'failed' ? '验收运行失败，现场已保留。' : null;
  } else if (includePlan && Object.hasOwn(manifest, 'plan')) view.plan = manifest.plan;
  return view;
}
