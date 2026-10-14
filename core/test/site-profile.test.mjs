/**
 * site-profile — 站点配方（三层合并 / 运行时学习 / 正则规则编译）
 *
 * 用临时 HEIMDALL_DATA_DIR 隔离：绝不读写真实 workspace。
 * （必须在 import 之前设置 —— paths.mjs 在模块加载时解析目录）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'hd-profile-'));
process.env.HEIMDALL_DATA_DIR = dataDir;

const {
  DEFAULTS, deepMerge, loadProfile, recordLearned, invalidateProfileCache,
  compileRefRewrites, sanitizeHost, profilePaths, queuePlan,
} = await import('../src/site-profile.mjs');

const workspace = join(dataDir, 'workspace');
const writeLearned = (host, obj) => {
  mkdirSync(join(workspace, host), { recursive: true });
  writeFileSync(join(workspace, host, 'site.json'), JSON.stringify(obj, null, 2));
};

test('profile: deepMerge —— 对象递归合并，数组整体替换', () => {
  const a = { x: { y: 1, z: 2 }, arr: [1, 2, 3] };
  const b = { x: { z: 9 }, arr: [7] };
  assert.deepEqual(deepMerge(a, b), { x: { y: 1, z: 9 }, arr: [7] });
  assert.deepEqual(deepMerge(a, null, undefined), a, '非对象来源被忽略');
});

test('profile: 默认配方形状', () => {
  assert.equal(DEFAULTS.adapter, 'auto');
  assert.equal(DEFAULTS.live.stubStrategy, 'magic', '默认与改动前 thordata 行为一致');
  assert.deepEqual(DEFAULTS.queue.excludeTypes, ['auth', 'legal']);
  assert.ok(Array.isArray(DEFAULTS.css.refRewrites));
});

test('profile: 人工整理的内置配方压过运行时学到的', () => {
  invalidateProfileCache();
  writeLearned('apify.com', { live: { stubStrategy: 'magic' } });   // 学到的说 magic
  const p = loadProfile('apify.com', { fresh: true });
  assert.equal(p.live.stubStrategy, 'conservative', 'core/sites/apify.com.json 必须赢');
  assert.equal(p.host, 'apify.com');
});

test('profile: 三层合并 —— 学到的键在没人整理时生效', () => {
  invalidateProfileCache();
  writeLearned('nobody.test', { capture: { settleMs: 1234 }, queue: { excludeTypes: ['auth'] } });
  const p = loadProfile('nobody.test', { fresh: true });
  assert.equal(p.capture.settleMs, 1234, '学到的值覆盖默认');
  assert.equal(p.capture.scrollSweep, DEFAULTS.capture.scrollSweep, '未覆盖的默认保留');
  assert.deepEqual(p.queue.excludeTypes, ['auth']);
});

test('profile: 未知站点回落到纯默认（不抛错）', () => {
  invalidateProfileCache();
  const p = loadProfile('never-seen.example', { fresh: true });
  assert.equal(p.adapter, 'auto');
  assert.equal(p.notes, '');
  assert.equal(p.sources.learned, null);
});

test('profile: recordLearned 落盘并让缓存失效', () => {
  invalidateProfileCache();
  const file = recordLearned('learn.test', { learned: { adapterDetected: ['nextjs'] } });
  assert.ok(file && existsSync(file));
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.host, 'learn.test');
  assert.deepEqual(onDisk.learned.adapterDetected, ['nextjs']);
  assert.ok(onDisk.learnedAt, '带时间戳');

  const p = loadProfile('learn.test', { fresh: true });
  assert.deepEqual(p.learned.adapterDetected, ['nextjs']);

  // 增量：再次记录不应丢掉上一次的键
  recordLearned('learn.test', { learned: { pagesObserved: 3 } });
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(merged.learned.adapterDetected, ['nextjs'], '旧键保留');
  assert.equal(merged.learned.pagesObserved, 3);
});

test('profile: sanitizeHost 去掉 www、统一小写、剔除非法字符', () => {
  assert.equal(sanitizeHost('www.Example.com'), 'example.com');
  assert.equal(sanitizeHost('WWW.A.B'), 'a.b');
  assert.equal(sanitizeHost('a.b-c.io/../x'), 'a.b-c.io..x');   // 只保留 [a-z0-9.-]
  assert.equal(sanitizeHost(undefined), '');
});

test('profile: profilePaths 指向内置配方与运行时产物', () => {
  const p = profilePaths('apify.com');
  assert.equal(p.builtin, join(CORE, 'sites', 'apify.com.json'));
  assert.equal(p.learned, join(workspace, 'apify.com', 'site.json'));
});

test('profile: compileRefRewrites 编译 { from, to } 并跳过坏正则', () => {
  const rules = compileRefRewrites([
    { from: '^(https?://[^/]+)/media/', to: '$1/_next/static/media/' },
    { from: '([', to: 'x' },          // 坏正则：跳过
    { from: '^/a/', to: '/b/' },
    { to: '/no-from/' },              // 缺 from：跳过
  ]);
  assert.equal(rules.length, 2);
  assert.equal('https://h/media/f.woff2'.replace(rules[0].re, rules[0].to), 'https://h/_next/static/media/f.woff2');
  assert.equal('/a/x.png'.replace(rules[1].re, rules[1].to), '/b/x.png');
});

test('profile: 默认配方给出并发/超时基线', () => {
  assert.equal(DEFAULTS.queue.concurrency, 2);
  assert.ok(DEFAULTS.queue.pageTimeoutMs >= 60_000);
  assert.ok(DEFAULTS.queue.stallMs >= 30_000);
});

test('queuePlan: worker 数取 min(配方, 引擎槽) —— 多排的 worker 只会空转', () => {
  const p = { queue: { concurrency: 6 } };
  assert.equal(queuePlan(p, 8).workers, 6);
  assert.equal(queuePlan(p, 2).workers, 2, '引擎只有 2 槽时不该排 6 个 worker');
  assert.equal(queuePlan(p, 8).engineMax, 8);
});

test('queuePlan: 非法值退回默认并夹到边界', () => {
  assert.equal(queuePlan({ queue: { concurrency: 0 } }, 4).workers, 1);
  assert.equal(queuePlan({ queue: { concurrency: 999 } }, 4).workers, 4);
  assert.equal(queuePlan({ queue: { concurrency: 'x' } }, 4).workers, 2, '非法值退回默认 2');
  assert.equal(queuePlan({}, 99).engineMax, 8, '引擎槽位有硬上限');
  assert.equal(queuePlan({ queue: { pageTimeoutMs: 1 } }, 2).pageTimeoutMs, 10_000, '超时不能被配成 1ms');
});

test('queuePlan: all-discovered overrides default exclusions and page cap only when requested', () => {
  const normal = queuePlan(DEFAULTS, 2);
  assert.deepEqual(normal.excludeTypes, ['auth', 'legal']);
  assert.equal(normal.maxPages, 20);
  const all = queuePlan(DEFAULTS, 2, { allDiscovered: true });
  assert.deepEqual(all.excludeTypes, []);
  assert.equal(all.maxPages, null);
  assert.equal(all.workers, normal.workers);
});

test('queuePlan: 默认值下无进展线必须先于硬超时到达（否则那条线是死代码）', () => {
  const p = queuePlan({}, 2);
  assert.ok(p.stallMs < p.pageTimeoutMs, `stall(${p.stallMs}) 应小于 timeout(${p.pageTimeoutMs})`);
  // 留足余量：慢页面靠"持续输出"活着，无进展线不该贴着硬超时
  assert.ok(p.pageTimeoutMs - p.stallMs >= 60_000, '两条线之间至少留 1 分钟');
});

test.after(() => { rmSync(dataDir, { recursive: true, force: true }); });
