/**
 * args — 参数校验（回归：不得再"猜默认站点"）
 *
 * 背景（2026-10-09）：此前 14 个脚本把默认值写死成 apify.com / thordata.com，
 * 漏填参数时会静默地作用在错误站点上。此测试锁死"缺失即报错退出"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));

/** 以子进程运行某脚本并捕获退出码/输出 */
function run(rel, args = []) {
  const r = spawnSync(process.execPath, [join(CORE, rel), ...args], { cwd: CORE, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('args: 缺参数的脚本给用法并以非 0 退出，不留任何"默认站点"', () => {
  const cases = [
    ['src/crawler/capture.mjs'],
    ['src/crawler/recon.mjs'],
    ['src/crawler/build_clone.mjs'],
    ['src/crawler/shot_clone.mjs'],
    ['src/crawler/linker.mjs'],
    ['src/crawler/index-page.mjs'],
    ['src/crawler/fullshot.mjs'],
    ['src/crawler/build_live.mjs'],
    ['src/differ/diff.mjs'],
    ['src/differ/fixup.mjs'],
    ['src/differ/domdiff.mjs'],
    ['src/harvest/harvest.mjs'],
    ['src/harvest/xlsx.mjs'],
    ['src/deliver.mjs'],
    ['src/pipeline.mjs'],
  ];
  for (const [rel] of cases) {
    const r = run(rel);
    assert.notEqual(r.code, 0, `${rel} 缺参数时应非 0 退出`);
    assert.match(r.stderr, /用法:/, `${rel} 应在 stderr 给出用法`);
  }
});

test('args: 源码里不再残留写死的默认站点', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) {
        if (['node_modules', 'workspace', 'deliverable'].includes(name.name)) continue;
        walk(join(dir, name.name));
        continue;
      }
      if (!name.name.endsWith('.mjs')) continue;
      const p = join(dir, name.name);
      const src = readFileSync(p, 'utf8');
      // 形如 `?? 'apify.com'` / `?? join(WORKSPACE, 'apify.com', …)` 的兜底默认
      if (/process\.argv\[\d+\]\s*\?\?\s*'[a-z0-9-]+\.(com|io|dev|org|net)'/i.test(src)) offenders.push(p);
      if (/process\.argv\[\d+\]\s*\?\?\s*join\(WORKSPACE,\s*'[^']+'/i.test(src)) offenders.push(p);
    }
  };
  walk(join(CORE, 'src'));
  assert.deepEqual(offenders, [], '仍存在写死默认站点的脚本');
});
