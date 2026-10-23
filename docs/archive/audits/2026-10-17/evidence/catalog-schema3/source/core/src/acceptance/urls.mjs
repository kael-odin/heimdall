/** Entry-relative HTTP URLs shared by browser and API acceptance. */
export function normalizeAcceptanceUrl(value, label = 'URL') {
  let url;
  try {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error();
    url = new URL(value.trim());
  } catch { throw new Error(`${label} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`${label} must be HTTP(S), without credentials or fragment`);
  return url.href;
}
export function normalizeAcceptancePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('route must be a non-empty string (max 1024)');
  const route = value.trim();
  let decoded = route;
  try { for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded); } catch { throw new Error('route contains invalid encoding'); }
  if (!route.startsWith('/') || decoded.startsWith('//') || /[\\\s#\u0000-\u001f]/.test(decoded)
      || decoded.split(/[/?]/).includes('..') || decoded.split(/[/?]/).includes('.')) throw new Error('route must be an entry-relative path without traversal, fragment or origin');
  return route;
}
/** '/' preserves the entry; other paths append to the entry as a directory. */
export function resolveAcceptanceUrl(baseUrl, route = '/') {
  const base = new URL(normalizeAcceptanceUrl(baseUrl, 'entry URL'));
  route = normalizeAcceptancePath(route);
  if (route === '/') return base.href;
  base.search = '';
  base.pathname = base.pathname.replace(/\/$/, '') + '/';
  const result = new URL(route.slice(1), base);
  if (result.origin !== base.origin || !result.pathname.startsWith(base.pathname)) throw new Error('route escapes entry URL');
  return result.href;
}
