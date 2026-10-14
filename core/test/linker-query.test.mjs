import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runLinker(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/crawler/linker.mjs', import.meta.url)), 'x.test'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
    });
    let output = '';
    child.stdout.on('data', x => { output += x; });
    child.stderr.on('data', x => { output += x; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('linker routes pages by full URL including query', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-linker-'));
  const base = join(dataDir, 'workspace', 'x.test', 'pages');
  try {
    for (const [name, target, html] of [
      ['list-one', 'https://x.test/list?page=1', '<a href="/list?page=2#section" target="_blank" rel="noopener">two</a><a href="/list?page=3" rel="nofollow">three</a><a href="/list?page=1#here" target="_blank">self</a><a href="https://x.test/list-two/clone/index.html" target="_blank" rel="noopener">legacy</a><a href="https://x.test.evil.test/list-two/clone/index.html">evil</a>'],
      ['list-two', 'https://x.test/list?page=2', '<p>two</p>'],
    ]) {
      const dir = join(base, name);
      mkdirSync(join(dir, 'clone'), { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target }));
      writeFileSync(join(dir, 'clone', 'index.html'), html);
      if (name === 'list-one') writeFileSync(join(dir, 'clone', 'index-375.html'), html);
    }
    const { code, output } = await runLinker(dataDir);
    assert.equal(code, 0, output);
    const html = readFileSync(join(base, 'list-one', 'clone', 'index.html'), 'utf8');
    assert.match(html, /<a href="\.\.\/\.\.\/list-two\/clone\/index\.html#section">two<\/a>/);
    assert.match(html, /<a href="https:\/\/x\.test\/list\?page=3" rel="nofollow noopener" target="_blank">three<\/a>/);
    assert.match(html, /<a href="index\.html#here">self<\/a>/);
    assert.match(html, /<a href="\.\.\/\.\.\/list-two\/clone\/index\.html">legacy<\/a>/);
    assert.match(html, /href="https:\/\/x\.test\.evil\.test\/list-two\/clone\/index\.html"/);
    const mobile = readFileSync(join(base, 'list-one', 'clone', 'index-375.html'), 'utf8');
    assert.match(mobile, /href="\.\.\/\.\.\/list-two\/clone\/index\.html#section"/);
    const again = await runLinker(dataDir);
    assert.equal(again.code, 0, again.output);
    assert.equal(readFileSync(join(base, 'list-one', 'clone', 'index-375.html'), 'utf8'), mobile);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
