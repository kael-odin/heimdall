/**
 * design/import — 不走 API 的兜底：读手动从 Figma 导出的 *.svg / *.png，产出与 pullDesign 同形的 design.json
 *
 * 约束：
 *   · Figma 导出 SVG 时必须取消勾选「Outline text」（REST 对应 svg_outline_text=false），
 *     否则文字被转成路径，这里一个字也读不到——那种文件会在 warnings 里标出来。
 *   · 只用正则线性扫描，不引 XML 库；Figma 导出的 SVG 结构扁平，够用。不处理 transform，坐标只作参考，box 恒为 null。
 *   · 一个 <text> 内同一 y 的 tspan 是样式分段，直接拼；换 y 是换行，用 \n 连。
 *     一段文字混用多种样式时 Figma 会拆成多个 <text>，这里各算一条。
 *   · 同名的 .svg 与 .png 合成一个画板：文字与颜色取 SVG，位图取 PNG。画板名 = 文件名去扩展名，
 *     Figma 按倍率导出时加的 @2x 之类后缀不算进名字，只用来把 PNG 尺寸换算回设计稿单位。
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { DESIGN_SCHEMA } from './figma.mjs';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const NAMED_COLORS = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080' };
const WEIGHTS = { normal: 400, bold: 700, lighter: 300, bolder: 800 };

export function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** 属性 + 内联 style（style 覆盖同名属性，与 CSS 优先级一致）；键名小写 */
function attrsOf(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decodeXml(m[2] ?? m[3]);
  for (const decl of String(out.style ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const px = (v) => (/^\s*[\d.]+\s*(?:px)?\s*$/.test(String(v ?? '')) ? num(v) : null);
const stripTags = (s) => String(s).replace(/<[^>]*>/g, '');

/** '#abc' / '#aabbcc' / '#aabbccdd' / rgb(a)() / 常见色名 → '#rrggbb'；none、渐变引用等 → null */
export function hexColor(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = v.match(/^#([0-9a-f]{3,4})$/);
  if (m) return '#' + [...m[1].slice(0, 3)].map(c => c + c).join('');
  m = v.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (m) return '#' + m[1];
  m = v.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/);
  if (!m) return null;
  const ch = (s) => Math.max(0, Math.min(255, Math.round(s.endsWith('%') ? parseFloat(s) * 2.55 : parseFloat(s))));
  return '#' + [m[1], m[2], m[3]].map(s => ch(s).toString(16).padStart(2, '0')).join('');
}

function fontWeight(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return WEIGHTS[s] ?? num(s);
}

const firstFamily = (v) => (v ? String(v).split(',')[0].trim().replace(/^['"]|['"]$/g, '') || null : null);

/** 一个 <text>：同一 y 的 tspan 直接拼（样式分段），换 y 视为换行 */
function readText(attrText, inner, index) {
  const attrs = attrsOf(attrText);
  const spans = [...inner.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi)].map(s => ({ attrs: attrsOf(s[1]), text: decodeXml(stripTags(s[2])) }));
  if (!spans.length) spans.push({ attrs: {}, text: decodeXml(stripTags(inner)) });
  const lines = [], ys = [];
  let lastY;
  for (const s of spans) {
    const y = s.attrs.y ?? lastY;
    if (lines.length && y === lastY) lines[lines.length - 1] += s.text;
    else { lines.push(s.text); if (y !== undefined) ys.push(num(y)); }
    lastY = y;
  }
  const characters = lines.join('\n');
  if (!characters.trim()) return null;
  const pick = (k) => attrs[k] ?? spans.find(s => s.attrs[k] != null)?.attrs[k] ?? null;
  const lineHeight = ys.length >= 2 && ys[0] !== null && ys[1] !== null ? Math.round((ys[1] - ys[0]) * 100) / 100 : null;
  return {
    id: `t${index}`, name: characters.replace(/\s+/g, ' ').trim().slice(0, 40), characters,
    fontFamily: firstFamily(pick('font-family')), fontSize: num(pick('font-size')), fontWeight: fontWeight(pick('font-weight')),
    lineHeightPx: lineHeight, color: hexColor(pick('fill')),
    box: null, baseline: { x: num(spans[0].attrs.x ?? attrs.x), y: num(spans[0].attrs.y ?? attrs.y) },
  };
}

/** 解析一份 SVG 文本：画板尺寸、文字、颜色、字体 */
export function parseSvgDesign(svg) {
  const src = String(svg).replace(/<!--[\s\S]*?-->/g, '');
  const root = attrsOf(src.match(/<svg\b([^>]*)>/i)?.[1] ?? '');
  const vb = String(root.viewbox ?? '').trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite);
  const width = px(root.width) ?? (hasVb ? vb[2] : null);
  const height = px(root.height) ?? (hasVb ? vb[3] : null);
  const texts = [];
  for (const m of src.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const t = readText(m[1], m[2], texts.length);
    if (t) texts.push(t);
  }
  const colors = new Map(), fonts = new Map();
  const visual = src.replace(/<(defs|clipPath|mask)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of visual.matchAll(/<([a-z][\w:-]*)\b([^>]*?)\/?>/gi)) {
    const hex = hexColor(attrsOf(m[2]).fill);
    if (hex) colors.set(hex, (colors.get(hex) ?? 0) + 1);
  }
  for (const t of texts) {
    if (!t.fontFamily) continue;
    const k = `${t.fontFamily}|${t.fontSize}|${t.fontWeight}`;
    const e = fonts.get(k) ?? { family: t.fontFamily, size: t.fontSize, weight: t.fontWeight, count: 0 };
    e.count++;
    fonts.set(k, e);
  }
  const warnings = [];
  if (!texts.length && /<path\b/i.test(src)) warnings.push('没有 <text>：导出时可能勾选了「Outline text」，文字被转成了路径');
  return {
    width, height, texts,
    colors: [...colors].map(([hex, count]) => ({ hex, count })).sort((a, b) => b.count - a.count),
    fonts: [...fonts.values()].sort((a, b) => b.count - a.count),
    warnings,
  };
}

const safeName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
const importError = (message) => Object.assign(new Error(message), { code: 'design_import_failed' });

/** 'home@2x' → { name: 'home', scale: 2 } */
function frameName(file) {
  const stem = basename(file, extname(file));
  const m = stem.match(/^(.+?)@(\d+(?:\.\d+)?)x$/i);
  return m && Number(m[2]) > 0 ? { name: m[1], scale: Number(m[2]) } : { name: stem, scale: 1 };
}

function listExports(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { throw importError(`读不了导出目录：${dir}`); }
  return entries.filter(e => e.isFile() && /^\.(svg|png)$/i.test(extname(e.name))).map(e => e.name).sort((a, b) => a.localeCompare(b));
}

/**
 * 读 dir 下（不递归）的 *.svg / *.png，写 outDir/design.json 与 outDir/frames/*。
 * source.via：有 SVG 就是 'svg'（文字来自 SVG），只有 PNG 时是 'png'；每个画板另记自己的 via。
 * 返回 { design, dir: outDir }。
 */
export function importDesignExports({ dir, outDir } = {}) {
  if (!dir || !outDir) throw importError('importDesignExports 需要 dir 与 outDir');
  const files = listExports(dir);
  if (!files.length) throw importError(`${dir} 下没有 .svg / .png：在 Figma 里选中画板，Export 为 SVG（取消勾选 Outline text）或 PNG`);
  const byName = new Map(), warnings = [];
  mkdirSync(join(outDir, 'frames'), { recursive: true });
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const { name, scale } = frameName(file);
    const frame = byName.get(name) ?? { id: name, name, type: 'FRAME', via: null, width: null, height: null, image: null, svg: null, texts: [], colors: [], fonts: [] };
    const target = `frames/${safeName(name)}${ext}`;
    if (ext === '.svg') {
      const parsed = parseSvgDesign(readFileSync(join(dir, file), 'utf8'));
      Object.assign(frame, {
        via: 'svg', width: parsed.width ?? frame.width, height: parsed.height ?? frame.height,
        texts: parsed.texts, colors: parsed.colors, fonts: parsed.fonts, svg: target,
      });
      if (parsed.warnings.length) frame.warnings = parsed.warnings;
    } else {
      let png;
      try { png = PNG.sync.read(readFileSync(join(dir, file))); } catch {
        warnings.push(`${file} 不是有效的 PNG，已跳过`);
        continue;
      }
      if (frame.image) warnings.push(`${name} 有多份 PNG，用的是 ${file}`);
      Object.assign(frame, { via: frame.via ?? 'png', image: target, imageWidth: png.width, imageHeight: png.height, ...(scale !== 1 ? { imageScale: scale } : {}) });
      if (frame.width == null) Object.assign(frame, { width: Math.round(png.width / scale), height: Math.round(png.height / scale) });
    }
    copyFileSync(join(dir, file), join(outDir, target));
    byName.set(name, frame);
  }
  const frames = [...byName.values()];
  if (!frames.length) throw importError(`${dir} 下的文件都读不了：${warnings.join('；')}`);
  const design = {
    schema: DESIGN_SCHEMA,
    source: { via: frames.some(f => f.svg) ? 'svg' : 'png', dir: resolve(dir), fetchedAt: new Date().toISOString() },
    frames,
    ...(warnings.length ? { warnings } : {}),
  };
  writeFileAtomic(join(outDir, 'design.json'), JSON.stringify(design, null, 2) + '\n');
  return { design, dir: outDir };
}
