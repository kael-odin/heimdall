#!/usr/bin/env node
/** File-only archive creation/readback. Never starts Browser, engine, tests or subprocesses. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCHIVE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(ARCHIVE, '../../../../..');
const RUNS = join(REPO, 'core/workspace/_runs'), MANIFEST = 'archive-manifest.json', SEAL = 'archive-manifest.sha256';
const sourceNames = [
  'd6-schema-store-final-20261018T084028628', 'd6-browser-development-20261018', 'd6-browser-build-20261018T090008180',
  'd6-fetch-body-probe-20261018', 'd6-fetch-helper-probe-20261018', 'd6-fetch-cache-probe-20261018', 'd6-fetch-json-probe-20261018',
  'defect-ticket-decisions-console-smoke-20261018T090039779', 'defect-ticket-decisions-console-smoke-20261018T090517875',
  'defect-ticket-decisions-console-smoke-20261018T090925486', 'defect-ticket-decisions-console-smoke-20261018T091823020',
  'defect-ticket-decisions-console-smoke-20261018T092814450', 'defect-ticket-decisions-console-smoke-20261018T093345261',
  'defect-ticket-decisions-console-smoke-20261018T093910120',
];
const controls = ['.gitattributes', '.gitignore', 'archive-control.mjs', 'README.md', 'source-statistics.json', 'source-links.json', 'exclusions.json'];
const posix = value => value.split(sep).join('/'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function under(root, name) {
  assert(typeof name === 'string' && name.length && !name.includes('\\') && !name.split('/').some(part => !part || ['.', '..'].includes(part)));
  const path = resolve(root, name); assert(path.startsWith(root + sep)); return path;
}
function walk(root, prefix = '', sourceLinks = false) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, path = join(root, entry.name), stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) {
      assert(sourceLinks, 'No symlink is allowed inside the archive: ' + path);
      files.push({ path: name, kind: 'symbolic-link', target: fs.readlinkSync(path), lstatBytes: stat.size }); continue;
    }
    if (stat.isDirectory()) files.push(...walk(path, name + '/', sourceLinks));
    else { assert(stat.isFile(), 'Regular files only: ' + path); files.push({ path: name, bytes: stat.size }); }
  }
  return files;
}
function exclusion(name, path) {
  if (path.startsWith('chromium-profile/')) return 'chromium-profile';
  if (name.startsWith('defect-ticket-decisions-console-smoke-') && path.startsWith('runtime/')
    && !/^runtime\/acceptance\/defect-tickets\/v1\/events\/da-[0-9a-f-]{36}\.json$/.test(path)) return 'browser-runtime-except-immutable-decisions';
  return null;
}
function fileRecord(root, path) {
  const full = under(root, path), stat = fs.lstatSync(full); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const bytes = fs.readFileSync(full); assert.equal(bytes.length, stat.size); return { path, bytes: bytes.length, sha256: sha(bytes) };
}
function verify({ sources = false } = {}) {
  const manifestBytes = fs.readFileSync(join(ARCHIVE, MANIFEST)), manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'defect-ticket-decisions-development-originals');
  assert.equal(fs.readFileSync(join(ARCHIVE, SEAL), 'utf8'), sha(manifestBytes) + '  ' + MANIFEST + '\n');
  assert.deepEqual(manifest.sourceNames, sourceNames); const entries = [...manifest.originals, ...manifest.controls];
  assert.equal(new Set(entries.map(value => value.path)).size, entries.length);
  for (const entry of entries) {
    assert.deepEqual(fileRecord(ARCHIVE, entry.path), { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
    if (sources && entry.source) {
      const bytes = fs.readFileSync(under(REPO, entry.source)); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
    }
  }
  if (sources) for (const entry of JSON.parse(fs.readFileSync(join(ARCHIVE, 'source-links.json'))).entries) {
    const source = under(REPO, entry.source); assert(fs.lstatSync(source).isSymbolicLink()); assert.equal(fs.readlinkSync(source), entry.target);
  }
  assert.deepEqual(walk(ARCHIVE).map(value => value.path).sort(), [...entries.map(value => value.path), MANIFEST, SEAL].sort());
  assert.equal(manifest.copiedFiles, manifest.originals.length);
  assert.equal(manifest.copiedBytes, manifest.originals.reduce((total, value) => total + value.bytes, 0));
  const complete = [...entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), fileRecord(ARCHIVE, MANIFEST), fileRecord(ARCHIVE, SEAL)]
    .sort((a, b) => a.path.localeCompare(b.path));
  const treeSha256 = sha(Buffer.from(complete.map(value => `${value.path}\0${value.bytes}\0${value.sha256}\n`).join('')));
  const result = { schemaVersion: 1, kind: 'defect-ticket-decisions-development-archive-verification', passed: true,
    checkedSources: sources, archiveFiles: complete.length, archiveBytes: complete.reduce((total, value) => total + value.bytes, 0),
    copiedFiles: manifest.copiedFiles, copiedBytes: manifest.copiedBytes, excludedFiles: manifest.excludedFiles,
    excludedBytes: manifest.excludedBytes, manifestSha256: sha(manifestBytes), treeSha256 };
  console.log(JSON.stringify(result, null, 2)); return result;
}
function create() {
  assert.equal(fs.existsSync(join(ARCHIVE, MANIFEST)), false, 'Never overwrite an existing archive.');
  assert.equal(fs.existsSync(join(ARCHIVE, 'originals')), false, 'Use a fresh archive.');
  const statistics = [], exclusions = [], selected = [], sourceLinks = [];
  for (const name of sourceNames) {
    const root = under(RUNS, name), items = walk(root, '', true), files = items.filter(value => value.kind !== 'symbolic-link');
    const links = items.filter(value => value.kind === 'symbolic-link');
    for (const link of links) sourceLinks.push({ source: 'core/workspace/_runs/' + name + '/' + link.path, target: link.target,
      targetUtf8Bytes: Buffer.byteLength(link.target), targetSha256: sha(Buffer.from(link.target)), lstatBytes: link.lstatBytes });
    let copiedFiles = 0, copiedBytes = 0, excludedFiles = 0, excludedBytes = 0;
    for (const file of files) {
      const reason = exclusion(name, file.path), source = 'core/workspace/_runs/' + name + '/' + file.path;
      if (reason) { exclusions.push({ source, bytes: file.bytes, reason }); excludedFiles++; excludedBytes += file.bytes; }
      else { selected.push({ source, path: 'originals/' + name + '/' + file.path, bytes: file.bytes }); copiedFiles++; copiedBytes += file.bytes; }
    }
    statistics.push({ name, source: 'core/workspace/_runs/' + name, files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0),
      copiedFiles, copiedBytes, excludedFiles, excludedBytes, symbolicLinks: links.length });
  }
  const originals = [];
  for (const entry of selected) {
    const source = under(REPO, entry.source), destination = under(ARCHIVE, entry.path), bytes = fs.readFileSync(source); assert.equal(bytes.length, entry.bytes);
    const fingerprint = sha(bytes); fs.mkdirSync(dirname(destination), { recursive: true }); fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const copied = fs.readFileSync(destination), sourceAfter = fs.readFileSync(source);
    assert.deepEqual(copied, bytes); assert.deepEqual(sourceAfter, bytes); assert.equal(sha(copied), fingerprint);
    originals.push({ ...entry, sha256: fingerprint });
  }
  const copiedBytes = originals.reduce((total, value) => total + value.bytes, 0), excludedBytes = exclusions.reduce((total, value) => total + value.bytes, 0);
  fs.writeFileSync(join(ARCHIVE, 'source-statistics.json'), jsonBytes(statistics), { flag: 'wx' });
  fs.writeFileSync(join(ARCHIVE, 'source-links.json'), jsonBytes({ policy: 'Do not follow or recreate source symlinks; preserve readlink metadata for deliberate test fixtures.',
    count: sourceLinks.length, entries: sourceLinks }), { flag: 'wx' });
  fs.writeFileSync(join(ARCHIVE, 'exclusions.json'), jsonBytes({ scope: 'Source originals remain untouched at their original paths.',
    excludedFiles: exclusions.length, excludedBytes, entries: exclusions }), { flag: 'wx' });
  const seventh = JSON.parse(fs.readFileSync(join(ARCHIVE, 'originals/defect-ticket-decisions-console-smoke-20261018T093910120/implementation-inputs-before.json')));
  const oldVerifier = seventh.sources['scripts/verify-acceptance-defect-ticket-decisions-console.mjs'];
  const readme = `# D6 开发证据归档\n\n` +
    `2026-10-18；本归档仅保存开发阶段原件，不代替最终构建、最终门禁或精确提交 SHA 的 CI。源现场全部保留。\n\n` +
    `已逐文件复制并读回核验 **${originals.length} 文件 / ${copiedBytes} bytes**；排除 **${exclusions.length} 文件 / ${excludedBytes} bytes**。\n\n` +
    `## 入口与证据范围\n\n` +
    `- [开发报告](originals/d6-browser-development-20261018/REPORT.md)：七轮现场、四组探针对照、截图视觉检查与保证边界。\n` +
    `- [schema/store 最终专项](originals/d6-schema-store-final-20261018T084028628/REPORT.md)：50/50、exit 0，包含全部135个普通原文件、2条符号链接元数据及12个真实SIGKILL场景现场。\n` +
    `- [第七轮 summary](originals/defect-ticket-decisions-console-smoke-20261018T093910120/summary.json)：4×17案内与13全局检查；[当时 strict 原输出](originals/d6-browser-build-20261018T090008180/attempt-7-strict-verifier.log)。\n` +
    `- [逐目录统计](source-statistics.json)、[逐文件排除清单](exclusions.json)、[复制清单](archive-manifest.json)：原路径、目标路径、bytes、SHA-256。\n` +
    `- [测试符号链接元数据](source-links.json)：${sourceLinks.length}条，保存readlink原目标文本、UTF-8 bytes/SHA及lstat尺寸；不跟随、不在Git归档重建链接。\n\n` +
    `原目录名保留在 originals/ 下，因此原开发报告中的跨目录链接仍可导航。复制全部顶层JSON/JSONL/日志/HTML/DOM/PNG与各case原件，四组probe均保留完整脚本、log.json和results.json；Browser运行数据只额外保留不可变defect-ticket事件原件。\n\n` +
    `## 版本与结果限制\n\n` +
    `第七轮runner和当时strict verifier均exit 0，但使用早于约01:20 UTC Catalog四文件改动的旧console bundle。构建前后原件只固定D6两前端输入；不能据此声称最终Catalog已验证。旧bundle的完整文件路径/bytes/SHA清单在第七轮implementation-inputs-before/after.json，未复制可重建dist实体。\n\n` +
    `第七轮当时verifier：**${oldVerifier.bytes} bytes**，SHA-256 **${oldVerifier.sha256}**。[当时 verifier 完整源码](../defect-ticket-decisions-verifier/originals/verifier-before-current-inputs.mjs)已在相邻正式归档保存，bytes与SHA-256均已核对一致。当时before==after及strict原输出均原样保留。后续增强版本增加当前12源码/dist匹配与时间链/快照等检查；它拒绝旧输入属于预期。最终新OUT由root单独归档。\n\n` +
    `第六轮原runner曾返回passed:true/exit0，随后完整relay日志记录finally引起的两条proxy-error。独立strict verifier真实exit1（2!==0），所以第六轮是被严格门禁拒绝的假绿，不能当通过：[原summary](originals/defect-ticket-decisions-console-smoke-20261018T093345261/summary.json)、[完整relay](originals/defect-ticket-decisions-console-smoke-20261018T093345261/relay.jsonl)、[拒绝日志](originals/d6-browser-build-20261018T090008180/attempt-6-strict-verifier.log)。它们均未改写。第七轮有序teardown后全日志零意外代理错误。\n\n` +
    `前四轮completion失败、第五轮普通轮询额外502也完整保留。只保证同一真实数据根和保留不可变动作账本内的受控样例，不宣称断电、备份回滚或跨根exactly-once。\n\n` +
    `## 体积与排除\n\n` +
    `- 全部chromium-profile/：11个浏览器运行/探针目录的缓存、配置、数据库等，逐项路径与bytes见排除清单。\n` +
    `- 七轮Browser runtime/：排除source捕获、Browser operation产物、catalog和运行期状态；仅保留runtime/acceptance/defect-tickets/v1/events/下12个决定原件。其对应raw decision、上游/deny回执、完整ticket/artifact快照与源内容摘要仍在各case和顶层日志中。\n` +
    `- 可重建console/dist实体及依赖不属于这14个源目录，也未作为归档输入；原清单保留旧bundle指纹。没有删除或移动源原件。\n\n` +
    `## 文件核验\n\n` +
    `仅文件I/O，不会启动Browser、engine、Core测试或子进程：\n\n` +
    '```powershell\nnode docs/audits/2026-10-18/evidence/defect-ticket-decisions-development/archive-control.mjs verify\nnode docs/audits/2026-10-18/evidence/defect-ticket-decisions-development/archive-control.mjs verify --sources\n```\n\n' +
    `第一条可在其他checkout核验全部归档字节、文件集合和manifest封印；第二条另读取原本机core/workspace/_runs路径，对所有已复制源文件重新核对。归档manifest不包含自身与其SHA封印文件，verify单独校验二者并拒绝其他多余文件。局部.gitattributes为* -text，局部.gitignore仅为本目录originals解除日志等全局忽略。\n`;
  fs.writeFileSync(join(ARCHIVE, 'README.md'), readme, { flag: 'wx' });
  const manifest = { schemaVersion: 1, kind: 'defect-ticket-decisions-development-originals', createdAt: new Date().toISOString(),
    sourceRoot: posix(REPO), sourceNames, copiedFiles: originals.length, copiedBytes, excludedFiles: exclusions.length, excludedBytes, sourceLinkCount: sourceLinks.length,
    originals, controls: controls.map(path => fileRecord(ARCHIVE, path)) };
  const bytes = jsonBytes(manifest); fs.writeFileSync(join(ARCHIVE, MANIFEST), bytes, { flag: 'wx' });
  fs.writeFileSync(join(ARCHIVE, SEAL), sha(bytes) + '  ' + MANIFEST + '\n', { flag: 'wx' }); verify({ sources: true });
}
assert(process.argv[2] === 'create' || process.argv[2] === 'verify', 'Usage: archive-control.mjs create|verify [--sources]');
assert(process.argv.length <= 4 && (process.argv[3] === undefined || process.argv[2] === 'verify' && process.argv[3] === '--sources'));
if (process.argv[2] === 'create') create(); else verify({ sources: process.argv[3] === '--sources' });
