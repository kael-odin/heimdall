import { createHash } from 'node:crypto';

export const LIVE_QUERY_DIR = '.heimdall-query';

/** Query pages need an exact key; legacy pages keep their existing path. */
export function liveSnapshotPath(pathname, search = '') {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (search) {
    const digest = createHash('sha256').update(path + search).digest('hex');
    return `${LIVE_QUERY_DIR}/${digest}/index.html`;
  }
  const rel = path.replace(/^\/+|\/+$/g, '');
  return rel ? `${rel}/index.html` : 'index.html';
}

export function liveSnapshotCandidates(pathname, search = '') {
  const rel = pathname.replace(/^\/+|\/+$/g, '');
  if (search) {
    // Assets commonly add cache-busting queries; page directories must not fall back.
    return /\.[a-z0-9]+$/i.test(rel)
      ? [liveSnapshotPath(pathname, search), rel]
      : [liveSnapshotPath(pathname, search)];
  }
  if (!rel) return ['index.html'];
  return /\.[a-z0-9]+$/i.test(rel)
    ? [rel, liveSnapshotPath(pathname)]
    : [liveSnapshotPath(pathname), rel];
}
