/**
 * domdiff — DOM 结构相似度（还原度第二维度，权重 0.3）
 *
 * 对比范围 = <body> 内的可见结构（跳过 script/style/noscript/svg 内部，head 忽略）。
 * 三指标：
 *   nodeRatio  节点数比 min/max          —— 结构体量是否一致
 *   tagCos     标签分布余弦相似度          —— 结构"形状"是否一致
 *   classJac   class token Jaccard       —— 类名体系是否保留（L1 搬运应≈1）
 * dom = 0.4*nodeRatio + 0.3*tagCos + 0.3*classJac
 */
import { parse } from 'parse5';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head']);

function walk(node, out) {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text' || child.nodeName === '#comment') continue;
    const tag = (child.tagName ?? child.nodeName).toLowerCase();
    if (SKIP.has(tag)) continue;
    out.count++;
    out.tags.set(tag, (out.tags.get(tag) ?? 0) + 1);
    for (const a of child.attrs ?? []) {
      if (a.name === 'class') {
        for (const t of a.value.split(/\s+/)) {
          if (t) { out.classes.add(t); out.classHits++; break; } // 记节点"有类名"，token 收全集
        }
        for (const t of a.value.split(/\s+/)) if (t) out.classTokens.add(t);
      }
    }
    walk(child, out);
  }
  return out;
}

const findNode = (n, name) => {
  if (n.nodeName === name) return n;
  for (const c of n.childNodes ?? []) {
    const r = findNode(c, name);
    if (r) return r;
  }
  return null;
};

const profile = (html) => {
  const body = findNode(parse(html), 'body');
  const o = { count: 0, tags: new Map(), classes: new Set(), classTokens: new Set() };
  if (body) walk(body, o);
  return o;
};

export function domSimilarity(htmlA, htmlB) {
  const A = profile(htmlA), B = profile(htmlB);
  const nodeRatio = Math.min(A.count, B.count) / Math.max(A.count, B.count, 1);

  const allTags = new Set([...A.tags.keys(), ...B.tags.keys()]);
  let dot = 0, na = 0, nb = 0;
  for (const t of allTags) {
    const a = A.tags.get(t) ?? 0, b = B.tags.get(t) ?? 0;
    dot += a * b; na += a * a; nb += b * b;
  }
  const tagCos = na && nb ? dot / Math.sqrt(na * nb) : 0;

  const inter = [...A.classTokens].filter(t => B.classTokens.has(t)).length;
  const union = new Set([...A.classTokens, ...B.classTokens]).size;
  const classJac = union ? inter / union : 0;

  return {
    nodeRatio: +nodeRatio.toFixed(4),
    tagCos: +tagCos.toFixed(4),
    classJac: +classJac.toFixed(4),
    dom: +(0.4 * nodeRatio + 0.3 * tagCos + 0.3 * classJac).toFixed(4),
    counts: { src: A.count, clone: B.count },
  };
}

// CLI: node src/differ/domdiff.mjs <pageDir>
if (process.argv[1]?.endsWith('domdiff.mjs')) {
  const DIR = requireArg(process.argv[2], 'node src/differ/domdiff.mjs <pageDir>', '页面目录');
  const r = domSimilarity(
    readFileSync(join(DIR, 'dom.html'), 'utf8'),
    readFileSync(join(DIR, 'clone', 'index.html'), 'utf8'),
  );
  console.log(JSON.stringify(r, null, 2));
}
