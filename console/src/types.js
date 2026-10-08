/**
 * types — 页面类型系统（共享：Atlas / Graph3D / 图例 / classify）
 *
 * 新增类型只需在此注册；图例从实际数据动态生成（无硬编码白名单）。
 */
export const PAGE_TYPES = {
  marketing:   { color: '#22D3EE', cn: '营销页' },
  pricing:     { color: '#F59E0B', cn: '定价页' },
  listing:     { color: '#8B5CF6', cn: '列表页' },
  blog:        { color: '#34D399', cn: '博客/新闻' },
  product:     { color: '#F472B6', cn: '产品页' },
  doc:         { color: '#7B8CA6', cn: '文档' },
  help:        { color: '#FBBF24', cn: '帮助/FAQ' },
  tools:       { color: '#C084FC', cn: '工具页' },
  case_study:  { color: '#38BDF8', cn: '客户案例' },
  career:      { color: '#A3E635', cn: '招聘' },
  company:     { color: '#5EEAD4', cn: '公司页' },
  auth:        { color: '#F87171', cn: '登录/控制台' },
  legal:       { color: '#64748B', cn: '法务' },
  generic:     { color: '#94A3B8', cn: '通用页' },
};

export const typeColor = (t) => PAGE_TYPES[t]?.color ?? '#94A3B8';
export const typeCn = (t) => PAGE_TYPES[t]?.cn ?? (t || '未知');
