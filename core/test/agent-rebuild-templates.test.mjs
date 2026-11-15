/**
 * 重建脚手架（E7-01、E7-11）：每段一个样式文件，分段改动互相不波及其它段
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackFiles } from '../src/agent/rebuild/templates.mjs';
import { renderAgentsMd } from '../src/agent/rebuild/agents-md.mjs';

const ctx = {
  siteId: 'demo.test', page: 'home', port: 5199, title: 't', lang: 'zh-CN', effectiveBg: '#ffffff', tokensCss: ':root{--a:1}',
  sections: [{ id: 'sec-hero-aaaaaa', role: 'hero' }, { id: 'sec-footer-bbbbbb', role: 'footer' }, { id: 'sec-over-cccccc', role: 'overlay', overlay: true }],
};

test('rebuild scaffold: one stylesheet per section, overlays skipped', () => {
  const files = stackFiles('html-css', ctx);
  assert.ok(files['sections/sec-hero-aaaaaa.css'], 'each section gets its own file');
  assert.ok(files['sections/sec-footer-bbbbbb.css']);
  assert.equal(files['sections/sec-over-cccccc.css'], undefined, 'overlay sections are not in the flow');
  assert.match(files['index.html'], /href="\/sections\/sec-hero-aaaaaa\.css"/);
  assert.match(files['index.html'], /href="\/tokens\.css"[\s\S]*href="\/styles\.css"[\s\S]*href="\/sections\/sec-hero-aaaaaa\.css"/,
    'section sheets load after the global ones so they can override');
  assert.match(files['styles.css'], /全局样式/);
  assert.deepEqual(stackFiles('html-css', { ...ctx, sections: [] })['sections/sec-hero-aaaaaa.css'], undefined, 'no sections, no files');
});

test('rebuild contract routes AI to observed backend completion before guessing', () => {
  const agents = renderAgentsMd({
    ...ctx, url: 'https://demo.test/', fidelity: 'balanced', gate: { level: 'silver' }, budget: { maxIterationsPerSection: 4 },
    cli: 'node /heimdall/src/cli.mjs', devCommand: 'node serve.mjs', devUrl: 'http://127.0.0.1:5199',
    sections: ctx.sections.map(section => ({ ...section, boxes: { 1440: { y: 0, h: 100 } } })), gaps: [], overlays: [],
  });
  assert.match(agents, /site-assessment demo\.test --json/);
  assert.match(agents, /backend scaffold demo\.test --out \.\/backend-scaffold/);
  assert.match(agents, /backend-task\.json/);
  assert.match(agents, /保持 unknown/);
});
