/**
 * site-profile — 站点配方（Site Recipe）
 *
 * 目标：把"站点特化"从代码分支挤进数据，让换站不用改代码。
 *   core/sites/_default.json      内置默认（随仓库提交）
 *   core/sites/<host>.json        人工整理的内置配方（随仓库提交，优先级最高）
 *   workspace/<host>/site.json    运行时学到的配方（产物目录，gitignore）
 *
 * 合并顺序（后者覆盖前者）：DEFAULTS → workspace/<host>/site.json → core/sites/<host>.json
 * —— 人工整理的配方必须压过自动学到的，否则一次跑歪就会盖掉人工修正。
 *
 * 职责边界：**框架知识留在 adapters/**（nextjs 的 _next/_media 前缀偏移等由框架指纹推导），
 * **站点知识放这里**（这个站的弹窗选择器、挂件黑名单、stub 策略、队列排除项）。
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './paths.mjs';
import { readJson } from './fsutil.mjs';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILTIN_DIR = join(CORE, 'sites');

/**
 * 默认配方。
 * live.stubStrategy 默认 magic（递归 Proxy stub 一切挂件全局）——
 * 与改动前 thordata 的行为一致；apify 因 chunk 对无限递归 stub 挂死，在
 * core/sites/apify.com.json 里显式改为 conservative。
 */
export const DEFAULTS = {
  adapter: 'auto',
  capture: {
    waitUntil: 'domcontentloaded',
    timeoutMs: 45_000,
    scrollSweep: true,
    scrollStep: 800,
    scrollDelayMs: 120,
    settleMs: 3_000,
    consentButton: null,          // null = 用通用正则 /accept|agree|allow all|consent|dismiss/i
    removeSelectors: [],
  },
  css: {
    refRewrites: [],              // [{ from: '^/media/', to: '/_next/static/media/' }]
  },
  clone: {
    stripScripts: true,
    viewportVariants: [],         // 例如 [375, 768]；空 = 单快照
  },
  live: {
    stubStrategy: 'magic',        // magic（默认）| conservative（chunk 会挂死时用）
    stripScriptPatterns: [        // 脚本 URL 片段，命中即从交互镜像 HTML 中剥除
      'consent.cookiebot', 'cookiebot\\.com', 'crisp\\.chat', 'mixpanel',
      'cookiepro', 'onetrust', 'tiktok', 'redditstatic', 'clarity\\.ms',
      'googletagmanager', 'doubleclick', 'facebook\\.net', 'analytics\\.',
      'static\\.cloudflareinsights\\.com/beacon\\.min\\.js',
    ],
    inlineStripPatterns: ['CookieConsent', '\\$crisp', 'mixpanel'],
    thirdPartyAllow: [],
  },
  queue: {
    excludeTypes: ['auth', 'legal'], // --all-discovered 显式覆盖，普通批量模式仍跳过
    concurrency: 2,               // 本批并行锻造页数（引擎槽位不足时自动下调）
    maxPages: 20,                 // 新队列默认上限；--all-discovered 不截断
    pageTimeoutMs: 15 * 60_000,   // 单页硬超时：到点熔断，别让一页拖垮整批
    stallMs: 6 * 60_000,          // 单页无进展熔断：多久没有任何输出就判死
  },
  classify: {
    extraRules: [],               // [{ type: 'pricing', pattern: '价格|定价' }]
  },
  notes: '',
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 深合并：对象递归合并，数组整体替换（数组语义是"这一项的全量配置"） */
export function deepMerge(...sources) {
  const out = {};
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
    }
  }
  return out;
}


/** 配方文件路径（供控制台/CLI 展示与编辑） */
export const profilePaths = (host) => ({
  builtin: join(BUILTIN_DIR, host + '.json'),
  learned: join(WORKSPACE, sanitizeHost(host), 'site.json'),
});

export const sanitizeHost = (host) => String(host ?? '').trim().toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '');

const cache = new Map();

/**
 * 读取站点配方（合并三层）。结果按 host 缓存；`{ fresh: true }` 跳过缓存。
 * @param {string} host
 * @param {{fresh?: boolean}} [opts]
 */
export function loadProfile(host, opts = {}) {
  const h = sanitizeHost(host);
  if (!opts.fresh && cache.has(h)) return cache.get(h);
  const p = profilePaths(h);
  const merged = deepMerge(
    DEFAULTS,
    readJson(p.learned) ?? {},     // 运行时学到的
    readJson(p.builtin) ?? {},     // 人工整理（压过学到的）
  );
  merged.host = h;
  merged.sources = {
    default: DEFAULTS,
    learned: existsSync(p.learned) ? p.learned : null,
    builtin: existsSync(p.builtin) ? p.builtin : null,
  };
  cache.set(h, merged);
  return merged;
}

export function invalidateProfileCache(host) {
  if (host) cache.delete(sanitizeHost(host));
  else cache.clear();
}

/** 把"本次实跑观察到的参数"写入 workspace/<host>/site.json（不覆盖人工整理的内置配方） */
export function recordLearned(host, patch) {
  const h = sanitizeHost(host);
  if (!h) return null;
  const file = join(WORKSPACE, h, 'site.json');
  const prev = readJson(file) ?? {};
  const next = deepMerge(prev, { host: h, learnedAt: new Date().toISOString() }, patch);
  try {
    mkdirSync(dirname(file), { recursive: true });   // 站点目录可能尚未建立（单页 forge 后立即汇总）
    writeFileSync(file, JSON.stringify(next, null, 2));
    invalidateProfileCache(h);
    return file;
  } catch { return null; }
}

/** 把配方里的 { from, to } 规则编译成正则替换器（`from` 是正则源串） */
export function compileRefRewrites(rules) {
  const out = [];
  for (const r of rules ?? []) {
    if (!r?.from || typeof r.to !== 'string') continue;
    try { out.push({ re: new RegExp(r.from), to: r.to }); } catch { /* 无效正则：跳过 */ }
  }
  return out;
}

export const isConservative = (profile) => profile?.live?.stubStrategy === 'conservative';

/** 有界整数：非法值退回默认，再夹到 [lo, hi] */
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
};

/** 引擎槽位上限的硬边界 —— 每个锻造槽 = 一个 Chromium 实例，放开要有上限 */
export const MAX_SLOT_CEILING = 8;

/**
 * 把配方 + 引擎实际槽位算成一份"这批怎么跑"的计划。
 *
 * 为什么要夹：配方说并发 6 而引擎只有 2 个槽，多出的 worker 只会反复撞 409、
 * 空转重试 —— 看着并行、实际串行，还刷一堆日志。所以取 min。
 *
 * @param {object} profile loadProfile(host) 的结果
 * @param {number} engineMax 引擎 /api/status 报的 forge.max
 * @param {{allDiscovered?: boolean}} [options] 显式完整侦察范围模式
 */
export function queuePlan(profile, engineMax = 2, { allDiscovered = false } = {}) {
  const q = profile?.queue ?? {};
  const engineSlots = clampInt(engineMax, 1, MAX_SLOT_CEILING, 2);
  const want = clampInt(q.concurrency, 1, MAX_SLOT_CEILING, 2);
  return {
    workers: Math.max(1, Math.min(want, engineSlots)),   // worker 数 = min(配方, 引擎槽)
    want,
    engineMax: engineSlots,
    excludeTypes: allDiscovered ? [] : (q.excludeTypes ?? DEFAULTS.queue.excludeTypes),
    maxPages: allDiscovered ? null : clampInt(q.maxPages, 1, 2000, 20),
    pageTimeoutMs: clampInt(q.pageTimeoutMs, 10_000, 60 * 60_000, 8 * 60_000),
    stallMs: clampInt(q.stallMs, 15_000, 60 * 60_000, 4 * 60_000),
  };
}
