import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parse } from 'parse5';

const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CARBON_HOSTS = ['carbonads.com', 'carbonads.net'];
const CONTAINER_CLASSES = new Set(['vpcarbonads', 'vpdocasidecarbonads', 'carbon-pixels']);

function attr(node, name) {
  return (node.attrs ?? []).find(item => item.name.toLowerCase() === name)?.value ?? '';
}

function classTokens(value) {
  return String(value).toLowerCase().split(/\s+/).filter(Boolean);
}

function isCarbonHost(raw) {
  try {
    const { hostname } = new URL(String(raw));
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return CARBON_HOSTS.some(value => host === value || host.endsWith('.' + value));
  } catch {
    return false;
  }
}

function isCarbonScript(node) {
  return node.tagName === 'script' && (attr(node, 'id') === '_carbonads_js' || isCarbonHost(attr(node, 'src')));
}

function isCarbonContainer(node) {
  return attr(node, 'id').toLowerCase() === 'carbonads'
    || classTokens(attr(node, 'class')).some(token => CONTAINER_CLASSES.has(token));
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function removeHtmlNodes(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const candidates = [];
  walk(document, node => {
    if (!node.tagName) return;
    if (isCarbonScript(node)) candidates.push({ node, kind: 'script' });
    else if (isCarbonContainer(node)) candidates.push({ node, kind: 'container' });
  });
  const ranges = [];
  for (const candidate of candidates) {
    const location = candidate.node.sourceCodeLocation;
    if (!location || !Number.isSafeInteger(location.startOffset) || !Number.isSafeInteger(location.endOffset)) continue;
    ranges.push({ ...location, kind: candidate.kind });
  }
  ranges.sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
  const selected = [];
  for (const range of ranges) {
    if (selected.some(item => range.startOffset >= item.startOffset && range.endOffset <= item.endOffset)) continue;
    selected.push(range);
  }
  let text = html;
  for (const range of selected.sort((a, b) => b.startOffset - a.startOffset)) {
    text = text.slice(0, range.startOffset) + text.slice(range.endOffset);
  }
  return {
    text,
    scripts: selected.filter(item => item.kind === 'script').length,
    containers: selected.filter(item => item.kind === 'container').length,
  };
}

function removeInTree(root, report) {
  let files = 0;
  const walkDir = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('carbonads removal refuses symlinks');
      if (stat.isDirectory()) {
        walkDir(file);
        continue;
      }
      if (!stat.isFile() || !/\.html?$/i.test(name) || extname(name).toLowerCase() === '') continue;
      if (++files > MAX_FILES || (report.bytes += stat.size) > MAX_TOTAL_BYTES) {
        throw new Error('carbonads removal limit exceeded');
      }
      if (stat.size > MAX_FILE_BYTES) {
        report.failed++;
        continue;
      }
      const html = readFileSync(file, 'utf8');
      let changed;
      try { changed = removeHtmlNodes(html); }
      catch {
        report.failed++;
        continue;
      }
      if (changed.text === html) continue;
      writeFileSync(file + '.heimdall-tmp', changed.text);
      renameSync(file + '.heimdall-tmp', file);
      report.files++;
      report.removedScripts += changed.scripts;
      report.removedContainers += changed.containers;
    }
  };
  walkDir(root);
}

/** Explicitly remove recognized CarbonAds markup from candidate HTML. */
export function removeCarbonAds({ liveDir, staticPagesDir = null }) {
  const report = {
    policy: 'remove-carbonads',
    status: 'not-detected',
    files: 0,
    bytes: 0,
    removedNodes: 0,
    removedScripts: 0,
    removedContainers: 0,
    remainingHtmlReferences: 0,
    failed: 0,
  };
  try {
    removeInTree(liveDir, report);
    if (staticPagesDir) removeInTree(staticPagesDir, report);
  } catch (error) {
    report.failed++;
    report.error = String(error.message ?? error);
  }
  report.removedNodes = report.removedScripts + report.removedContainers;
  try {
    report.remainingHtmlReferences = [
    liveDir,
    ...(staticPagesDir ? [staticPagesDir] : []),
    ].reduce((total, root) => {
      if (!root || !existsSync(root)) return total;
    let files = 0;
    const count = dir => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('carbonads removal refuses symlinks');
        if (stat.isDirectory()) { count(file); continue; }
        if (!stat.isFile() || !/\.html?$/i.test(name) || stat.size > MAX_FILE_BYTES) continue;
        if (++files > MAX_FILES) throw new Error('carbonads removal limit exceeded');
        total += (readFileSync(file, 'utf8').match(/carbonads\.(?:com|net)/gi) ?? []).length;
      }
    };
    count(root);
    return total;
    }, 0);
  } catch (error) {
    report.failed++;
    report.remainingHtmlReferences = 0;
    report.error = String(error.message ?? error);
  }
  report.status = report.failed
    ? 'failed'
    : report.remainingHtmlReferences
      ? 'incomplete'
      : report.removedNodes
        ? 'removed'
        : 'not-detected';
  return report;
}
