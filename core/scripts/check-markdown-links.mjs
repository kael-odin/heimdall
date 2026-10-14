#!/usr/bin/env node
/**
 * Check local links in the current Markdown documentation.
 *
 * The checker intentionally ignores archived documentation and runtime output.
 * It also ignores fenced code, inline code, anchors, and external URLs so
 * examples do not become false positives while real documentation links stay
 * covered by a cheap CI guard.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'workspace', 'deliverable', 'assets-cas']);

function normaliseRepoPath(file, root = REPO_ROOT) {
  return relative(root, file).split(sep).join('/');
}

function shouldSkipPath(fileOrDir, root) {
  const rel = normaliseRepoPath(fileOrDir, root);
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  if (parts[0]?.startsWith('.') && parts[0] !== '.github') return true;
  if (parts[0] === 'docs' && parts[1] === 'archive') return true;
  return false;
}

function walkMarkdown(dir, root, out = []) {
  if (shouldSkipPath(dir, root)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (shouldSkipPath(file, root)) continue;
    if (entry.isDirectory()) walkMarkdown(file, root, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(file);
  }
  return out;
}

export function collectMarkdownFiles(root = REPO_ROOT) {
  return walkMarkdown(resolve(root), resolve(root)).sort();
}

function maskInlineCode(line) {
  const chars = [...line];
  for (let i = 0; i < chars.length;) {
    if (chars[i] === '\\' && chars[i + 1] === '`') {
      i += 2;
      continue;
    }
    if (chars[i] !== '`') {
      i++;
      continue;
    }
    let run = 1;
    while (chars[i + run] === '`') run++;
    let end = i + run;
    while (end < chars.length) {
      if (chars[end] !== '`') {
        end++;
        continue;
      }
      let closeRun = 1;
      while (chars[end + closeRun] === '`') closeRun++;
      if (closeRun === run) {
        end += closeRun;
        break;
      }
      end += closeRun;
    }
    for (let j = i; j < Math.min(end, chars.length); j++) chars[j] = ' ';
    i = end;
  }
  return chars.join('');
}

function isFenceStart(line) {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

function isFenceEnd(line, fence) {
  const re = new RegExp(`^\\s{0,3}${fence.char}{${fence.length},}\\s*$`);
  return re.test(line);
}

function findClosingBracket(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === ']') return i;
  }
  return -1;
}

function consumeLinkDestination(text, openIndex) {
  let i = openIndex + 1;
  while (/\s/.test(text[i] ?? '')) i++;
  if (i >= text.length) return null;

  let target = '';
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1);
    if (end < 0) return null;
    target = text.slice(i + 1, end);
    i = end + 1;
    while (i < text.length && text[i] !== ')') i++;
    return { target, end: i };
  }

  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return { target: text.slice(start, i).trim(), end: i };
      depth--;
      continue;
    }
    if (/\s/.test(ch) && depth === 0) {
      target = text.slice(start, i).trim();
      while (i < text.length && text[i] !== ')') i++;
      return { target, end: i };
    }
  }
  return null;
}

function unescapeDestination(value) {
  return value
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/\\([\\()[\]<>#])/g, '$1');
}

function pushRecord(records, sourcePath, line, kind, target) {
  const value = unescapeDestination(target);
  if (!value) return;
  records.push({ source: sourcePath, line, kind, target: value });
}

function scanInlineLinks(line, sourcePath, lineNumber, records) {
  for (let i = 0; i < line.length; i++) {
    const image = line[i] === '!' && line[i + 1] === '[';
    if (line[i] !== '[' && !image) continue;
    const labelStart = image ? i + 2 : i + 1;
    const labelEnd = findClosingBracket(line, labelStart);
    if (labelEnd < 0) continue;
    const next = labelEnd + 1;
    if (line[next] !== '(') {
      i = labelEnd;
      continue;
    }
    const parsed = consumeLinkDestination(line, next);
    if (!parsed) continue;
    pushRecord(records, sourcePath, lineNumber, image ? 'image' : 'inline', parsed.target);
    i = parsed.end;
  }
}

function scanReferenceUses(line, sourcePath, lineNumber, records, definitions) {
  const re = /!?\[([^\]]*)\]\[([^\]]*)\]/g;
  for (const match of line.matchAll(re)) {
    const label = (match[2] || match[1]).trim().toLowerCase().replace(/\s+/g, ' ');
    const target = definitions.get(label);
    if (target) pushRecord(records, sourcePath, lineNumber, 'reference', target);
  }
}

function scanHtmlAttributes(line, sourcePath, lineNumber, records) {
  const re = /\b(?:href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of line.matchAll(re)) {
    pushRecord(records, sourcePath, lineNumber, 'html', match[1] ?? match[2] ?? match[3]);
  }
}

function collectReferenceDefinitions(line, definitions) {
  const match = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/);
  if (!match) return;
  const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
  definitions.set(label, match[2] ?? match[3]);
}

export function scanMarkdownText(text, sourcePath = '<memory>') {
  const records = [];
  const definitions = new Map();
  const lines = text.split(/\r?\n/);
  let fence = null;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const fenceToken = isFenceStart(raw);
    if (fence) {
      if (isFenceEnd(raw, fence)) fence = null;
      continue;
    }
    if (fenceToken) {
      fence = fenceToken;
      continue;
    }
    const line = maskInlineCode(raw);
    collectReferenceDefinitions(line, definitions);
  }

  fence = null;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const fenceToken = isFenceStart(raw);
    if (fence) {
      if (isFenceEnd(raw, fence)) fence = null;
      continue;
    }
    if (fenceToken) {
      fence = fenceToken;
      continue;
    }
    const line = maskInlineCode(raw);
    scanInlineLinks(line, sourcePath, index + 1, records);
    scanHtmlAttributes(line, sourcePath, index + 1, records);
    scanReferenceUses(line, sourcePath, index + 1, records, definitions);
  }

  return records;
}

export function isLocalRelativeTarget(target) {
  const value = target.trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || value.startsWith('/')) return false;
  return !/^[a-z][a-z\d+.-]*:/i.test(value);
}

export function resolveLocalTarget(sourcePath, target, root = REPO_ROOT) {
  if (!isLocalRelativeTarget(target)) return null;
  const pathOnly = target.split(/[?#]/, 1)[0];
  if (!pathOnly) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    decoded = pathOnly;
  }
  const resolved = resolve(dirname(sourcePath), decoded);
  const repoRoot = resolve(root);
  const rel = relative(repoRoot, resolved);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    return { path: resolved, outsideRepo: true };
  }
  return { path: resolved, outsideRepo: false };
}

export function checkMarkdownLinks(root = REPO_ROOT) {
  const repoRoot = resolve(root);
  const files = collectMarkdownFiles(repoRoot);
  const broken = [];
  let checked = 0;

  for (const file of files) {
    const records = scanMarkdownText(readFileSync(file, 'utf8'), file);
    for (const record of records) {
      const resolved = resolveLocalTarget(file, record.target, repoRoot);
      if (!resolved) continue;
      checked++;
      if (resolved.outsideRepo || !existsSync(resolved.path)) {
        broken.push({ ...record, path: resolved.path, outsideRepo: resolved.outsideRepo });
      }
    }
  }

  return { root: repoRoot, files, checked, broken };
}

function main() {
  const result = checkMarkdownLinks();
  for (const item of result.broken) {
    const source = `${normaliseRepoPath(item.source)}:${item.line}`;
    const reason = item.outsideRepo ? 'outside repository' : `missing ${normaliseRepoPath(item.path)}`;
    console.error(`BROKEN ${source} [${item.kind}] ${item.target} (${reason})`);
  }
  if (result.broken.length) {
    console.error(`markdown-links: ${result.broken.length} broken link(s) / ${result.checked} local target(s) in ${result.files.length} file(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`markdown-links: ${result.checked} local target(s) OK in ${result.files.length} file(s)`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === resolve(fileURLToPath(import.meta.url))) main();
