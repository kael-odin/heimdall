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

/**
 * 体检进度：`体检 3/41 checkout · 87.2% · 最低 375x812 71.0% · 还剩约 4 分钟`
 *
 * 长度是这里唯一的难题：全站体检按小时计，用户盯着日志滚却不知道还剩多久。
 * 剩余时间只用"本次会话已完成的页"估算（`startedAt` 由调用方给），
 * 因为历史中位数会被不同站点的页混在一起，反而更不准。
 */
export function verifyPageProgress(event, { startedAt } = {}) {
  const result = typeof event.overall === 'number' && Number.isFinite(event.overall)
    ? event.measured === false ? '未完整测量' : (event.overall * 100).toFixed(1) + '%'
    : '未测到';
  const score = event.minViewport?.score;
  const minimum = typeof score === 'number' && Number.isFinite(score)
    ? ` · 最低 ${event.minViewport.name} ${(score * 100).toFixed(1)}%` : '';
  const total = Number(event.total);
  const index = Number(event.index);
  // --resume 复用的页也会发事件，但它不花时间 —— 不能拿它算平均页耗时
  const counted = Number.isFinite(index) && index > 0 && !event.reused;
  const counter = Number.isFinite(total) && total > 0 && Number.isFinite(index) && index > 0
    ? ` ${index}/${total}` : '';
  let eta = '';
  if (counted && Number.isFinite(total) && total > index && Number.isFinite(startedAt)) {
    const perPage = (Date.now() - startedAt) / index;
    const remainMs = perPage * (total - index);
    if (Number.isFinite(remainMs) && remainMs > 0) eta = ` · 还剩约 ${formatRemaining(remainMs)}`;
  }
  return `体检${counter} ${event.page} · ${result}${minimum}${eta}`;
}

/** 秒级剩余时间的人话写法：`40 秒` / `4 分钟` / `1 小时 20 分钟` */
function formatRemaining(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${Math.max(sec, 1)} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  return `${h} 小时 ${min % 60} 分钟`;
}

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

/**
 * 把"引擎那边发生了什么"翻成一句人话 + 一个下一步动作。
 *
 * 起因：控制台里十几处 `errMsg.value = String(e)`，用户看到的是
 * `TypeError: Failed to fetch`、`HTTP 500`、`busy` 这类字符串 —— 这些是给
 * 写代码的人看的，不是给"想克隆一个站"的人看的。而它们原本连技术细节都没丢，
 * 只是把同一串东西直接糊在屏幕中间。
 *
 * 返回 `{ msg, hint, detail }`：
 *   msg    —— 一句中文，说清"哪里没成"
 *   hint   —— 下一步该做什么（可空；有就必须是可执行的）
 *   detail —— 原始技术串，只进 <details>，不直接展示
 *
 * 只认几类在本地引擎这个场景下真正会发生的失败；认不出就退回原文（截断），
 * 绝不编一个"看起来像那么回事"的原因 —— 猜错的原因比没有原因更耽误事。
 */
export function userErrorText(raw, { what = '这个操作' } = {}) {
  const text = String(raw ?? '').trim();
  const detail = text.slice(0, 400);
  if (!text) return { msg: `${what}没有完成。`, hint: '重试一次；还不行就看引擎日志。', detail: '' };

  // 引擎没开 / 被防火墙挡 / 页面是从别的机器打开的：浏览器只会给一句 "Failed to fetch"
  if (/Failed to fetch|NetworkError|Load failed|ERR_CONNECTION|ECONNREFUSED|fetch failed|Network request failed/i.test(text)) {
    return {
      msg: '引擎没有响应，可能已经退出了。',
      hint: '先确认引擎还在运行（终端里那行 8900 端口的输出），重启后再试；日志在 core/workspace/_runs/ 下最新的 engine.log。',
      detail,
    };
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(text)) {
    return { msg: `${what}等太久，已经放弃。`, hint: '先单独跑一次看看是不是这一站特别慢；还超时就调大引擎的超时设置。', detail };
  }
  if (/\bHTTP 5\d\d\b|^internal\b/i.test(text)) {
    return { msg: '引擎内部出错了，任务没有跑完。', hint: '重试一次；同一个操作重复失败就带上下面的详情看引擎日志。', detail };
  }
  if (/\bbusy\b/.test(text)) {
    return { msg: '引擎正忙，这一轮没能开始。', hint: '等手上那个任务跑完（看底部「进行中」轨道），再点一次。', detail };
  }
  if (/\bHTTP 401\b|unauthor|invalid token/i.test(text)) {
    return { msg: '引擎拒绝了这次请求：口令不对。', hint: '到「设置 → 引擎 Token」重新填一遍，保存后会立即生效。', detail };
  }
  if (/\bHTTP 404\b/.test(text)) {
    return { msg: '引擎上没有这个接口或产物。', hint: '多半是引擎版本比控制台旧 —— 重启引擎后再试。', detail };
  }
  return { msg: `${what}没有完成。`, hint: '重试一次；还不行就展开详情，把技术信息一起看。', detail };
}

/**
 * 任务流断开（SSE 挂掉）时的统一说明。
 *
 * 断流必须**当失败处理**，不能只是悄悄关掉连接：任务行的状态是从流里读的，
 * 流一断它就永远停在最后那个阶段 —— 节点一直显示"克隆中"、底部「进行中」轨道不消失，
 * 而引擎那边其实早就结束了或者根本没在跑。
 *
 * 说清"哪一半没拿到"：引擎上的任务可能还在跑（SSE 断了不等于进程死了），
 * 所以下一步是"重连/刷新看看"，而不是"一定失败了"。
 */
export function streamBreakText({ what = '任务' } = {}) {
  return {
    msg: `${what}的进度流断了，已经没法继续显示它的进展。`,
    hint: '引擎上的任务可能还在跑：先刷新页面看任务中心这一行是否已结束；还停在"运行中"就重启引擎，再用「续跑」重新发起。',
    detail: 'EventSource closed: /api/events 连接中断',
  };
}

/** 引擎历史任务的状态词（JobsView 与任务中心共用；此前直接把 status 原样显示成英文） */
export const JOB_STATUS_CN = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  queued: '排队中',
};
export const jobStatusCn = (s) => JOB_STATUS_CN[s] ?? (s ? String(s) : '—');
