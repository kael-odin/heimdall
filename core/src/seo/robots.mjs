/**
 * seo/robots — robots.txt 抓取规则的解析与匹配（RFC 9309），纯函数。
 *
 * 只回答「某个爬虫能不能抓这个地址」：SEO 用它判断 Googlebot 的抓取闸门，GEO 用它判断回答引擎能否取页。
 * 这是对被审计站点的分析；Heimdall 自己的采集不受 robots.txt 约束。
 */

/**
 * 给 AI 搜索 / 回答取页或建索引的爬虫：被拦下后，对应产品无法读到并引用这个页面。
 * zh 标记的两项只对中文页面计入结论（面向中文用户的回答引擎）。
 */
export const ANSWER_CRAWLERS = Object.freeze([
  { token: 'Googlebot', product: 'Google AI Overviews / AI Mode' },
  { token: 'Bingbot', product: 'Microsoft Copilot' },
  { token: 'OAI-SearchBot', product: 'ChatGPT 搜索' },
  { token: 'PerplexityBot', product: 'Perplexity' },
  { token: 'Claude-SearchBot', product: 'Claude 搜索' },
  { token: 'Baiduspider', product: '百度 AI 搜索 / 文心', zh: true },
  { token: 'Bytespider', product: '豆包 / 头条搜索', zh: true },
]);

/** 只为模型训练抓取语料的爬虫：是否放行是发布方的选择，不影响上面的答案引用，只作为证据列出。 */
export const TRAINING_CRAWLERS = Object.freeze(['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Applebot-Extended']);

/** 解析成分组：连续的 User-agent 行共用其后的规则；空的 Disallow 不构成限制。 */
export function parseRobots(text) {
  const groups = [];
  let current = null, naming = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '');
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!naming) { current = { agents: [], rules: [] }; groups.push(current); naming = true; }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      naming = false;
      if (value) current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

/** 路径模式：* 匹配任意字符，结尾的 $ 表示到此为止。规则来自被审计站点，所以逐段前进匹配，不交给正则回溯。 */
function matchesPath(pattern, target) {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!target.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    if (anchored && i === parts.length - 1) return target.length - parts[i].length >= at && target.endsWith(parts[i]);
    at = target.indexOf(parts[i], at);
    if (at < 0) return false;
    at += parts[i].length;
  }
  return !anchored || at === target.length;
}

/**
 * 某个爬虫能否抓取 url：先选点名它的分组（没有就用 *），组内取匹配最长的规则，等长时 Allow 优先；没有规则命中即允许。
 * 返回 { allowed, rule, agent }：rule 是生效的那一行，agent 是实际采用的分组。
 */
export function robotsAllows(groups, token, url) {
  const name = String(token).toLowerCase();
  const agent = groups.some(group => group.agents.includes(name)) ? name : '*';
  let target;
  try { const parsed = new URL(url); target = parsed.pathname + parsed.search; } catch { return { allowed: true, rule: null, agent }; }
  let best = null;
  for (const rule of groups.filter(group => group.agents.includes(agent)).flatMap(group => group.rules)) {
    if (!matchesPath(rule.path, target)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return { allowed: best ? best.allow : true, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null, agent };
}

/**
 * robots.txt 是否给出了可用的结论：读到了规则，或服务器明确回 4xx（RFC 9309：视为不限制）。
 * 429、5xx 与请求失败时爬虫各有处理（常见做法是暂按整站禁止），本次不下结论。
 */
export function robotsKnown(robots) {
  return robots?.ok === true || (robots?.status >= 400 && robots?.status < 500 && robots.status !== 429);
}
