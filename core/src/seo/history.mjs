/**
 * seo/history — 分数走势（时间序列）
 *
 * 已有的东西回答的是"现在多少分"（score.json）、"比上次变差了吗"（baseline 回归门禁）、
 * "站点改了没有"（watch）。缺的是**趋势**：连续几次是往上还是往下。
 * 回归门禁只看相邻两次，看不出"三个月里每次掉一点"。
 *
 * 存储很轻：`workspace/<host>/history.json`，一个追加式数组，按站点分文件。
 * 写用「临时文件 + rename」—— 进程中途被杀不会留下半截 JSON，
 * 而历史恰恰是最不该因为一次 crash 就整体丢的东西。
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

const LIMIT = 300;   // 每站最多留这么多点；再多也没人看，还会拖慢控制台

export const historyPath = (host) => join(WORKSPACE, host, 'history.json');

/** 读历史（新→旧）。文件不存在或坏了都返回空数组 —— 历史是增强项，不该让审计失败。 */
export function readHistory(host, { limit = LIMIT } = {}) {
  try {
    const arr = JSON.parse(readFileSync(historyPath(host), 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.slice(-limit);
  } catch { return []; }
}

/**
 * 追加一条记录并落盘。
 * @param {string} host
 * @param {{kind:'audit'|'clone', score?:number, grade?:string, pages?:number, issues?:number,
 *          critical?:number, high?:number, avgPixel?:number, note?:string}} rec
 */
export function appendHistory(host, rec) {
  if (!host || !rec?.kind) return null;
  const p = historyPath(host);
  const prev = readHistory(host, { limit: LIMIT });
  const entry = {
    at: new Date().toISOString(),
    kind: rec.kind,
    ...('score' in rec ? { score: rec.score } : {}),
    ...(Number.isSafeInteger(rec.scoreMethodVersion) && rec.scoreMethodVersion > 0 ? { scoreMethodVersion: rec.scoreMethodVersion } : {}),
    ...('grade' in rec ? { grade: rec.grade } : {}),
    ...('pages' in rec ? { pages: rec.pages } : {}),
    ...('issues' in rec ? { issues: rec.issues } : {}),
    ...('critical' in rec ? { critical: rec.critical } : {}),
    ...('high' in rec ? { high: rec.high } : {}),
    ...('avgPixel' in rec ? { avgPixel: rec.avgPixel } : {}),
    ...(rec.note ? { note: String(rec.note).slice(0, 120) } : {}),
  };
  const next = [...prev, entry].slice(-LIMIT);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 1));
    renameSync(tmp, p);          // 原子替换：崩在中途也保住上一份完整历史
    return entry;
  } catch { return null; }
}

/**
 * 取出某个 kind 的分数序列（旧→新），供画走势用。
 * @param {Array} history readHistory 的结果
 * @param {'audit'|'clone'} kind
 * @param {'score'|'avgPixel'} field
 */
export function series(history, kind, field = 'score') {
  const records = (history ?? []).filter(h => h.kind === kind && typeof h[field] === 'number');
  if (kind !== 'audit' || field !== 'score' || !records.length) return records.map(h => ({ at: h.at, v: h[field] }));
  const version = records.at(-1).scoreMethodVersion;
  const compatible = Number.isSafeInteger(version) && version > 0
    ? records.filter(h => h.scoreMethodVersion === version) : records.slice(-1);
  return compatible.map(h => ({ at: h.at, v: h[field] }));
}

/** 走势的一句话结论：只比首尾，避免"一直在动"的错觉 */
export function trendNote(points) {
  if (!points || points.length < 2) return points?.length === 1 ? '只有一个数据点，再跑一次才有走势。' : '还没有数据。';
  const first = points[0].v, last = points[points.length - 1].v;
  const d = +(last - first).toFixed(1);
  const span = points.length;
  if (Math.abs(d) < 0.5) return `${span} 次记录基本持平（${first} → ${last}）。`;
  return `${span} 次记录${d > 0 ? '上升' : '下降'} ${Math.abs(d)} 分（${first} → ${last}）。`;
}
