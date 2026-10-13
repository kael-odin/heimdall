/**
 * format — 展示层格式化助手
 *
 * 抽出来的理由不是"文件太长"，而是这几个函数被多个视图用：
 * 分页表、任务中心、报告页的历史/资产表都要用同一套格式。
 * 复制一份的话，"视觉 99.1%" 与 "视觉 99.10%" 这种不一致迟早出现。
 *
 * 全部是纯函数，不做 IO、不碰响应式 —— 所以可以直接被组件 import，
 * 也可以被未来的单元测试直接喂值。
 */

/** 任务状态：failed > done > running */
export const taskState = (t) => (t?.failed ? 'failed' : t?.done ? 'done' : 'running');

const TASK_LABEL = { running: '运行中', done: '完成', failed: '失败' };
export const taskLabel = (t) => {
  if (t?.killed) return t.killed === 'stalled' ? '熔断 · 无进展' : '熔断 · 超时';
  const s = taskState(t);
  if (s === 'running' && t?.progress) return t.progress;   // 整站克隆这类有分子分母的，直接显示进度
  return TASK_LABEL[s] ?? '运行中';
};

export const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '');

/**
 * 历史时刻：**今天只给时分秒，更早的必须带上日期**。
 *
 * 只给时分秒的话，三天前的一条会和今天的一条长得一模一样 ——
 * 用户看着"刷新了也没变"的历史列表，其实分不清哪条是刚发生的
 * （这正是一次真实困惑的来源：任务中心那行 `03:37:43 · 31s` 究竟是今天的还是前天的？）。
 */
export const fmtStamp = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour12: false })
    : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

export const fmtDate = (t) => (t
  ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  : '—');

export const fmtBytes = (n) => (n == null ? '—'
  : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + 'KB'
  : n + 'B');

/** 耗时。进行中返回"进行中"而不是空串 —— 空串会让人以为任务卡住了。 */
export const fmtDuration = (t) => (t?.endedAt && t?.startedAt
  ? Math.round((t.endedAt - t.startedAt) / 1000) + 's'
  : (t?.startedAt ? '进行中' : ''));

/** 任务类型的中文名（任务中心与报告页共用） */
/**
 * 克隆的六个阶段。**键必须与 core 的 pipeline stage 名一致，顺序即显示顺序。**
 *
 * 放在这里而不是组件里：详情面板的阶段条、任务中心的进度串、新加的「进行中」轨道
 * 都要用它 —— 这份词表此前只存在于 DetailDock.vue，第二份实现必然与引擎分叉。
 */
export const FORGE_STAGES = { capture: '捕获骨架', build: '注入皮肤', shot: '渲染校准', fixup: 'AI 校准', diff: '像素定谳', harvest: '情报入库' };
export const FORGE_STAGE_KEYS = Object.keys(FORGE_STAGES);

/**
 * 从 `task.stages`（`{capture:'done', build:'running', …}`）推出进度：第几步 / 共几步 / 当前阶段。
 *
 * 这一步以前**根本没有做**，于是 forge 任务的 `task.progress` 永远是空的 ——
 * 任务中心、任务视图、页面行在整个 2-3 分钟里只显示一句常量「运行中」，
 * 而六个阶段名其实一直在 SSE 里推过来（整站克隆/审计/导出都赋了 progress，只有它没有）。
 *
 * 返回 null = 一个阶段都还没开始（不显示阶段轨，避免"0/6"这种空读数）。
 */
export function forgeStageProgress(stages) {
  if (!stages) return null;
  let done = 0, running = null, seen = 0;
  for (const k of FORGE_STAGE_KEYS) {
    const s = stages[k];
    if (s === 'done') done++;
    else if (s === 'running' && !running) { running = k; seen = done + 1; }
  }
  if (!done && !running) return null;
  const index = running ? seen : Math.min(done + 1, FORGE_STAGE_KEYS.length);
  const key = running ?? FORGE_STAGE_KEYS[index - 1];
  return { done, index, total: FORGE_STAGE_KEYS.length, key, label: FORGE_STAGES[key], finished: done === FORGE_STAGE_KEYS.length };
}

/** 阶段轨的一行文案：`3/6 · 渲染校准`。任务行窄，不用"第…步"这种完整句式。 */
export const stageProgressText = (p) => (p ? `${p.index}/${p.total} · ${p.label}` : '');

export const KIND_CN = {
  audit: 'SEO 审计',
  watch: '变更监控',
  assets: '资产扫描',
  matrix: '跨站对标',
  live: '交互镜像导出',
  verify: '保真验证',
  recon: '侦察',
  forge: '克隆',
  clone: '整站克隆',
  session: '登录会话',
  upgrade: '响应式升级',
  storage: '磁盘盘点',
  deliver: '交付包整理',
  editmanifest: '改站清单',
  'replace-domain': '域名替换',
  'cas-gc': 'CAS 资产回收',
};
export const kindCn = (k) => KIND_CN[k] ?? '克隆';

/**
 * 交互镜像导出的阶段名（引擎 live/export.mjs 的 live-stage 事件）。
 * 导出是唯一一个"跑很久但中途没有任何读数"的任务，所以阶段名要覆盖
 * 它真正耗时的每一步，用户才分得清"在拷贝"和"卡住了"。
 */
export const LIVE_STAGE_CN = {
  build: '生成镜像页',
  copy: '拷贝资产',
  har: '合并 HAR',
  heal: '补齐缺口',
  materialize: '本地化资源',
  health: '离线体检',
  package: '打包校验',
};
export const liveStageCn = (s) => LIVE_STAGE_CN[s] ?? s;
