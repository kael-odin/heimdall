/**
 * types — 页面类型系统（共享：Atlas / Graph3D / 图例 / classify）
 *
 * 新增类型只需在此注册；图例从实际数据动态生成（无硬编码白名单）。
 *
 * 双主题色板：`color` 给深色（暖炭面板、星图画布），`light` 给浅色（象牙底）。
 * 每个值都实测过两种用法：
 *   · 作为**文字/标签**在面板底上 ≥4.5:1（WCAG AA 小字）
 *   · 作为**星图节点**在画布上 ≥3:1（WCAG 非文本对比）
 * 深色侧对 #262624 的最低值是 legal 的 4.63:1；浅色侧对 #FAF9F5 的最低值是
 * marketing 的 5.02:1。（旧版霓虹青 #22D3EE 在白底上只有 1.67:1，等于不可见。）
 *
 * 色相选取偏向暖中性（黏土、赭、橄榄、青灰），与 Anthropic 的调性一致；
 * 但仍保证相邻类型在色相上可区分 —— 星图里它们是唯一的识别手段。
 */
export const PAGE_TYPES = {
  marketing:   { color: '#D98E6E', light: '#A8542C', cn: '营销页' },
  pricing:     { color: '#D9A05B', light: '#8A6420', cn: '定价页' },
  listing:     { color: '#C089B5', light: '#7A3F6B', cn: '列表页' },
  blog:        { color: '#A8B87A', light: '#5C6B3A', cn: '博客/新闻' },
  product:     { color: '#DB8FA3', light: '#9E4055', cn: '产品页' },
  doc:         { color: '#A9A69C', light: '#57564F', cn: '文档' },
  help:        { color: '#E0B070', light: '#8A5A1E', cn: '帮助/FAQ' },
  tools:       { color: '#B49BD6', light: '#6B4A9E', cn: '工具页' },
  case_study:  { color: '#6FB3B3', light: '#2F6B6B', cn: '客户案例' },
  career:      { color: '#BCCB86', light: '#566B25', cn: '招聘' },
  company:     { color: '#7FC4C0', light: '#2C6E6A', cn: '公司页' },
  auth:        { color: '#E08A7A', light: '#A33A2A', cn: '登录/控制台' },
  legal:       { color: '#918E86', light: '#6B6960', cn: '法务' },
  generic:     { color: '#A8A59C', light: '#605E57', cn: '通用页' },
};

/** 未注册类型与合成节点（已克隆但不在 atlas 里的页）用中性灰 */
const FALLBACK = { color: '#A8A59C', light: '#605E57' };

/**
 * @param {string} t 页面类型
 * @param {'dark'|'light'} [theme] 省略时给深色
 */
export const typeColor = (t, theme = 'dark') => {
  const entry = PAGE_TYPES[t] ?? FALLBACK;
  return theme === 'light' ? entry.light : entry.color;
};
export const typeCn = (t) => PAGE_TYPES[t]?.cn ?? (t || '未知');
export const FALLBACK_COLOR = FALLBACK;
