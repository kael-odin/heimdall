import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { parse } from 'parse5';

const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const YOUTUBE_HOSTS = ['youtube.com', 'youtube-nocookie.com'];
const RUNTIME_EMBED_PREFIXES = [
  'https://www.youtube.com/embed/',
  'https://youtube.com/embed/',
  'https://www.youtube-nocookie.com/embed/',
  'https://youtube-nocookie.com/embed/',
];
const LOCAL_EMBED_PATH = /^(?:\/lm\/[^/]+)?\/_ext\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//;
const RUNTIME_LOCAL_EMBED_RE = /(?:\/lm\/[^/'"`\\]+)?\/_ext\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//g;
const REMAINING_RUNTIME_EMBED_RE = /https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com)\/embed\/|(?:\/lm\/[^/'"`\\]+)?\/_ext\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//g;
const RUNTIME_PLACEHOLDER_PREFIX = '/_heimdall-runtime/youtube-placeholder.html?v=';

function attr(node, name) {
  return (node.attrs ?? []).find(item => item.name.toLowerCase() === name)?.value ?? '';
}

function isYouTubeHost(raw) {
  try {
    const { hostname } = new URL(String(raw));
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return YOUTUBE_HOSTS.some(value => host === value || host.endsWith('.' + value));
  } catch {
    return false;
  }
}

function isYouTubeEmbed(node) {
  const src = attr(node, 'src');
  return node.tagName === 'iframe' && (isYouTubeHost(src) || LOCAL_EMBED_PATH.test(src));
}

function escapeAttr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function dimension(value) {
  const raw = String(value);
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) return raw + 'px';
  return /^(?:[0-9]+(?:\.[0-9]+)?(?:px|%)|auto)$/.test(raw) ? raw : null;
}

function placeholder(node) {
  const title = attr(node, 'title') || 'Embedded video';
  const width = dimension(attr(node, 'width'));
  const height = dimension(attr(node, 'height'));
  const style = [
    width ? `width:${width};` : '',
    height ? `height:${height};` : '',
  ].join('');
  return `<figure class="heimdall-video-placeholder" data-heimdall-youtube-placeholder="1"`
    + (style ? ` style="${escapeAttr(style)}"` : '')
    + ` role="img" aria-label="${escapeAttr(title)}">`
    + '<span>Video not included in the offline mirror</span></figure>';
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function replaceEmbeds(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const replacements = [];
  walk(document, node => {
    if (!isYouTubeEmbed(node)) return;
    const location = node.sourceCodeLocation;
    if (!location || !Number.isSafeInteger(location.startOffset) || !Number.isSafeInteger(location.endOffset)) return;
    replacements.push({ ...location, text: placeholder(node) });
  });
  let text = html;
  for (const item of replacements.sort((a, b) => b.startOffset - a.startOffset)) {
    text = text.slice(0, item.startOffset) + item.text + text.slice(item.endOffset);
  }
  return { text, replacements: replacements.length };
}

function countRemainingEmbeds(root) {
  let count = 0;
  let files = 0;
  const countDir = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('youtube placeholder refuses symlinks');
      if (stat.isDirectory()) { countDir(file); continue; }
      if (!stat.isFile() || !/\.html?$/i.test(name) || stat.size > MAX_FILE_BYTES) continue;
      if (++files > MAX_FILES) throw new Error('youtube placeholder limit exceeded');
      const document = parse(readFileSync(file, 'utf8'));
      walk(document, node => { if (isYouTubeEmbed(node)) count++; });
    }
  };
  countDir(root);
  return count;
}

function replaceInTree(root, report) {
  let files = 0;
  const walkDir = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('youtube placeholder refuses symlinks');
      if (stat.isDirectory()) { walkDir(file); continue; }
      if (!stat.isFile() || !/\.html?$/i.test(name) || extname(name).toLowerCase() === '') continue;
      if (++files > MAX_FILES || (report.bytes += stat.size) > MAX_TOTAL_BYTES) {
        throw new Error('youtube placeholder limit exceeded');
      }
      if (stat.size > MAX_FILE_BYTES) {
        report.failed++;
        continue;
      }
      const html = readFileSync(file, 'utf8');
      let changed;
      try { changed = replaceEmbeds(html); }
      catch {
        report.failed++;
        continue;
      }
      if (!changed.replacements || changed.text === html) continue;
      writeFileSync(file + '.heimdall-tmp', changed.text);
      renameSync(file + '.heimdall-tmp', file);
      report.files++;
      report.replacements += changed.replacements;
    }
  };
  walkDir(root);
}

function writeRuntimePlaceholder(liveDir, report) {
  const file = join(liveDir, '_heimdall-runtime', 'youtube-placeholder.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>Video not included in the offline mirror</title>'
    + '<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#111;color:#eee;'
    + 'font:14px system-ui,sans-serif;text-align:center}</style></head>'
    + '<body><main>Video not included in the offline mirror</main></body></html>\n');
  report.runtimePlaceholder = RUNTIME_PLACEHOLDER_PREFIX;
}

function rewriteRuntimeEmbeds(root, report) {
  let files = 0;
  const walkDir = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('youtube runtime rewrite refuses symlinks');
      if (stat.isDirectory()) { walkDir(file); continue; }
      if (!stat.isFile() || !/\.(?:html?|[cm]?js)$/i.test(name) || stat.size > MAX_FILE_BYTES) continue;
      if (++files > MAX_FILES || (report.bytes += stat.size) > MAX_TOTAL_BYTES) {
        throw new Error('youtube runtime rewrite limit exceeded');
      }
      const source = readFileSync(file, 'utf8');
      let text = source;
      let rewrites = 0;
      for (const prefix of RUNTIME_EMBED_PREFIXES) {
        let at = -1;
        while ((at = text.indexOf(prefix, at + 1)) !== -1) rewrites++;
        text = text.replaceAll(prefix, RUNTIME_PLACEHOLDER_PREFIX);
      }
      text = text.replace(RUNTIME_LOCAL_EMBED_RE, match => {
        rewrites++;
        return RUNTIME_PLACEHOLDER_PREFIX;
      });
      report.remainingRuntimeEmbeds += (text.match(REMAINING_RUNTIME_EMBED_RE) ?? []).length;
      if (text === source) continue;
      writeFileSync(file + '.heimdall-tmp', text);
      renameSync(file + '.heimdall-tmp', file);
      report.runtimeFiles++;
      report.runtimeEmbedRewrites += rewrites;
    }
  };
  walkDir(root);
}

/** Replace recognized YouTube embeds with explicit local placeholders. */
export function replaceYouTubeEmbeds({ liveDir, staticPagesDir = null }) {
  const report = {
    policy: 'replace-youtube',
    status: 'not-detected',
    files: 0,
    bytes: 0,
    replacements: 0,
    remainingEmbeds: 0,
    remainingRuntimeEmbeds: 0,
    runtimeFiles: 0,
    runtimeEmbedRewrites: 0,
    failed: 0,
  };
  try {
    writeRuntimePlaceholder(liveDir, report);
    replaceInTree(liveDir, report);
    if (staticPagesDir) replaceInTree(staticPagesDir, report);
    rewriteRuntimeEmbeds(liveDir, report);
    report.remainingEmbeds = [
      liveDir,
      ...(staticPagesDir ? [staticPagesDir] : []),
    ].reduce((total, root) => root && existsSync(root) ? total + countRemainingEmbeds(root) : total, 0);
  } catch (error) {
    report.failed++;
    report.error = String(error.message ?? error);
  }
  report.status = report.failed
    ? 'failed'
    : report.remainingEmbeds || report.remainingRuntimeEmbeds
      ? 'incomplete'
      : report.replacements || report.runtimeEmbedRewrites
        ? 'replaced'
        : 'not-detected';
  return report;
}
