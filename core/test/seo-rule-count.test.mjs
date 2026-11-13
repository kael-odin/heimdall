/**
 * 规则数守卫
 *
 * 文档与界面里那句「N 条规则」已经写错过两次：先是 "40+"（实际早已不止），
 * 再是 "56"（按源码数只有 54）。位数级的过期数字会让人整体不信这份文档，
 * 所以这里从源码里数出真实数量并钉住 —— 改规则时这条会红，逼着同步文档与界面。
 *
 * 数法：`A('id', ...)` / `S('id', ...)`（rules.mjs 的两个入口）与
 * `id: 'xxx'`（pagination / structured 两个校验模块返回的规则描述）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'seo');
const FILES = ['rules.mjs', 'pagination.mjs', 'structured.mjs'];

/** 规则总数 —— 改了规则就改这里，同时改 README / PRD / HANDOFF / 控制台里的同一句话 */
export const RULE_COUNT = 64;

function listRuleIds() {
  const ids = [];
  for (const f of FILES) {
    const text = readFileSync(join(SEO_DIR, f), 'utf8');
    for (const m of text.matchAll(/A\('([a-z-]+)'|S\('([a-z-]+)'|id:\s*'([a-z-]+)'/g)) ids.push(m[1] ?? m[2] ?? m[3]);
  }
  return ids;
}

test('规则数：与源码一致（不一致就说明文档里的数字又过期了）', () => {
  const ids = listRuleIds();
  assert.equal(ids.length, RULE_COUNT,
    `源码里有 ${ids.length} 条规则，常量写的是 ${RULE_COUNT} —— 请同步更新 RULE_COUNT 与文档/界面里的同一句话`);
});

/** 用户可见处提到规则数的地方 —— 这些地方必须与源码一致（历史文档里的旧数字不算，
 *  它们是按日期的存档，改了反而失真）。cli/mcp 就漏过一次：守卫只数了 seo/ 目录，
 *  而 "56 条规则" 还挂在 CLI 与 MCP 的工具描述里。 */
const MENTION_FILES = [
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs'),
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.mjs'),
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'registry', 'capabilities', 'seo-audit.mjs'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'console', 'src', 'Atlas.vue'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'console', 'src', 'DetailDock.vue'),
  // 仓库首页与上手导览也是"用户可见处"。此前守卫只覆盖代码与界面，
  // README 里的同一个数字没有任何东西看着 —— 而首页恰恰是最显眼、也最容易过期的地方。
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'guide', 'README.md'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'guide', '03-features.md'),
  // 演示稿是现场要念出来的话术，数字错了最尴尬；此前它写着 "53 条"（实际 66）却不在守卫里。
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'DEMO-SCRIPT.md'),
];

test('规则数：CLI / MCP / 控制台里写的数字也必须与源码一致', () => {
  const stale = [];
  for (const f of MENTION_FILES) {
    assert.ok(existsSync(f), `规则数守卫的用户可见文件缺失：${f}`);
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(\d+)\s*条规则|(\d+)-rule\b/g)) {
      if (Number(m[1] ?? m[2]) !== RULE_COUNT) stale.push(`${f.split(/[\\/]/).slice(-2).join('/')}: ${m[0]}`);
    }
  }
  assert.deepEqual(stale, [], `这些地方还在写旧数字：\n${stale.join('\n')}`);
});

test('规则数：id 不重复（重复的 id 会让报告筛选与基线对比串台）', () => {
  const ids = listRuleIds();
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], '同一 id 被多处发出：基线按 id 对比，会互相覆盖');
});

test('SEO 使用手册的评分和测量口径与当前实现一致', async () => {
  const { SEO_SCORE_METHOD_VERSION, SEO_MEASUREMENT_VERSION } = await import('../src/seo/method.mjs');
  const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'guide', '03-features.md'), 'utf8');
  assert.ok(guide.includes(`当前评分口径为 ${SEO_SCORE_METHOD_VERSION}，测量口径为 ${SEO_MEASUREMENT_VERSION}`));
  const baselineGuide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'seo-baseline', 'README.md'), 'utf8');
  assert.deepEqual([...new Set(baselineGuide.match(/--score-v\d+--measure-v\d+\.json/g))],
    [`--score-v${SEO_SCORE_METHOD_VERSION}--measure-v${SEO_MEASUREMENT_VERSION}.json`]);
  const example = JSON.parse(baselineGuide.match(/```json\s*([\s\S]*?)```/)[1]);
  assert.equal(example.scoreMethodVersion, SEO_SCORE_METHOD_VERSION);
  assert.equal(example.measurementVersion, SEO_MEASUREMENT_VERSION);
  const { renderHtml } = await import('../src/seo/report.mjs');
  const report = { host: 'example.com', origin: 'https://example.com', pages: [], siteIssues: [],
    summary: { pages: 0, bySeverity: {} }, categories: {}, config: {} };
  const current = renderHtml({ ...report, scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION });
  assert.match(current, /未分类、缓存及跨源限制/);
  assert.match(current, /JSON-LD 使用标准处理器/);
  assert.match(current, /canonical 同时核对/);
  const future = renderHtml({ ...report, scoreMethodVersion: SEO_SCORE_METHOD_VERSION + 1, measurementVersion: SEO_MEASUREMENT_VERSION + 1 });
  assert.match(future, /历史或未知测量口径可能遗漏 @graph/);
  assert.doesNotMatch(future, /canonical 同时核对|正文计数采用/);
});

test('规则数：id 用 <分类>-<slug> 形式，分类都在 CATEGORIES 里', async () => {
  const { CATEGORIES } = await import('../src/seo/rules.mjs');
  const cats = new Set(Object.keys(CATEGORIES));
  for (const id of listRuleIds()) {
    const c = id.split('-')[0];
    assert.ok(cats.has(c), `${id} 的分类前缀 "${c}" 不在 CATEGORIES 里`);
  }
});
