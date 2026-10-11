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
