/**
 * 阶段进度的纯函数 —— 克隆"等待感"的底座。
 *
 * 守卫的来由是一次实测：一次 40 秒的单页克隆，在 t=2.5 / 8 / 20 秒三次采样里，
 * 屏幕上能看到的文字**完全一致**（状态条「克隆中 · home」+ 任务中心一行「home 运行中」），
 * 第 40 秒才跳成完成。原因是 forge 任务的 `task.progress` **从来没被赋过值** ——
 * 而六个阶段名一直在 SSE 里推过来，只渲染在一个要"选中该页 → 打开面板 → 切 tab"
 * 才看得见的地方。
 *
 * 下面钉住的是"从 stages 映射到第几步/当前阶段"的规则，外加两条边界：
 * **一个阶段都没开始时必须返回 null**（否则任务行会显示「1/6 · 捕获骨架」这种
 * 看着像已经开跑、其实还没动的读数），以及**跑完不许越界成 7/6**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { FORGE_STAGES, FORGE_STAGE_KEYS, forgeStageProgress, stageProgressText } = await import('../../console/src/format.js');

test('阶段词表与流水线一致：六个阶段，顺序即显示顺序', () => {
  assert.deepEqual(FORGE_STAGE_KEYS, ['capture', 'build', 'shot', 'fixup', 'diff', 'harvest']);
  assert.equal(FORGE_STAGES.capture, '捕获骨架');
  assert.equal(FORGE_STAGES.harvest, '情报入库');
});

test('还没开始 → null（不能显示成「1/6」）', () => {
  assert.equal(forgeStageProgress(null), null);
  assert.equal(forgeStageProgress({}), null);
  assert.equal(forgeStageProgress({ capture: 'idle', build: 'idle' }), null);
});

test('正在跑第 N 个阶段', () => {
  const p = forgeStageProgress({ capture: 'done', build: 'done', shot: 'running' });
  assert.equal(p.done, 2);
  assert.equal(p.index, 3);
  assert.equal(p.total, 6);
  assert.equal(p.key, 'shot');
  assert.equal(p.label, '渲染校准');
  assert.equal(stageProgressText(p), '3/6 · 渲染校准');
});

test('只有阶段完成、还没有 running 时指向下一个', () => {
  const p = forgeStageProgress({ capture: 'done' });
  assert.equal(p.index, 2);
  assert.equal(p.key, 'build');
  assert.equal(stageProgressText(p), '2/6 · 注入皮肤');
});

test('全部跑完停在最后一格（不越界到 7/6）', () => {
  const all = Object.fromEntries(FORGE_STAGE_KEYS.map(k => [k, 'done']));
  const p = forgeStageProgress(all);
  assert.equal(p.index, 6);
  assert.equal(p.finished, true);
  assert.equal(stageProgressText(p), '6/6 · 情报入库');
});

test('stageProgressText 对 null 安全 —— 任务行直接渲染它', () => {
  assert.equal(stageProgressText(null), '');
});
