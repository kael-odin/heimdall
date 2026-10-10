/**
 * types — 页面类型系统（共享：Atlas / Graph3D / 图例 / classify）
 *
 * 新增类型只需在此注册；图例从实际数据动态生成（无硬编码白名单）。
 *
 * 双主题色板：`color` 给深色观测场（星图画布、深色面板），`light` 给浅色主题。
 * 浅色主题下原来的高饱和霓虹（如 #22D3EE）在白底上只有 1.8:1 —— 文字不可读。
 * 每个 light 值都按 WCAG AA（小字 ≥4.5:1）在白底上校过。
 */
export const PAGE_TYPES = {
  marketing:   { color: '#22D3EE', light: '#0E7490', cn: '营销页' },
  pricing:     { color: '#F59E0B', light: '#B45309', cn: '定价页' },
  listing:     { color: '#8B5CF6', light: '#6D28D9', cn: '列表页' },
  blog:        { color: '#34D399', light: '#047857', cn: '博客/新闻' },
  product:     { color: '#F472B6', light: '#BE185D', cn: '产品页' },
  doc:         { color: '#7B8CA6', light: '#4B5563', cn: '文档' },
  help:        { color: '#FBBF24', light: '#A16207', cn: '帮助/FAQ' },
  tools:       { color: '#C084FC', light: '#7E22CE', cn: '工具页' },
  case_study:  { color: '#38BDF8', light: '#0369A1', cn: '客户案例' },
  career:      { color: '#A3E635', light: '#4D7C0F', cn: '招聘' },
  company:     { color: '#5EEAD4', light: '#0F766E', cn: '公司页' },
  auth:        { color: '#F87171', light: '#B91C1C', cn: '登录/控制台' },
  legal:       { color: '#64748B', light: '#475569', cn: '法务' },
  generic:     { color: '#94A3B8', light: '#64748B', cn: '通用页' },
};

const FALLBACK = { color: '#94A3B8', light: '#64748B' };

/**
 * @param {string} t 页面类型
 * @param {'dark'|'light'} [theme] 省略时给深色（星图画布用）
 */
export const typeColor = (t, theme = 'dark') => {
  const entry = PAGE_TYPES[t] ?? FALLBACK;
  return theme === 'light' ? entry.light : entry.color;
};
export const typeCn = (t) => PAGE_TYPES[t]?.cn ?? (t || '未知');
