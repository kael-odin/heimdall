#!/usr/bin/env node
/**
 * gen-design-json — 从真实源码生成 .impeccable/design.json
 *
 * 为什么是生成而不是手写：上一版是手写的快照，v3 换掉整套色板后它就变成了
 * **陈述错误事实的文档**（写着 --abyss #0B0B10、Orbitron、辉光），而没有任何机制
 * 会提醒它过期。改成从 style.css / types.js 现读现生成，派生部分就不可能再漂移。
 *
 * 手写的只有两处：narrative（设计叙述）与 components（组件示例）——
 * 这两块本来就无法从 token 推导。
 *
 * 用法: node scripts/gen-design-json.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const OUT = resolve(HERE, '..', '..', '.impeccable', 'design.json');

// ---------- 从 style.css 抽 token ----------
function parseBlock(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error('找不到选择器: ' + selector);
  const start = css.indexOf('{', i) + 1;
  const end = css.indexOf('}', start);
  const body = css.slice(start, end);
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const css = readFileSync(join(SRC, 'style.css'), 'utf8');
const dark = parseBlock(css, ':root {');
const light = parseBlock(css, '[data-theme="light"]');

const tok = (name, theme = 'dark') => (theme === 'light' ? light[name] : dark[name]) ?? null;

/** 生成一条色阶（用于 colorMeta 的 tonalRamp 展示） */
function ramp(hex, steps = 8) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return [hex];
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (v, t) => Math.round(t > 0 ? v + (255 - v) * t : v * (1 + t));
  return [0, 1, 2, 3, 4, 5, 6, 7].slice(0, steps).map((k) => {
    const t = (k / (steps - 1)) * 2 - 1;                       // -1 → 1
    const rgb = [r, g, b].map(v => Math.min(255, Math.max(0, mix(v, t * 0.8))));
    return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  });
}

const SEMANTIC = [
  ['accent', 'Accent Clay', 'primary', '唯一强调色。主按钮、激活态、链接、选中。浅色主题用更深的值以保证 AA。'],
  ['accent2', 'Plum', 'secondary', '备用强调（李子）。只用于与主色区分度要求高的次要标记。'],
  ['ok', 'Verdict Green', 'tertiary', '成功、通过、已克隆。'],
  ['warn', 'Signal Amber', 'tertiary', '警告、进行中、需注意的缺口。'],
  ['bad', 'Fault Red', 'tertiary', '失败、危险、删除。'],
];

const colorMeta = {};
for (const [key, name, role, purpose] of SEMANTIC) {
  const d = tok('--' + (key === 'accent2' ? 'accent-2' : key));
  const l = tok('--' + (key === 'accent2' ? 'accent-2' : key), 'light');
  if (!d) continue;
  colorMeta[key] = { role, displayName: name, purpose, canonical: d, canonicalLight: l, tonalRamp: ramp(d) };
}
for (const [key, name, role, purpose, varName] of [
  ['bg', 'Warm Charcoal', 'neutral', '页面底色。暖中性而不是冷蓝黑 —— 这是 v3 与 v2 最根本的差别。', '--bg'],
  ['surface', 'Panel Surface', 'neutral', '面板面。层级靠它比底色亮一档，不靠辉光。', '--surface'],
  ['text', 'Ink', 'neutral', '正文与标题。', '--text'],
  ['textDim', 'Dim Ink', 'neutral', '次要文字。', '--text-dim'],
  ['textFaint', 'Faint Ink', 'neutral', '弱化文字、单位、时间戳。两套主题都实测 ≥4.5:1。', '--text-faint'],
]) {
  const d = tok(varName);
  if (!d) continue;
  colorMeta[key] = { role, displayName: name, purpose, canonical: d, canonicalLight: tok(varName, 'light'), tonalRamp: ramp(d) };
}

// ---------- 从 types.js 抽页面类型色板 ----------
const typesSrc = readFileSync(join(SRC, 'types.js'), 'utf8');
const pageTypes = [];
// 捕获组顺序：1=id, 2=color(深色), 3=light(浅色), 4=cn
for (const m of typesSrc.matchAll(/(\w+):\s*\{\s*color:\s*'(#[0-9A-Fa-f]{6})',\s*light:\s*'(#[0-9A-Fa-f]{6})',\s*cn:\s*'([^']+)'/g)) {
  pageTypes.push({ id: m[1], displayName: m[1], label: m[4], dark: m[2], light: m[3] });
}
if (pageTypes.length !== 14) throw new Error(`页面类型解析出 ${pageTypes.length} 个，应为 14 —— 解析规则与 types.js 格式不同步了`);

// ---------- 组装 ----------
const design = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  title: 'Design System: Heimdall Console',
  generator: 'console/scripts/gen-design-json.mjs（从 style.css / types.js 生成，勿手改）',
  extensions: {
    colorMeta,
    typographyMeta: {
      display: { displayName: 'Display', fontFamily: tok('--font-display'), purpose: '品牌字与统计数字。系统 sans，紧字距。v2 的 Orbitron 已移除。' },
      title: { displayName: 'Title', fontFamily: tok('--font-ui'), purpose: '面板与卡片标题。' },
      body: { displayName: 'Body', fontFamily: tok('--font-ui'), purpose: '正文。14px 起。' },
      label: { displayName: 'Label', fontFamily: tok('--font-mono'), purpose: '全大写短标签，字距 ≤.14em。' },
      mono: { displayName: 'Mono', fontFamily: tok('--font-mono'), purpose: '数字、ID、路径、版本。配 tabular-nums，避免读数跳动。' },
    },
    pageTypes,
    shadows: [
      { name: 'surface', value: `box-shadow: ${tok('--shadow')}`, purpose: '面板投影。层级靠它和底色，不靠辉光。' },
      { name: 'focus-ring', value: `outline: 2px solid var(--accent); outline-offset: 2px`, purpose: '全局 :focus-visible。任何地方都不要写 outline:none。' },
    ],
    motion: [
      { name: 'dur-base', value: tok('--dur'), purpose: '过渡时长。prefers-reduced-motion 下压到 .001ms。' },
      { name: 'pulse-soft', value: 'opacity .45 的呼吸', purpose: '仅用于"正在发生"的状态，不做装饰性动效。' },
    ],
    breakpoints: [
      { name: 'mobile', value: '768px', purpose: '详情面板转底部抽屉；星图浮层与操作提示隐藏；底部导航收窄。' },
      { name: 'table-wide', value: '1560px / 1360px', purpose: '页面表逐级隐藏非关键列（更新时间、交互）。' },
    ],
    surfaces: {
      base: tok('--surface'),
      baseLight: tok('--surface', 'light'),
      pageBg: tok('--bg'),
      pageBgLight: tok('--bg', 'light'),
      border: tok('--border'),
      radius: tok('--r'),
      radiusSm: tok('--r-sm'),
      borderWidth: tok('--bw'),
      note: 'v2 的 1px 仪器框 + 四角刻度 + 暗色渐变已废弃，改为实底 + 1px 描边 + 柔和投影。',
    },
  },
  components: [
    {
      name: 'Surface', kind: 'card', refersTo: 'surface',
      description: '全系统唯一的表面基元：实底 + 1px 描边 + 10px 圆角 + 柔和投影。任何新容器都应该是它。',
      html: '<div class="ds-surface"><div class="ds-surface-label">仪表面板</div><div class="ds-surface-body">引擎在线 :8900 · 克隆槽 0/2</div></div>',
      css: '.ds-surface{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);padding:12px 14px}\n.ds-surface-label{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;color:var(--text-faint)}\n.ds-surface-body{margin-top:6px;font-size:12.5px;color:var(--text-dim)}',
    },
    {
      name: 'Primary Button', kind: 'button', refersTo: 'accent',
      description: '主操作。深色主题下用 --bg 作文字色（白字只有 3.28:1，不达标）。',
      html: '<button class="ds-btn">克隆选中</button>',
      css: '.ds-btn{background:var(--accent);color:var(--bg);border:0;border-radius:var(--r-sm);padding:7px 14px;font-size:12.5px;cursor:pointer}',
    },
    {
      name: 'Status Chip', kind: 'chip', refersTo: 'semantic',
      description: '状态标记。颜色 + 文字双通道，不靠发光表达状态。',
      html: '<span class="ds-chip ok">已克隆</span> <span class="ds-chip warn">克隆中</span> <span class="ds-chip bad">失败</span>',
      css: '.ds-chip{display:inline-block;padding:2px 8px;border-radius:var(--r-sm);font-size:11px}\n.ds-chip.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}\n.ds-chip.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}\n.ds-chip.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}',
    },
  ],
  narrative: {
    northStar: '从"仪器"改为"工作台"',
    overview: 'v2 把控制台定义成一台仪器：冷蓝黑底、1px 青色细线、四角刻度、霓虹辉光，靠"某处亮起来"携带语义。v3 换成 Anthropic / Claude Code 的产品语汇 —— 暖炭与象牙中性底、单一黏土橙强调、细描边叠柔和投影、克制的动效、等宽数字。这个转向是为了让工具看起来是给人用的：霓虹辉光是一种需要先学会才能读的语言，而目标用户每天要在这上面读几十份报告。',
    keyCharacteristics: [
      '单一表面基元：实底 + 1px 描边 + 10px 圆角 + 柔和投影。没有装饰角，没有内嵌渐变。',
      '单一强调色（黏土橙）；语义色只做状态信号，不承担主操作。',
      '没有辉光。状态靠颜色与文字表达 —— 辉光在浅色主题下本来就不成立。',
      '系统字体栈 + 等宽数字；不加载任何外部字体。',
      '双主题（暖炭 / 象牙），全部取值在 token 层翻转，组件内不出现裸色值。',
    ],
    rules: [
      '一切颜色走 token。需要带透明度的语义色用 color-mix(in srgb, var(--accent) 10%, transparent)。',
      '对比度实测，不是估色：正文 ≥4.5:1，大字与非文本图形 ≥3:1。',
      '动效只表达状态，不做装饰。prefers-reduced-motion 下全部时长归零。',
      '底部固定元素必须让开导航 dock（bottom:12px，高约 55px）。',
      '3D 星图节点色必须跟随主题 —— 画布底色就是 --bg。',
    ],
    dos: [
      '新增界面用 .surface 起手，用 --text-dim / --text-faint 建立层级。',
      '表格数字用 --font-mono + tabular-nums。',
      '删除类操作要二次确认，并在文案里写清影响范围。',
    ],
    donts: [
      '不要写 box-shadow: 0 0 Npx（辉光形态）—— v3 没有辉光。',
      '不要写 outline: none 覆盖 :focus-visible。',
      '不要用 --accent 底 + 白字（3.28:1，不达标）。',
      '不要在组件里写裸 hex / 裸 rgba。',
      '不要用 #22D3EE / #0B0B10 / Orbitron —— 那是已废弃的 v2 取值。',
    ],
  },
};

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(design, null, 2) + '\n');
console.log(`design.json 已生成 → ${OUT}`);
console.log(`  色板 ${Object.keys(design.extensions.colorMeta).length} 条 · 页面类型 ${design.extensions.pageTypes.length} 类 · 组件 ${design.components.length} 个`);
