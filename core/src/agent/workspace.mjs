/**
 * agent/workspace — 读工作区（不需要引擎，E3-07）：站点、页面、镜像入口、agent/ 子树
 *
 * 磁盘布局沿用现有 workspace/<siteId>/pages/<page>/…；Bifröst 只在
 * workspace/<siteId>/agent/ 下新增文件（PRD 03 §4.2），其余不动。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';
import { isSafePageName } from '../page-name.mjs';
import { measurementIdentity } from '../verify/resume-cache.mjs';
import { CapabilityError, nextAction } from './envelope.mjs';

export const SITE_ID = /^(?!\.\.?$)[a-z0-9][a-z0-9.-]*$/i;
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

export function assertSiteId(siteId) {
  if (typeof siteId !== 'string' || !SITE_ID.test(siteId) || siteId.length > 253) {
    throw new CapabilityError('invalid_args', 'siteId 不合法', { hint: '`heimdall overview` 列出已有站点' });
  }
  return siteId;
}

export function assertPage(page) {
  if (!isSafePageName(page)) throw new CapabilityError('invalid_args', '页面名不合法', { hint: '`heimdall site <siteId>` 列出页面' });
  return page;
}

export const siteDir = (siteId) => join(WORKSPACE, assertSiteId(siteId));
export const pageDir = (siteId, page) => join(siteDir(siteId), 'pages', assertPage(page));
export const agentDir = (siteId) => join(siteDir(siteId), 'agent');

export function listSites() {
  if (!isDir(WORKSPACE)) return [];
  const out = [];
  for (const name of readdirSync(WORKSPACE)) {
    if (name.startsWith('_') || name.startsWith('.') || !SITE_ID.test(name)) continue;
    const pages = join(WORKSPACE, name, 'pages');
    if (!isDir(pages)) continue;
    const names = readdirSync(pages).filter(p => isSafePageName(p) && isDir(join(pages, p)));
    const cloned = names.filter(p => isFile(join(pages, p, 'clone', 'index.html')));
    let lastActivity = 0;
    for (const p of cloned) { try { lastActivity = Math.max(lastActivity, statSync(join(pages, p, 'clone', 'index.html')).mtimeMs); } catch {} }
    const historicalVerified = (() => {
      try { return JSON.parse(readFileSync(join(WORKSPACE, name, 'verify', 'verify-summary.json'), 'utf8')).measured ?? null; } catch { return null; }
    })();
    out.push({ siteId: name, pages: names.length, cloned: cloned.length, verified: null, historicalVerified,
      verificationStatus: 'not_checked', lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null });
  }
  return out.sort((a, b) => b.cloned - a.cloned || a.siteId.localeCompare(b.siteId));
}

export function listPages(siteId) {
  const dir = join(siteDir(siteId), 'pages');
  if (!isDir(dir)) throw new CapabilityError('not_found', `没有站点 ${siteId}`, { nextActions: [nextAction('heimdall_overview', null, '列出已有站点')] });
  return readdirSync(dir).filter(p => isSafePageName(p) && isDir(join(dir, p))).sort();
}

export function readManifest(siteId, page) {
  try { return JSON.parse(readFileSync(join(pageDir(siteId, page), 'manifest.json'), 'utf8')); } catch { return null; }
}

/** 有镜像（参考）的页面才能做简报与对比 */
export function requireMirror(siteId, page) {
  const dir = pageDir(siteId, page);
  if (!isFile(join(dir, 'clone', 'index.html'))) {
    const target = readManifest(siteId, page)?.target;
    throw new CapabilityError('reference_missing', `${siteId}/${page} 还没有镜像`, {
      nextActions: [nextAction('heimdall_clone', target ? { url: target } : { siteId }, '先取得镜像（参考）')],
    });
  }
  return dir;
}

export function mirrorIdentity(siteId, page) {
  const identity = measurementIdentity(requireMirror(siteId, page), {}, 'agent-mirror');
  if (!identity) throw new CapabilityError('reference_missing', '无法核实镜像输入；请检查 manifest.json 和 clone/ 中的常规文件后重试');
  return identity.inputs;
}

/**
 * 某视口下镜像的入口文件（相对页面目录）。多视口克隆的 clone/index.html 是视口选择器，
 * 真正的页面是 index-375.html 等（clone-doc.mjs）；Phase 0 S4 实测选择器会在 DOMContentLoaded
 * 前跳到对应变体，但直接给变体更稳，也省一次跳转。
 */
export function mirrorEntry(siteId, page, width) {
  const dir = requireMirror(siteId, page);
  const variant = `clone/index-${width}.html`;
  return isFile(join(dir, variant)) ? variant : 'clone/index.html';
}
