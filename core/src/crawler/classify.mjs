/**
 * crawler/classify — 页面类型判定（纯函数：无 IO、无浏览器）
 *
 * 为什么独立成模块：recon.mjs 是顶层 await 的脚本，import 即执行，导不出函数就没法单测。
 * 类型判定的准确度直接影响两件事 —— 星图图例配色，以及 queue 的排除项（auth/legal 不批量克隆）。
 *
 * 旧实现只认英文路径，中文站（/价格、/关于我们、/帮助中心）会整站退化成 generic。
 * 现在：① 中英日常见词一起覆盖 ② 路径看不出时用 DOM 特征兜底 ③ 站点配方可追加规则。
 */

/** 顺序 = 从特异到宽泛。命中即返回。 */
export const TYPE_RULES = [
  ['pricing', /pricing|plans?|billing|packages?|价格|定价|套餐|费用|收费|报价|料金|価格/i],
  ['blog', /blog|news|article|posts?|press|changelog|release-notes|资讯|新闻|博客|文章|动态|公告|ブログ/i],
  ['case_study', /case-stud|customers?|success-stor|stories|客户案例|成功案例|案例|客户故事/i],
  ['career', /career|jobs?|hiring|recruit|vacanc|招聘|职位|加入我们|人才|採用/i],
  ['help', /help|faq|support|tutorial|university|academy|帮助|常见问题|支持|教程|问答|ヘルプ/i],
  ['doc', /docs?|documentation|guide|manual|reference|开发文档|接口文档|使用文档|文档|指南/i],
  ['tools', /tools?|free-|checker|generator|calculator|converter|工具|计算器|生成器/i],
  ['product', /products?|features?|solutions?|platform|产品|功能|解决方案|能力/i],
  ['listing', /store|marketplace|actors?|templates|integrations|apps|directory|showcase|plugins?|资源库|市场|模板|应用|集成|插件/i],
  ['auth', /login|signin|sign-?in|signup|sign-?up|register|account|console|dashboard|portal|admin|登录|登入|注册|账号|账户|控制台|后台/i],
  ['legal', /legal|terms|privacy|cookie|imprint|acceptable-use|gdpr|dmca|条款|隐私|协议|法律|声明|合规/i],
  ['company', /about|company|team|contact|partners?|关于|公司|团队|联系|我们/i],
];

/** 把配方的 extraRules（[{type, pattern}]）编译成正则；缺字段或坏正则一律跳过 */
export function compileExtraRules(rules) {
  return (rules ?? [])
    .map(r => {
      if (!r?.type || !r.pattern) return null;
      try { return { type: String(r.type), re: new RegExp(r.pattern, 'i') }; } catch { return null; }
    })
    .filter(Boolean);
}

/** 路径分类（先站点规则，再通用规则，最后按后缀/根路径判 marketing） */
export function pathOfType(path, extraRules = []) {
  for (const r of extraRules) if (r.re.test(path)) return r.type;
  for (const [type, re] of TYPE_RULES) if (re.test(path)) return type;
  if (/\.\w{2,4}$|^\/$|^\/?$/.test(path)) return 'marketing';
  return 'generic';
}

/**
 * DOM 特征兜底：路径看不出类型时（中文站、slug 化的 URL、/abc-123）用页面本身判断。
 * 只在路径给出 generic/marketing、且不是首页时介入 —— 首页就是营销页，别乱改。
 * @param {string} type 路径判定的结果
 * @param {string} path
 * @param {null|{passwordField?:boolean,priceHits?:number,tableCount?:number,form?:number,codeBlocks?:number,faq?:boolean,jobPosting?:boolean,headings?:number,article?:boolean}} f
 */
export function refineType(type, path, f) {
  if (!f || path === '/' || path === '') return type;
  if (type !== 'generic' && type !== 'marketing') return type;
  if (f.passwordField) return 'auth';
  if (f.codeBlocks >= 3 && f.form <= 1) return 'doc';
  if (f.faq && !f.priceHits) return 'help';
  if (f.priceHits >= 3 && f.tableCount >= 1) return 'pricing';
  if (f.jobPosting) return 'career';
  if (f.article && f.headings >= 4) return 'blog';
  return type;
}

/** 两步合一：recon 用这个 */
export function classifyPath(path, features, extraRules = []) {
  return refineType(pathOfType(path, extraRules), path, features);
}
