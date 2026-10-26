/**
 * agent/loops/ledger — 飞行记录的读取与分组（E7-08 / E7-10 共用）
 *
 * `rebuild` 每次 compare 往项目里的 `.heimdall/ledger.jsonl` 追加一行 type=iter。
 * 这里把「读、按分段分组、跑收敛控制器」收在一处，`rebuild status` 与交付都走同一套判断，
 * 免得两边对「这一段到底该继续还是接受残差」给出不同答案。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './converge.mjs';

export function readLedger(projectDir) {
  const file = join(projectDir, '.heimdall', 'ledger.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** 分组键：单个分段用它的 id，多段合并与整页各有自己的桶 */
export const keyOf = (entry) => (entry.sectionIds?.length === 1 ? entry.sectionIds[0] : (entry.sectionIds ? entry.sectionIds.join('+') : 'page'));

/** → Map<key, { entries, iterations, last, best }> */
export function groupBySection(entries) {
  const bySection = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    const s = bySection.get(key) ?? { entries: [], iterations: 0, last: null, best: null };
    s.entries.push(e);
    s.iterations++;
    s.last = e;
    const minPx = Math.min(...Object.values(e.pixel ?? {}));
    if (!s.best || minPx > s.best.minPixel) s.best = { runId: e.runId, minPixel: minPx, verdict: e.verdict };
    bySection.set(key, s);
  }
  return bySection;
}

/** 每个桶的收敛判断；scope 默认按桶名（page 桶按整页上限） */
export function decisionsFor(entries, budget) {
  const out = [];
  for (const [key, s] of groupBySection(entries)) {
    const d = decide(s.entries, { scope: key === 'page' ? 'page' : 'section', budget });
    out.push({ key, entries: s.entries.length, last: s.last, best: s.best, ...d });
  }
  return out;
}
