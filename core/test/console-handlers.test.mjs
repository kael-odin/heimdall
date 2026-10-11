/**
 * 控制台模板里绑的 handler 必须真的存在
 *
 * 这条守卫来自一个真实故障：详情面板绑了 `@open-forge="openForge"`，而**这个函数从来没定义过**。
 * 于是「开始克隆此页 / 重新克隆此页」三个按钮点了没反应，控制台里只有一条 TypeError
 * —— Vue 模板里的一切都是运行时属性查找，编译器不会为此报错。
 *
 * 判"存在"必须找**定义**（`function NAME` / `const NAME = …`），不能只找"这个名字出现过"：
 * 第一版就是这么写的，于是把名字写在注释里也算通过 —— 实测把函数改名之后测试依然全绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'console', 'src');

/** 模板里以"裸标识符"或"标识符(...)"形式出现的 handler（内联表达式、箭头函数一律跳过） */
function handlersIn(template) {
  const out = new Map();
  for (const m of template.matchAll(/(?:@|v-on:)([a-z][\w.-]*)\s*=\s*"([^"]*)"/gi)) {
    const expr = m[2].trim();
    const name = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr)?.[1] ?? (/^[A-Za-z_$][\w$]*$/.exec(expr)?.[0] ?? null);
    // `$emit('x')` / `$event` 这类模板内建不是"脚本里定义过的函数"，不算缺定义
    if (name && !name.startsWith('$')) out.set(`${m[1]} → ${name}`, name);
  }
  return out;
}

/** 这个标识符在脚本里**被定义**了吗（声明、赋值成函数/箭头函数都算） */
const isDefined = (script, name) => new RegExp(`(?:function\\s+${name}\\b)|(?:(?:const|let|var)\\s+${name}\\b)`).test(script);

const vueFiles = readdirSync(SRC).filter(f => f.endsWith('.vue'));

test('控制台模板：每个 @event 绑定的 handler 都在同文件里定义过', () => {
  assert.ok(vueFiles.length > 5, '应该扫到多个 .vue 文件，否则是路径错了');
  const missing = [];
  for (const f of vueFiles) {
    const text = readFileSync(join(SRC, f), 'utf8');
    const tpl = /<template>([\s\S]*)<\/template>/.exec(text)?.[1] ?? '';
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1] ?? '';
    for (const [label, name] of handlersIn(tpl)) {
      if (!isDefined(script, name)) missing.push(`${f}: ${label}`);
    }
  }
  assert.deepEqual(missing, [],
    '这些 handler 在模板里绑了、但脚本里找不到定义（点下去会静默失效）：\n' + missing.join('\n'));
});

test('守卫自身：认得出"绑了但没定义"，也不会把"名字只出现在注释里"当成定义', () => {
  const tpl = '<button @click="noSuchFn">x</button><button @click="ok">y</button><button @click="a + b">z</button>';
  const found = handlersIn(tpl);
  assert.deepEqual([...found.values()], ['noSuchFn', 'ok'], '内联表达式不该被当成 handler 名');

  // 关键对照：这一条正是第一版的漏洞 —— 名字出现在注释里不算定义
  assert.equal(isDefined('// 详情面板用的是 openForge，见文档', 'openForge'), false);
  assert.equal(isDefined('function openForge() {}', 'openForge'), true);
  assert.equal(isDefined('const openForge = () => {}', 'openForge'), true);
  assert.equal(isDefined('function openForgeDisabled() {}', 'openForge'), false, '前缀相同不算同名');
});
