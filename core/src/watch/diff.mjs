/**
 * watch/diff — 站点变更快照与差异（纯函数）
 *
 * 快照字段聚焦"值得知道的变化"：状态、标题/描述、canonical、robots、H1、
 * 结构化数据类型、字数、正文指纹（textHash）。
 */
export const WATCH_FIELDS = ['status', 'finalUrl', 'title', 'description', 'canonical', 'robotsMeta', 'lang', 'h1Joined', 'jsonldTypes', 'wordCount', 'textHash'];

export const FIELD_LABEL = {
  status: 'HTTP 状态', finalUrl: '最终 URL', title: 'title', description: 'description', canonical: 'canonical',
  robotsMeta: 'robots', lang: 'lang', h1Joined: 'H1', jsonldTypes: '结构化数据', wordCount: '字数', textHash: '正文',
};
const FIELD_SEVERITY = {
  status: 'high', finalUrl: 'medium', title: 'medium', description: 'medium', canonical: 'medium', robotsMeta: 'high',
  lang: 'low', h1Joined: 'low', jsonldTypes: 'low', wordCount: 'info', textHash: 'medium',
};

export function normalizeUrl(u) {
  try { const x = new URL(String(u)); x.hash = ''; return x.href.replace(/\/$/, ''); } catch { return String(u); }
}

export function snapshotFromPages(host, pages, generatedAt = new Date().toISOString(), unstableMap = {}) {
  const map = {};
  for (const p of pages) {
    map[normalizeUrl(p.url)] = {
      unstable: unstableMap[normalizeUrl(p.url)] ?? [],
      url: p.url,
      finalUrl: p.finalUrl ?? p.url,
      status: p.status ?? 0,
      title: p.title ?? '',
      description: p.description ?? '',
      canonical: p.canonical ?? '',
      robotsMeta: p.robotsMeta ?? '',
      lang: p.lang ?? '',
      h1Joined: (p.h1 ?? []).join(' | '),
      jsonldTypes: [...new Set((p.jsonld ?? []).flatMap(j => j.types ?? []))].join(','),
      wordCount: p.wordCount ?? 0,
      textHash: p.textHash ?? '',
      textSample: p.textSample ?? '',
    };
  }
  return { version: 1, host, generatedAt, pages: map };
}

const smallWordDelta = (a, b) => {
  const x = Number(a?.wordCount ?? 0), y = Number(b?.wordCount ?? 0);
  if (!x || !y) return false;
  return Math.abs(y - x) / Math.max(x, 1) < 0.05;
};

export function diffSnapshots(baseline, current) {
  const a = baseline?.pages ?? {};
  const b = current?.pages ?? {};
  const added = [], removed = [], changed = [], dynamic = [];
  for (const url of Object.keys(b)) if (!a[url]) added.push({ url, title: b[url].title });
  for (const url of Object.keys(a)) if (!b[url]) removed.push({ url, title: a[url].title });
  for (const url of Object.keys(b)) {
    if (!a[url]) continue;
    const unstable = new Set(b[url].unstable ?? []);
    const fields = [], dyn = [];
    for (const f of WATCH_FIELDS) {
      const before = a[url][f], after = b[url][f];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (unstable.has(f)) { dyn.push({ field: f, label: FIELD_LABEL[f] ?? f, before, after }); continue; }
      // 字数小幅波动视为动态噪声（推荐位/计数器/轮播），正文小幅变化降级为 info
      if (f === 'wordCount' && smallWordDelta(a[url], b[url])) { dyn.push({ field: f, label: FIELD_LABEL[f] ?? f, before, after }); continue; }
      const severity = f === 'textHash' && smallWordDelta(a[url], b[url]) ? 'info' : (FIELD_SEVERITY[f] ?? 'info');
      fields.push({ field: f, label: FIELD_LABEL[f] ?? f, severity, before, after });
    }
    if (fields.length) changed.push({ url, title: b[url].title, fields });
    if (dyn.length) dynamic.push({ url, title: b[url].title, fields: dyn });
  }
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0 };
  for (const c of changed) for (const f of c.fields) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const changedUrls = new Set(changed.map(c => c.url));
  return {
    added, removed, changed, dynamic,
    unchanged: Object.keys(b).filter(u => a[u] && !changedUrls.has(u)).length,
    bySeverity,
    hasChanges: added.length + removed.length + changed.length > 0,
  };
}
