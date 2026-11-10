/**
 * agent/activity — 「AI 活动」视图的数据快照（E11-03）
 *
 * 控制台不直接读盘：它问引擎要一份快照，引擎只读**工作区之内**的重建目录。
 * 快照里都是已经存在的东西，不额外采集：
 *   · 每次对比的账本（`.heimdall/ledger.jsonl`）→ 分数序列与每段状态
 *   · 分段计划（`.heimdall/sections/<page>.json`）→ 段的顺序与位置
 *   · 六维门禁 `agent/gate/<page>/gate-*.json` 与正式裁判 `formal-*.json`
 *   · 交付包 `agent/deliver/<run>/delivery.json`
 *
 * 演示要的就是这些：分数曲线在动、分段方块变绿、门禁逐维亮起、最后有交付。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { WORKSPACE, isInside } from '../paths.mjs';
import { isSafePageName } from '../page-name.mjs';
import { latestFormalGate } from './gate/attempt.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const readLines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const latestBy = (dir, re, projectDir) => {
  try {
    const files = readdirSync(dir).filter(n => re.test(n)).map(n => ({ n, mtime: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      const gate = readJson(join(dir, file.n));
      if (gate?.projectDir && resolve(gate.projectDir) === projectDir) return gate;
    }
    return null;
  } catch { return null; }
};

/** 工作区里所有重建目录（含 heimdall.config.json），最多扫四层 */
export function listProjects() {  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= 40) return;
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      // 交付包里的项目是拷贝，不是工作区：列出来只会让选择器变乱
      if (p.includes(`${sep}agent${sep}deliver${sep}`)) continue;
      if (existsSync(join(p, 'heimdall.config.json'))) {
        const cfg = readJson(join(p, 'heimdall.config.json'));
        out.push({ dir: p, siteId: cfg?.siteId ?? null, page: cfg?.pages?.[0]?.name ?? null, stack: cfg?.stack ?? null });
      } else walk(p, depth + 1);
    }
  };
  walk(WORKSPACE, 0);
  return out;
}

/** 修复包 → 活动页用的精简摘要：只留前几条区域与样式差，避免把整包 JSON 塞进每 2 秒的轮询。 */
export function compactFixPacket(packet, { maxRegions = 3, maxDiffs = 4 } = {}) {
  if (!packet) return null;
  const regions = [];
  for (const id of (packet.order ?? []).slice(0, maxRegions)) {
    const r = (packet.regions ?? []).find(x => x.id === id);
    if (!r) continue;
    const best = r.element?.best?.[0];
    const diffs = [];
    const seen = new Set();
    for (const e of [best, ...(r.element?.diffs ?? [])]) {
      for (const d of e?.styleDiff ?? []) {
        if (seen.has(d.prop)) continue;
        seen.add(d.prop);
        diffs.push({ prop: d.prop, ref: d.ref, cand: d.cand, ...(typeof d.delta === 'number' ? { delta: d.delta } : {}) });
        if (diffs.length >= maxDiffs) break;
      }
      if (diffs.length >= maxDiffs) break;
    }
    regions.push({
      id: r.id, sectionId: r.sectionId ?? null, cause: r.cause ?? null, severity: r.severity ?? null,
      bbox: r.bbox ?? null, hint: r.hint ?? null, ref: best?.ref ?? null, diffs,
    });
  }
  return { runId: packet.runId ?? null, at: packet.generatedAt ?? null, verdict: packet.verdict?.status ?? null, regions };
}

/** 一个重建目录的活动快照；路径必须在工作区内 */
export function activityOf(projectDir) {
  const dir = resolve(String(projectDir ?? ''));
  if (!isInside(WORKSPACE, dir)) throw new Error('项目必须在工作区内');
  const cfg = readJson(join(dir, 'heimdall.config.json'));
  if (!cfg) throw new Error('这个目录不是重建工作区（缺 heimdall.config.json）');
  const page = cfg.pages?.[0]?.name;
  if (!page || !isSafePageName(page)) throw new Error('配置里的页面名不合法');

  const ledger = readLines(join(dir, '.heimdall', 'ledger.jsonl')).filter(e => e.type === 'iter');
  const plan = readJson(join(dir, '.heimdall', 'sections', `${page}.json`));
  const sections = (plan?.sections ?? []).filter(s => !s.overlay);

  const viewports = cfg.viewports ?? [375, 768, 1440];
  // 曲线只画整页对比：分段对比的分数跟整页不在一个尺度上，混在一起会像心电图
  const pageLevel = ledger.filter(e => !e.sectionIds?.length);
  const curve = pageLevel.length ? pageLevel : ledger;
  const series = Object.fromEntries(viewports.map(w => [w, curve.map(e => (typeof e.pixel?.[w] === 'number' ? +(e.pixel[w] * 100).toFixed(2) : null))]));

  const bySection = new Map();
  for (const e of ledger) {
    const keys = e.sectionIds?.length ? e.sectionIds : ['page'];
    for (const k of keys) {
      const s = bySection.get(k) ?? { iterations: 0, last: null, best: null };
      s.iterations += 1;
      s.last = e;
      const min = Math.min(...Object.values(e.pixel ?? {}).filter(v => typeof v === 'number'));
      if (!s.best || min > s.best.minPixel) s.best = { minPixel: +min.toFixed(5), runId: e.runId, verdict: e.verdict };
      bySection.set(k, s);
    }
  }

  const gateDir = join(WORKSPACE, cfg.siteId, 'agent', 'gate', page);
  const deliverDir = join(WORKSPACE, cfg.siteId, 'agent', 'deliver');
  const delivery = (() => {
    try {
      const dirs = readdirSync(deliverDir).map(n => ({ n, mtime: statSync(join(deliverDir, n)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
      for (const { n } of dirs) {
        const d = readJson(join(deliverDir, n, 'delivery.json'));
        if (d?.projectDir && resolve(d.projectDir) === dir) return { state: d.state, reason: d.reasonText ?? d.reason, at: d.generatedAt, dir: join(deliverDir, n) };
      }
      return null;
    } catch { return null; }
  })();

  // 最近一次修复包与最近一次「有差异」的修复包：最新一次常常是干净的收尾 compare，
  // 活动页要展示的是上一次真正指出问题的包，否则演示时只看到「没有区域」。
  const { latest, lastActionable } = (() => {
    let latest = null, lastActionable = null;
    for (let i = ledger.length - 1; i >= Math.max(0, ledger.length - 10); i--) {
      const runId = ledger[i]?.runId;
      if (!runId) continue;
      const packet = readJson(join(dir, '.heimdall', 'runs', runId, 'fixpacket.json'));
      if (!packet) continue;
      const compact = compactFixPacket(packet);
      if (!latest) latest = compact;
      if (!lastActionable && (packet.regions?.length || packet.order?.length)) lastActionable = compact;
      if (latest && lastActionable) break;
    }
    return { latest, lastActionable };
  })();

  return {
    schema: 'heimdall.activity/1',
    generatedAt: new Date().toISOString(),
    project: { dir, siteId: cfg.siteId, page, stack: cfg.stack, level: cfg.gate?.level ?? 'silver', viewports },
    totals: { iterations: ledger.length, sections: sections.length },
    series,
    sections: sections.map(s => {
      const st = bySection.get(s.id);
      return {
        id: s.id, role: s.role, box: s.boxes?.[1440] ?? null,
        iterations: st?.iterations ?? 0,
        verdict: st?.last?.verdict ?? 'not-started',
        reached: st?.last?.reached ?? null,
        minPixel: st?.last ? +(Math.min(...Object.values(st.last.pixel ?? {}).filter(v => typeof v === 'number')) * 100).toFixed(2) : null,
        best: st?.best ? { pixel: +(st.best.minPixel * 100).toFixed(2), runId: st.best.runId } : null,
        at: st?.last?.at ?? null,
      };
    }),
    recent: ledger.slice(-40).map(e => ({ runId: e.runId, at: e.at, verdict: e.verdict, reached: e.reached ?? null, trend: e.trend ?? null, anticheat: e.anticheat ?? null,
      sectionIds: e.sectionIds ?? null, pixel: Object.fromEntries(Object.entries(e.pixel ?? {}).map(([w, v]) => [w, +(v * 100).toFixed(2)])) })),
    gate: { fast: latestBy(gateDir, /^gate-.*\.json$/, dir), formal: latestFormalGate(cfg.siteId, page, dir) },
    delivery,
    latest,
    lastActionable,
  };
}
