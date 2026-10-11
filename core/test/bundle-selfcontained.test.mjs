/**
 * 交付包里的脚本必须自包含
 *
 * `live/serve.mjs` 与 `live/har.mjs` 会被 export.mjs **原样拷进交付包**，部署到别人的机器上运行。
 * 包里只有这两个文件 —— 任何指向上级目录（或包外任何位置）的 import 都会让
 * 部署出去的服务一启动就 `Cannot find module`。
 *
 * 这条守卫来自一次真实的破坏：把 12 个脚本里重复的 `argOf` 收进 `src/args.mjs` 时，
 * serve.mjs 也被顺手改成 `import { makeArgs } from '../args.mjs'` —— 在仓库里跑得好好的，
 * 一导出成包就再也起不来。单测全绿，问题只会在"交出去之后"出现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'live');
/** 会被拷进交付包的脚本（与 live/export.mjs 的 copyFileSync 一致） */
const BUNDLED = ['serve.mjs', 'har.mjs'];

/** 从源码里抽出所有 import 的说明符（`from '...'` 与裸 `import '...'`） */
function importsOf(text) {
  const out = [];
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

test('交付包脚本的 import 只能是 node: 内建或同目录文件', () => {
  const offenders = [];
  for (const f of BUNDLED) {
    const p = join(LIVE, f);
    if (!existsSync(p)) continue;
    for (const spec of importsOf(readFileSync(p, 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      // 同目录相对路径（./x.mjs）可以：export 时一起拷过去
      if (/^\.\/[^/]+$/.test(spec)) continue;
      offenders.push(`${f}: import '${spec}'`);
    }
  }
  assert.deepEqual(offenders, [],
    '这些 import 指向交付包之外，包部署出去会起不来：\n' + offenders.join('\n'));
});

test('守卫自身：认得出"指向包外"的 import，也放过 node: 与同目录', () => {
  const text = [
    "import { createServer } from 'node:http';",
    "import { indexHar } from './har.mjs';",
    "import { makeArgs } from '../args.mjs';",     // ← 就是这一种出过事
    "import { join } from 'node:path';",
  ].join('\n');
  const specs = importsOf(text);
  assert.deepEqual(specs, ['node:http', './har.mjs', '../args.mjs', 'node:path']);
  const bad = specs.filter(s => !s.startsWith('node:') && !/^\.\/[^/]+$/.test(s));
  assert.deepEqual(bad, ['../args.mjs']);
});
