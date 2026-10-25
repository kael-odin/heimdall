/**
 * agent/resources — heimdall:// 资源解析（PRD 附录 A §3、03 §4.2）
 *
 * artifact 能力、MCP resources/read、HTTP GET /api/v1/artifacts 共用。所有读取先过 isSecretPath()，
 * 登录态、原始抓包、操作计划一律拒绝（E12-02）；路径必须落在数据根之内。
 *
 * Ph1 支持：
 *   heimdall://sites
 *   heimdall://site/{siteId}/page/{page}/brief{?detail,sectionId}
 *   heimdall://site/{siteId}/page/{page}/sections
 *   heimdall://site/{siteId}/page/{page}/ref/{viewport}.png{?y,h}
 *   heimdall://run/{runId}/fixpacket          修复包 JSON
 *   heimdall://run/{runId}/packet             修复包文本视图
 *   heimdall://run/{runId}/crop/{regionId}/composite.png
 *   heimdall://job/{jobId}                    （由能力层向引擎取）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_ROOT, isInside } from '../paths.mjs';
import { CapabilityError, nextAction } from './envelope.mjs';
import { sha256, RUN_ID, JOB_ID } from './ids.mjs';
import { isSecretPath } from './secrets.mjs';
import { assertPage, assertSiteId, listSites } from './workspace.mjs';
import { referenceDir } from './evidence/reference.mjs';
import { briefDir } from './brief/brief.mjs';
import { locateRun } from './evidence/compare.mjs';
import { crop, downscale, readPng, encodePng } from './evidence/image.mjs';

export const RESOURCE_TEMPLATES = Object.freeze([
  { uriTemplate: 'heimdall://sites', name: 'sites', title: '本机站点清单', mimeType: 'application/json' },
  { uriTemplate: 'heimdall://site/{siteId}/page/{page}/brief{?detail,sectionId}', name: 'brief', title: '页面简报（默认 outline）', mimeType: 'application/json' },
  { uriTemplate: 'heimdall://site/{siteId}/page/{page}/sections', name: 'sections', title: '分段计划', mimeType: 'application/json' },
  { uriTemplate: 'heimdall://site/{siteId}/page/{page}/ref/{viewport}.png{?y,h}', name: 'ref-shot', title: '参考截图（可纵向裁剪）', mimeType: 'image/png' },
  { uriTemplate: 'heimdall://run/{runId}/fixpacket', name: 'fixpacket', title: '修复包', mimeType: 'application/json' },
  { uriTemplate: 'heimdall://run/{runId}/packet', name: 'packet-text', title: '修复包文本视图', mimeType: 'text/plain' },
  { uriTemplate: 'heimdall://run/{runId}/crop/{regionId}/composite.png', name: 'crop', title: '区域裁剪对比图（参考 · 候选 · 差异）', mimeType: 'image/png' },
  { uriTemplate: 'heimdall://job/{jobId}', name: 'job', title: '任务状态', mimeType: 'application/json' },
]);

const SAFE_FILE = (root, file) => {
  const abs = resolve(file);
  if (!isInside(resolve(root), abs) || isSecretPath(abs)) throw new CapabilityError('forbidden', '这个资源不通过代理通道提供（秘密级或越界）');
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new CapabilityError('not_found', '资源不存在');
  return abs;
};

/** 解析 URI → { kind, mime, file?, bytes?, json?, params } ；不读大文件内容 */
export function resolveUri(uri) {
  let u;
  try { u = new URL(String(uri)); } catch { throw new CapabilityError('invalid_args', 'uri 不是合法的 heimdall:// 地址'); }
  if (u.protocol !== 'heimdall:') throw new CapabilityError('invalid_args', '只接受 heimdall:// 地址');
  // new URL('heimdall://site/a/page/b') → host 'site'，pathname '/a/page/b'
  const parts = [u.hostname, ...u.pathname.split('/').filter(Boolean)].map(decodeURIComponent);
  const q = Object.fromEntries(u.searchParams);
  if (parts[0] === 'sites' && parts.length === 1) return { kind: 'sites', mime: 'application/json', json: { sites: listSites() } };
  if (parts[0] === 'site' && parts[2] === 'page' && parts.length >= 5) {
    const siteId = assertSiteId(parts[1]), page = assertPage(parts[3]);
    if (parts[4] === 'brief' && parts.length === 5) return { kind: 'brief', mime: 'application/json', siteId, page, params: q };
    if (parts[4] === 'sections' && parts.length === 5) return { kind: 'sections', mime: 'application/json', siteId, page, file: SAFE_FILE(DATA_ROOT, join(briefDir(siteId, page), 'plan.json')) };
    if (parts[4] === 'ref' && parts.length === 6) {
      const m = parts[5].match(/^(375|768|1440)\.png$/);
      if (!m) throw new CapabilityError('invalid_args', '参考截图只有 375 / 768 / 1440 三个视口');
      return { kind: 'ref-shot', mime: 'image/png', siteId, page, viewport: Number(m[1]), file: SAFE_FILE(DATA_ROOT, join(referenceDir(siteId, page), `${m[1]}.png`)),
        params: { y: q.y !== undefined ? Number(q.y) : undefined, h: q.h !== undefined ? Number(q.h) : undefined } };
    }
  }
  if (parts[0] === 'run' && RUN_ID.test(parts[1] ?? '')) {
    const loc = locateRun(parts[1]);
    if (!loc) throw new CapabilityError('not_found', `没有运行 ${parts[1]}`);
    if (parts[2] === 'fixpacket' && parts.length === 3) return { kind: 'fixpacket', mime: 'application/json', siteId: loc.siteId, runId: parts[1], file: SAFE_FILE(DATA_ROOT, join(loc.dir, 'fixpacket.json')) };
    if (parts[2] === 'packet' && parts.length === 3) return { kind: 'packet-text', mime: 'text/plain; charset=utf-8', siteId: loc.siteId, runId: parts[1], file: SAFE_FILE(DATA_ROOT, join(loc.dir, 'packet.txt')) };
    if (parts[2] === 'crop' && parts.length === 5 && /^r\d{3,4}-\d{2}$/.test(parts[3]) && parts[4] === 'composite.png') {
      return { kind: 'crop', mime: 'image/png', siteId: loc.siteId, runId: parts[1], file: SAFE_FILE(DATA_ROOT, join(loc.dir, 'crops', `${parts[3]}.png`)) };
    }
  }
  if (parts[0] === 'job' && JOB_ID.test(parts[1] ?? '') && parts.length === 2) return { kind: 'job', mime: 'application/json', jobId: parts[1] };
  throw new CapabilityError('not_found', '不认识的资源地址', { nextActions: [nextAction('heimdall_overview', null, '从总览开始')] });
}

/**
 * 读取文件型资源：文本按 range 分段，图片可纵向裁剪（参考截图）、超过 maxBytes 时按比例缩小。
 * 返回 { uri, mime, bytes, sha256, text?, truncated, nextOffset?, image? }
 */
export function readFileResource(r, { range, maxBytes = 1_500_000 } = {}) {
  const buf = readFileSync(r.file);
  if (r.mime.startsWith('image/')) {
    let data = buf;
    let cropped = false, scaled = false;
    if (r.kind === 'ref-shot' && (r.params?.y !== undefined || r.params?.h !== undefined)) {
      const img = readPng(r.file);
      const y = Math.max(0, Math.min(img.height - 1, Math.floor(r.params.y ?? 0)));
      const h = Math.max(1, Math.min(img.height - y, Math.floor(r.params.h ?? 900)));
      data = encodePng(crop(img, 0, y, img.width, h));
      cropped = true;
    }
    if (data.length > maxBytes) {
      const img = readPng(r.file);
      const factor = Math.ceil(Math.sqrt(data.length / maxBytes));
      data = encodePng(downscaleBy(img, factor));
      scaled = true;
    }
    return { mime: r.mime, bytes: buf.length, sha256: sha256(buf), returnedBytes: data.length, cropped, scaled, image: { mimeType: 'image/png', data } };
  }
  const text = buf.toString('utf8');
  const offset = Math.max(0, range?.offset ?? 0), limit = Math.max(1, Math.min(200_000, range?.limit ?? 20_000));
  const slice = text.slice(offset, offset + limit);
  const truncated = offset + limit < text.length;
  return { mime: r.mime, bytes: buf.length, sha256: sha256(buf), text: slice, truncated, ...(truncated ? { nextOffset: offset + limit } : {}) };
}

function downscaleBy(img, k) {
  return downscale(img, Math.max(1, Math.floor(Math.max(img.width, img.height) / k)));
}

export function readJsonFile(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export { briefDir };
