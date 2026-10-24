/**
 * handoff 交接说明 —— 只钉一件事：**没做到的要写在最前面**。
 *
 * 这份文字是整个交付包里唯一"承诺了这个包证明了什么"的地方。如果它把
 * 未测到的页写成"完成"，下游就会拿着没有测量结论的复刻件去开工。
 * 所以这里测的不是文案措辞，而是几种覆盖状态下的信息缺口有没有被如实说出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHandoff } from '../src/handoff-report.mjs';

const base = {
  siteId: 'example.test',
  origin: 'https://example.test',
  target: 'https://example.test/',
  gaps: null,
  delivered: 'example.test-2026-10-24',
};

test('handoff: 有未测页时，第一段就写明"没有测量结论"并列出卡点', () => {
  const md = renderHandoff({
    ...base,
    summary: {
      targetTotal: 120, measured: 96, bounded: 0, untested: 24, average: 0.9123,
      worst: { page: 'checkout', name: '375x812', score: 0.6 },
      blockers: { '还有请求一直没结束（长轮询 / 埋点 / 统计心跳）': 31, '滚动后页高还在增长（无限滚动 / 懒加载）': 5 },
    },
  });
  assert.match(md, /已发现 120 页/);
  assert.match(md, /完整测到 96 页/);
  assert.match(md, /没测到 24 页/);
  assert.match(md, /24 页没有数字/);
  assert.match(md, /不等于它们看起来没问题/);
  assert.match(md, /31 个视口/);
  assert.match(md, /滚动后页高还在增长/);
  assert.match(md, /91\.2%/);
  assert.match(md, /最差：`checkout` @ 375x812 60\.0%/);
  // 有未测页时，不能宣称"覆盖完整"
  assert.ok(!/覆盖完整，可以直接进人工检查/.test(md));
});

test('handoff: 有界置信度单独说明，不能被当成"完整测到"', () => {
  const md = renderHandoff({
    ...base,
    summary: { targetTotal: 10, measured: 10, bounded: 4, untested: 0, average: 0.8, blockers: {} },
  });
  assert.match(md, /其中有界置信度 4 页/);
  assert.match(md, /版面在观察窗口内已经定住/);
  assert.match(md, /背地里还在跑东西/);
});

test('handoff: --skip-verify 时明确说没有还原度数字', () => {
  const md = renderHandoff({ ...base, summary: null, skippedVerify: true });
  assert.match(md, /没有跑验证/);
  assert.match(md, /没有任何还原度数字/);
  // 必须给出补跑的命令，而不是让人干瞪眼
  assert.match(md, /verify <host> --all --resume/);
  assert.ok(!/站均还原度/.test(md));
});

test('handoff: 验证结果缺失但没标 skip 时，也说清数字不存在', () => {
  const md = renderHandoff({ ...base, summary: null });
  assert.match(md, /没有验证结果/);
  assert.ok(!/站均还原度：\*\*—/.test(md), '缺少结果时不该伪造一个破折号分数');
});

test('handoff: 资产报告被截断时必须写明扫了多少页', () => {
  const md = renderHandoff({
    ...base,
    summary: { targetTotal: 3, measured: 3, bounded: 0, untested: 0, average: 0.9, blockers: {} },
    gaps: { summary: { refs: 500, localized: 420, localizationRate: 0.84, visual: 12, visualOrigin: 9, visualThird: 3, pages: 60, clonedPages: 74, truncated: true } },
  });
  assert.match(md, /只扫了 60 页，磁盘上共 74 页/);
  assert.match(md, /84\.0%/);
});

test('handoff: 交付包缺失时不假装成功', () => {
  const md = renderHandoff({
    ...base, delivered: null,
    summary: { targetTotal: 1, measured: 1, bounded: 0, untested: 0, average: 1, blockers: {} },
  });
  assert.match(md, /交付包没有生成成功/);
  assert.ok(!/deliverable\/example\.test-/.test(md));
});
