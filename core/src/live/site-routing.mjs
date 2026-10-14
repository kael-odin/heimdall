// Shared routing normalization for the builder, local engine and exporter.
const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function rewriteSourceOrigin(text, origin, mount) {
  return text.replace(new RegExp(escapeRe(origin) + '(?![a-z0-9_.:@-])', 'gi'),
    (match, index, source) => mount || (source[index + match.length] === '/' ? '' : '/'));
}

/** Accept legacy authority mounts, but never another origin's port or site id. */
export function rewriteSnapshotMount(text, { siteId, origin, mount = '' }) {
  for (const key of new Set([siteId, new URL(origin).host])) {
    text = text.replace(new RegExp('/lm/' + escapeRe(key) + '(?![a-z0-9_.:@-])', 'g'), mount);
  }
  return text;
}
