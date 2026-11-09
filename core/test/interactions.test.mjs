import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreInteractions, discoverFn } from '../src/verify/interactions.mjs';

test('verify: interaction score aggregation', () => {
  assert.equal(scoreInteractions([]), null);
  assert.deepEqual(scoreInteractions([{ pass: true }, { pass: false }]), { total: 2, passed: 1, score: 0.5 });
  assert.equal(scoreInteractions([{ pass: true }, { pass: null, unverified: true }]), null);
});

/**
 * discoverFn 是**送进浏览器执行**的：`page.evaluate(discoverFn)` 会先把它 toString()，
 * 再到页面里 eval 一遍。所以它必须是自足的 —— 引用任何模块作用域的东西都会在
 * **真实抓取时**抛 ReferenceError，而这在这里是看不见的（本地测试很难触发那次页面执行）。
 *
 * 这条测试原来写成 `assert.ok(!src.includes('=> ({') === false || true);` ——
 * 恒为 true，等于什么都没断言（`|| true` 把整个表达式短路了）。
 * 现在改成两条真判据：能重新解析出来，且不引用模块作用域的任何顶层名字。
 */
test('verify: discover 函数自足 —— 能被序列化重建，且不引用模块作用域', () => {
  const src = discoverFn.toString();
  assert.ok(src.includes('querySelectorAll'), '前提：这确实是那个发现交互元素的函数');

  // ① 能被重新构造出来（类方法简写之类的写法到这一步就会失败）
  assert.doesNotThrow(() => new Function(`return (${src})`), 'discoverFn 必须能被单独序列化重建');

  // ② 不引用模块作用域的任何顶层绑定 —— 那些名字在页面里根本不存在
  const moduleSrc = readFileSync(new URL('../src/verify/interactions.mjs', import.meta.url), 'utf8');
  const topLevel = [...moduleSrc.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map(m => m[1])
    .filter(n => n !== 'discoverFn');
  assert.ok(topLevel.length > 0, '前提：解析到了模块的顶层绑定（否则这条断言会空转）');
  const leaked = topLevel.filter(n => new RegExp(`\\b${n}\\b`).test(src));
  assert.deepEqual(leaked, [], 'discoverFn 会被序列化后送进页面执行，不能引用模块作用域的：' + leaked.join(', '));
});
