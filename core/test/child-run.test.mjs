/**
 * child-run — 子进程失败的上下文保留
 *
 * 这条守卫来自一次排查死路：任务历史里只有
 * `Error: crawler/build_clone.mjs exited 1`，原因是子进程 stderr 只流去了
 * 引擎控制台、没有留存。用户无从下手，我们事后翻 jobs.db 也只翻到同一句。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tailPush, tailText, runScript } = await import('../src/child-run.mjs');

test('tailPush: 只留最后 N 行，空行不算', () => {
  const t = [];
  tailPush(t, 'a\n\nb\n', 4);
  assert.deepEqual(t, ['a', 'b']);
  tailPush(t, 'c\nd\ne\n', 4);
  assert.deepEqual(t, ['b', 'c', 'd', 'e'], '超过 keep 要从头部丢');
});

test('tailPush: CRLF 与跨 chunk 的续行都能处理', () => {
  const t = [];
  tailPush(t, 'line1\r\nline2\r\n', 5);
  assert.deepEqual(t, ['line1', 'line2']);
  tailPush(t, 'Traceback', 5);
  tailPush(t, ' (most recent call last)', 5);
  assert.deepEqual(t, ['line1', 'line2', 'Traceback', '(most recent call last)'],
    '跨 chunk 的续行也是单独一行，不丢（行首空白会被去掉，拼成一句话时没意义）');
});

test('tailPush: 空输入 / 未初始化数组不炸', () => {
  assert.deepEqual(tailPush([], ''), []);
  assert.deepEqual(tailPush([], null), []);
  const t = tailPush(undefined, 'x');
  assert.deepEqual(t, ['x']);
});

test('tailText: 有尾巴时给出可读后缀，没有时是空串', () => {
  assert.equal(tailText([]), '');
  assert.equal(tailText(null), '');
  assert.match(tailText(['Error: ENOENT clone/assets']), /^：.*ENOENT/);
});

test('tailText: 超长尾巴截断（它要进 jobStore 与 SSE，不能无限长）', () => {
  const long = ['x'.repeat(1000)];
  assert.ok(tailText(long).length <= 401, '不能把 1KB 的栈原样塞进任务历史');
});

test('runScript: 失败时把 stderr 尾巴并进错误信息', async () => {
  // 真跑一个必定失败的命令：不存在的行为就是"子进程非 0 退出"
  await assert.rejects(
    () => runScript('test/fixtures/nope-does-not-exist.mjs', []),
    (e) => {
      assert.match(e.message, /nope-does-not-exist\.mjs exited [^0]/);
      assert.ok(e.message.length > 40, '要带上子进程自己说的话，而不是只有一句 exited 1');
      return true;
    },
  );
});
