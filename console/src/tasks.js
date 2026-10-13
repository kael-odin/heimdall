/**
 * 任务行的判定（纯函数）—— 从 JobsView.vue 抽出来的唯一理由：**能被单测钉住**。
 *
 * 这里的两个规则都在回答同一个问题：**这一行产物属于哪个站点、能不能再对它做一步**。
 * 一旦控制台里出现第二份"从产出物反推站点身份"的实现，就会和引擎侧的目录命名分叉，
 * 而分叉的表现是最难查的那两类：按钮点了没反应、或者上游说"没有这个站"。
 * （同一课在 pages.js 的 liveUrl 上上过一次，见 console-pages.test.mjs。）
 */

/** 哪些 kind 意味着"这个站的页面已经克隆好了" —— 两个判定共用这一处词表 */
const CLONE_KINDS = ['clone', 'forge'];

/**
 * 从任务行推出站点 host。
 *
 * 规则必须与引擎侧那条一致：去协议、去 `www.`、去路径 —— 即 `/api/live-export`
 * 处理器里对 host 做的那三下。产物目录是按同一个规则命名的（`workspace/<host>/`），
 * 所以这里多带一个 `www.` 就会指向一个不存在的站点。
 * 非法 URL 返回空串而不是抛：任务行的 url 来自引擎，历史数据里什么都有。
 */
export function hostOfTask(t) {
  try { return new URL(t?.url ?? '').hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * 「导出交互镜像」按钮该不该出现在这一行。
 *
 * 它长在任务行上，是因为**克隆不产出交互镜像**：静态镜像是页面级产物（forge 一次就有，
 * 脚本剥掉、资源全本地化、离线可开），交互镜像是站点级的另一种东西（保留脚本、实时回源，
 * 外加一个可部署包），要显式导出一次才有 —— 见 ARCHITECTURE「两种镜像」。
 * 此前发现它的路径只有两条：点开某个页面的详情、或自己翻到报告页。
 *
 * 会话里的单页克隆**没有 kind 字段**（显示时由 kindCn 兜底成「克隆」），靠 pageName 认。
 */
export function canExportLive(t) {
  if (!t) return false;
  const done = t.status ? t.status === 'done' : (!!t.done && !t.failed);
  if (!done) return false;
  const cloneish = t.kind ? CLONE_KINDS.includes(t.kind) : !!t.pageName;
  return cloneish && !!hostOfTask(t);
}

/** 历史行能不能续跑：中断/失败，且有可重发的 kind 与 url。
 *  引擎重启会把 running 的旧任务标成 interrupted —— 那就该能一键续上，而不是让用户猜怎么重来。 */
export function canRetry(t) {
  return ['interrupted', 'failed'].includes(t?.status) && CLONE_KINDS.includes(t.kind) && !!t.url;
}

/**
 * 同类页面的中位克隆耗时 —— 用来回答"还要等多久"。
 *
 * 返回 `{ sec, scope }`，`scope` 是 `'host'` 或 `'all'`。
 * **两档要分开标出来**：实测在 example.com 上跑时本站样本只有 2 条，于是走了跨站兜底，
 * 屏幕上写着"同类中位 1:18"—— 而那一页其实 30 秒就完了。1:18 是 46 个 apify 页面的中位数
 * （它们重得多）。同一句文案下藏着两个不同的口径，正是这个项目里反复要修的那种读数问题：
 * 所以 'host' 时写「同类中位」，'all' 时写「跨站中位」，别让兜底冒充同类。
 *
 * **样本不够就返回 null**：宁可不显示，也不给一个编出来的预计时间。
 * 优先本站（≥3 条），不够才放宽到全部站点（≥5 条）；只统计真正跑完的。
 */
export function medianForgeSec(rows, host) {
  const secs = (list) => list.map(j => (j.endedAt - j.createdAt) / 1000)
    .filter(s => Number.isFinite(s) && s > 1)
    .sort((a, b) => a - b);
  const done = (rows ?? []).filter(j => j.kind === 'forge' && j.status === 'done' && j.endedAt > j.createdAt);
  const same = host ? secs(done.filter(j => hostOfTask(j) === host)) : [];
  const pick = (list) => Math.round(list[Math.floor(list.length / 2)]);
  if (same.length >= 3) return { sec: pick(same), scope: 'host' };
  const all = secs(done);
  return all.length >= 5 ? { sec: pick(all), scope: 'all' } : null;
}

export const RETRY_CN = { clone: '继续克隆', forge: '重新克隆' };
