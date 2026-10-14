import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assertPageName } from './page-name.mjs';

const MARKER = 'site-origin.json';

/** Workspace ids are routing keys; only recorded ownership determines an upstream. */
export function readSiteIdentity(workspace, siteId) {
  if (typeof siteId !== 'string' || !/^(?!\.\.?$)[a-z0-9.-]+$/i.test(siteId)) return null;
  const siteDir = join(workspace, siteId);
  if (!existsSync(siteDir)) return null;
  const recorded = readSiteOrigin(siteDir);
  // Old live-only directories had no manifest. Preserve their HTTPS default,
  // but never interpret a scoped directory id as a real network hostname.
  const hasMetadata = existsSync(join(siteDir, 'recon', 'atlas.json'))
    || (existsSync(join(siteDir, 'pages')) && readdirSync(join(siteDir, 'pages')).some(name => existsSync(join(siteDir, 'pages', name, 'manifest.json'))));
  const origin = recorded ?? (siteId.includes('--origin-') || hasMetadata ? null : `https://${siteId}`);
  return origin ? { siteId, origin, hostname: new URL(origin).hostname } : null;
}

export function findSiteIdentity(workspace, targetUrl) {
  const target = new URL(targetUrl);
  const legacy = readSiteIdentity(workspace, target.hostname.replace(/^www\./, ''));
  if (legacy?.origin === target.origin) return legacy;
  const siteId = siteIdForOrigin(workspace, target);
  const identity = readSiteIdentity(workspace, siteId);
  return identity?.origin === target.origin ? identity : null;
}

function refuse(siteDir, message) {
  const error = new Error(`站点 ${basename(siteDir)}：${message}`);
  error.code = 'origin-conflict';
  throw error;
}

function originOf(value, siteDir, source) {
  try {
    if (typeof value !== 'string' && !(value instanceof URL)) throw new Error('missing URL');
    const url = value instanceof URL ? value : new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.origin;
  } catch {
    refuse(siteDir, `${source} 的来源网址无效，已拒绝覆盖旧产物`);
  }
}

function readIdentity(path, siteDir, source, pick) {
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch { refuse(siteDir, `${source} 无法读取，已拒绝覆盖旧产物`); }
  return pick(data);
}

/** Read ownership without claiming or changing an existing workspace. */
export function readSiteOrigin(siteDir) {
  const origins = new Set();
  const marker = join(siteDir, MARKER);
  if (existsSync(marker)) return readIdentity(marker, siteDir, MARKER,
    data => originOf(data?.origin, siteDir, MARKER));

  const atlas = join(siteDir, 'recon', 'atlas.json');
  if (existsSync(atlas)) {
    readIdentity(atlas, siteDir, 'recon/atlas.json', (data) => {
      if (data?.origin) origins.add(originOf(data.origin, siteDir, 'recon/atlas.json'));
      else for (const node of data?.nodes ?? []) origins.add(originOf(node?.url, siteDir, 'recon/atlas.json'));
    });
  }
  const pages = join(siteDir, 'pages');
  if (existsSync(pages)) {
    for (const entry of readdirSync(pages, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = `pages/${entry.name}/manifest.json`;
      const file = join(pages, entry.name, 'manifest.json');
      if (existsSync(file)) origins.add(readIdentity(file, siteDir, source,
        data => originOf(data?.target, siteDir, source)));
    }
  }
  const seo = join(siteDir, 'seo', 'seo.json');
  if (existsSync(seo)) readIdentity(seo, siteDir, 'seo/seo.json', (data) => {
    if (data?.origin) origins.add(originOf(data.origin, siteDir, 'seo/seo.json'));
  });
  return origins.size === 1 ? [...origins][0] : null;
}

/** Keep old hostname directories readable; new colliding origins get a stable separate directory. */
export function siteIdForOrigin(workspace, targetUrl) {
  const origin = originOf(targetUrl, workspace, '请求');
  const host = new URL(origin).hostname.replace(/^www\./, '');
  // URL.hostname includes brackets and colons for IPv6; those cannot name a Windows directory.
  const fileSafeHost = /^[a-z0-9.-]+$/i.test(host) ? host
    : `ipv6-${createHash('sha256').update(host).digest('hex').slice(0, 16)}`;
  const scoped = `${fileSafeHost}--origin-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`;
  const scopedDir = join(workspace, scoped);
  if (existsSync(scopedDir)) {
    if (readSiteOrigin(scopedDir) !== origin) refuse(scopedDir, `目录未明确归属 ${origin}，已拒绝复用`);
    return scoped;
  }
  if (fileSafeHost !== host) return scoped;
  const legacyDir = join(workspace, host);
  if (!existsSync(legacyDir)) return host;
  if (readSiteOrigin(legacyDir) === origin || readdirSync(legacyDir).length === 0) return host;
  return scoped;
}

/** Preserve the hostname-based workspace layout while preventing cross-origin writes. */
export function assertSiteOrigin(siteDir, targetUrl, { claim = false, pageName = null, checkAtlas = false } = {}) {
  if (pageName !== null) assertPageName(pageName);
  const requested = originOf(targetUrl, siteDir, '请求');
  const marker = join(siteDir, MARKER);
  const hasMarker = existsSync(marker);
  if (hasMarker) {
    const actual = readIdentity(marker, siteDir, MARKER, data => originOf(data?.origin, siteDir, MARKER));
    if (actual !== requested) {
      refuse(siteDir, `${MARKER} 属于 ${actual}；请求 ${requested}，已拒绝覆盖。请迁移旧产物或换 HEIMDALL_DATA_DIR`);
    }
  }

  // Legacy workspaces need a full scan; claimed workspaces only recheck the file this action may replace.
  const identities = [];
  const atlasPath = join(siteDir, 'recon', 'atlas.json');
  if ((!hasMarker || checkAtlas) && existsSync(atlasPath)) {
    const atlasOrigin = readIdentity(atlasPath, siteDir, 'recon/atlas.json', (atlas) => {
      if (atlas?.origin) return originOf(atlas.origin, siteDir, 'recon/atlas.json');
      const nodes = Array.isArray(atlas?.nodes) ? atlas.nodes : [];
      const origins = new Set(nodes.map(node =>
        originOf(node?.url, siteDir, 'recon/atlas.json')).filter(Boolean));
      if (origins.size !== 1) refuse(siteDir, '旧 atlas 的来源不唯一，已拒绝覆盖旧产物');
      return [...origins][0];
    });
    identities.push({ source: 'recon/atlas.json', origin: atlasOrigin });
  }

  const pagesDir = join(siteDir, 'pages');
  if (existsSync(pagesDir)) {
    const names = hasMarker ? (pageName ? [pageName] : [])
      : readdirSync(pagesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
    for (const name of names) {
      const source = `pages/${name}/manifest.json`;
      const manifestPath = join(pagesDir, name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      identities.push({ source, origin: readIdentity(manifestPath, siteDir, source,
        data => originOf(data?.target, siteDir, source)) });
    }
  }

  for (const { source, origin } of identities) {
    if (origin !== requested) {
      refuse(siteDir, `${source} 属于 ${origin}；请求 ${requested}，已拒绝覆盖。请迁移旧产物或换 HEIMDALL_DATA_DIR`);
    }
  }

  if (claim && !hasMarker) {
    mkdirSync(siteDir, { recursive: true });
    try { writeFileSync(marker, JSON.stringify({ origin: requested }, null, 2), { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const actual = readIdentity(marker, siteDir, MARKER, data => originOf(data?.origin, siteDir, MARKER));
      if (actual !== requested) {
        refuse(siteDir, `${MARKER} 属于 ${actual}；请求 ${requested}，已拒绝覆盖。请迁移旧产物或换 HEIMDALL_DATA_DIR`);
      }
    }
  }
  return requested;
}
