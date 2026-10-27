/**
 * 重建脚手架（E7-01、E7-11）：每段一个样式文件，分段改动互相不波及其它段
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackFiles } from '../src/agent/rebuild/templates.mjs';

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
