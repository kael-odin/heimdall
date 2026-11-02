import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ACCEPTANCE_DEMO_PATHS, acceptanceDemoHtml, acceptanceDemoResponse } from '../src/acceptance/demo-pages.mjs';

test('four fixed demo paths contain identical shared content and healthy reference/fixed bytes', () => {
  assert.deepEqual(ACCEPTANCE_DEMO_PATHS, ['/reference', '/bug', '/partial', '/fixed']);
  assert.equal(acceptanceDemoHtml('/reference'), acceptanceDemoHtml('/fixed'));
  const publicMarkup = path => acceptanceDemoHtml(path).replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
  for (const path of ACCEPTANCE_DEMO_PATHS) {
    assert.equal(publicMarkup(path), publicMarkup('/reference'));
    assert.match(acceptanceDemoHtml(path), /本地固定示例/);
    assert.doesNotMatch(acceptanceDemoHtml(path), /https?:\/\/|fetch\(|XMLHttpRequest|WebSocket|setInterval|Math.random|Date\(/);
  }
  assert.throws(() => acceptanceDemoHtml('/unknown'), /Unknown/);
});

test('partial restores the reference visual style while keeping the inert menu behavior', () => {
  const style = path => acceptanceDemoHtml(path).match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.equal(style('/reference'), style('/partial'));
  assert.notEqual(style('/reference'), style('/bug'));
  assert.match(style('/bug'), /translateY\(100px\)/);
});

test('healthy menu click expands, updates ARIA and toggles back; defect/partial clicks stay inert', () => {
  for (const path of ACCEPTANCE_DEMO_PATHS) {
    let click;
    const menu = { hidden: true };
    const toggle = { attributes: { 'aria-expanded': 'false' },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { assert.equal(name, 'click'); click = callback; } };
    const document = { querySelector(selector) { assert.ok(['#menu', '#menu-toggle'].includes(selector)); return selector === '#menu' ? menu : toggle; } };
    vm.runInNewContext(acceptanceDemoHtml(path).match(/<script>([\s\S]*?)<\/script>/)[1], { document });
    assert.equal(typeof click, 'function'); click.call(toggle);
    const healthy = path === '/reference' || path === '/fixed';
    assert.equal(menu.hidden, !healthy); assert.equal(toggle.attributes['aria-expanded'], String(healthy));
    click.call(toggle); assert.equal(menu.hidden, true); assert.equal(toggle.attributes['aria-expanded'], 'false');
  }
});

test('request projection allows only exact fixed GET/HEAD paths and preserves correct HEAD length', () => {
  for (const path of ACCEPTANCE_DEMO_PATHS) {
    const get = acceptanceDemoResponse('GET', path), head = acceptanceDemoResponse('HEAD', path);
    assert.equal(get.status, 200); assert.equal(get.body.toString(), acceptanceDemoHtml(path));
    assert.equal(Number(get.headers['Content-Length']), get.body.length);
    assert.deepEqual(head.headers, get.headers); assert.equal(head.body.length, 0);
    assert.equal(get.headers['Cache-Control'], 'no-store');
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const denied = acceptanceDemoResponse(method, path); assert.equal(denied.status, 405); assert.equal(denied.headers.Allow, 'GET, HEAD');
    }
  }
  for (const path of ['/', '/health', '/api/result', '/reference/', '/reference?x=1', '/%72eference', '/x/../reference', '//reference']) {
    assert.equal(acceptanceDemoResponse('GET', path).status, 404, path);
  }
});
