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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'seo');
const FILES = ['rules.mjs', 'pagination.mjs', 'structured.mjs'];

/** 规则总数 —— 改了规则就改这里，同时改 README / PRD / HANDOFF / 控制台里的同一句话 */
export const RULE_COUNT = 66;

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

test('规则数：id 不重复（重复的 id 会让报告筛选与基线对比串台）', () => {
  const ids = listRuleIds();
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], '同一 id 被多处发出：基线按 id 对比，会互相覆盖');
});

test('规则数：id 用 <分类>-<slug> 形式，分类都在 CATEGORIES 里', async () => {
  const { CATEGORIES } = await import('../src/seo/rules.mjs');
  const cats = new Set(Object.keys(CATEGORIES));
  for (const id of listRuleIds()) {
    const c = id.split('-')[0];
    assert.ok(cats.has(c), `${id} 的分类前缀 "${c}" 不在 CATEGORIES 里`);
  }
});
