/** Restricted local demonstration prefill. This module never performs I/O. */
const MARKER = 'local-fixed-v1';
const ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

function fixtureOrigin(value) {
  if (typeof value !== 'string' || !ORIGIN.test(value)) return null;
  const port = Number(ORIGIN.exec(value)[1]);
  if (port > 65535) return null;
  try {
    const url = new URL(value);
    return url.origin === value && url.port ? value : null;
  } catch { return null; }
}

const NAVIGATION_PARAMS = new Set(['view']);

/** Only the launcher's named parameters and non-secret console navigation state are read. */
export function acceptanceDemoContext(href) {
  if (typeof href !== 'string' || href.length > 2048 || /[\s\\#]/.test(href)) return null;
  const originMatch = /^(http:\/\/127\.0\.0\.1:[1-9]\d{0,4})\/\?/.exec(href);
  if (!originMatch || !fixtureOrigin(originMatch[1])) return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.pathname !== '/' || url.username || url.password || url.hash) return null;
  const entries = [...url.searchParams];
  if (entries.length < 2 || entries.length > 3 || url.searchParams.getAll('acceptanceDemo').length !== 1
    || url.searchParams.getAll('fixtureOrigin').length !== 1
    || entries.some(([name]) => name !== 'acceptanceDemo' && name !== 'fixtureOrigin' && !NAVIGATION_PARAMS.has(name))
    || url.searchParams.getAll('view').length > 1
    || (url.searchParams.has('view') && url.searchParams.get('view') !== 'acceptance')
    || url.searchParams.get('acceptanceDemo') !== MARKER) return null;
  const origin = fixtureOrigin(url.searchParams.get('fixtureOrigin'));
  return origin ? Object.freeze({ kind: MARKER, fixtureOrigin: origin }) : null;
}

/** Every value except the validated fixture port is fixed here, never in a URL. */
export function acceptanceDemoDraft(context) {
  if (context?.kind !== MARKER || !fixtureOrigin(context.fixtureOrigin)) throw new TypeError('A validated local demo context is required.');
  return {
    name: '本地固定示例 · 参考与已知缺陷', mode: 'regression',
    baselineUrl: context.fixtureOrigin + '/reference', targetUrl: context.fixtureOrigin + '/bug',
    routes: '/', maskSelectors: '',
    points: JSON.stringify([{
      id: 'MENU-OPEN', title: '菜单点击后展开并更新状态', route: '/', severity: 'high',
      steps: [{ action: 'click', selector: '#menu-toggle' }],
      assertions: [
        { kind: 'visible', selector: '#menu' },
        { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' },
      ],
    }], null, 2),
    specApproved: false, specApprovedFingerprint: '',
  };
}
