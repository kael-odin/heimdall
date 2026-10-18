#!/usr/bin/env node
/** V2 file-only final archive. The only child allowed is the copied, fixed D6 strict verifier.
 * Interrupted test disposition is independent of the collection driver's raw terminal status. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, sep, posix as pathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url), ARCHIVE = dirname(SELF);
const DESTINATION = 'docs/audits/2026-10-18/evidence/defect-ticket-decisions-final';
const MANIFEST = 'archive-manifest.json', SEAL = 'archive-manifest.sha256';
const STRICT = 'core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs';
const DECISION_OUT = '21-decision-artifacts';
const GROUPS = ['static', 'core', 'browser', 'docs'];
const REQUIRED_HISTORY = ['core-first-failure', 'core-aborted'];
const REQUIRED_SUPPLEMENTS = ['core-four-case-recheck', 'native-http-before', 'http-keepalive-experiments', 'protected-eight-prestage', 'protected-eight-final', 'frozen-index-final'];
const PROTECTED = ['core/src/acceptance/browser-operation-schema.mjs', 'core/src/acceptance/browser-operation-store.mjs',
  'core/src/acceptance/browser-fixed-contract.mjs', 'core/src/acceptance/browser-fixed-runner.mjs', 'core/src/acceptance/runner.mjs',
  'core/src/acceptance/identity.mjs', 'core/src/acceptance/report.mjs', 'core/src/verify/compare.mjs'];
const SOURCE_KEYS = [
  'src/acceptance/defect-ticket-schema.mjs', 'src/acceptance/defect-ticket-store.mjs', 'src/acceptance/defect-ticket-service.mjs',
  'src/acceptance/defect-ticket-api.mjs', 'src/engine-server.mjs', '../console/src/acceptance-defect-tickets.js', '../console/src/AcceptanceDefectTickets.vue',
  'scripts/smoke-acceptance-defect-ticket-decisions-console.mjs', 'scripts/fixtures/defect-ticket-decision-relay.mjs',
  'scripts/fixtures/defect-ticket-decision-ingress.mjs', 'scripts/fixtures/browser-resolution-stream.mjs', 'scripts/verify-acceptance-defect-ticket-decisions-console.mjs',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const posix = value => value.split(sep).join('/');
const digest = value => ({ bytes: value.length, sha256: sha(value) });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => assert.deepEqual(a, b);
function pathName(value) {
  assert(typeof value === 'string' && value.length && !value.includes('\\') && !value.includes(':') && !value.startsWith('/'), 'A repository-relative POSIX path is required.');
  assert(!value.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe relative path: ' + value); return value;
}
function under(root, name) {
  pathName(name); const full = resolve(root, name); assert(full.startsWith(root + sep));
  let current = root;
  for (const part of name.split('/')) {
    current = join(current, part);
    if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), 'Do not follow a symlink/junction: ' + current);
  }
  return full;
}
function statIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), nlink: String(stat.nlink) };
}
function readStable(full, single = false) {
  const before = fs.lstatSync(full, { bigint: true }); assert(before.isFile() && !before.isSymbolicLink(), 'Regular file required: ' + full);
  if (single) assert.equal(before.nlink, 1n, 'Hard links are not allowed here: ' + full);
  const bytes = fs.readFileSync(full), after = fs.lstatSync(full, { bigint: true });
  equal(statIdentity(before), statIdentity(after)); assert.equal(BigInt(bytes.length), before.size);
  return { bytes, record: digest(bytes), stat: statIdentity(after) };
}
function readJson(full) { return JSON.parse(readStable(full).bytes.toString('utf8').replace(/^\uFEFF/, '')); }
function record(root, name) { return { path: pathName(name), ...readStable(under(root, name), true).record }; }
function scan(root, prefix = '') {
  const result = { files: [], links: [] };
  for (const name of fs.readdirSync(root).sort()) {
    const full = join(root, name), path = prefix + name, stat = fs.lstatSync(full, { bigint: true });
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(full); result.links.push({ path, target, targetUtf8Bytes: Buffer.byteLength(target), targetSha256: sha(Buffer.from(target)), lstatBytes: Number(stat.size) });
    } else if (stat.isDirectory()) {
      const nested = scan(full, path + '/'); result.files.push(...nested.files); result.links.push(...nested.links);
    } else {
      assert(stat.isFile(), 'Unsupported source type: ' + full); const input = readStable(full);
      result.files.push({ path, ...input.record, sourceStat: input.stat });
    }
  }
  return result;
}
function sourceSnapshot(repo, spec) {
  const full = under(repo, spec.source), stat = fs.lstatSync(full); assert(!stat.isSymbolicLink());
  if (stat.isDirectory()) return { kind: 'directory', ...scan(full) };
  assert(stat.isFile()); const input = readStable(full);
  return { kind: 'file', files: [{ path: '', ...input.record, sourceStat: input.stat }], links: [] };
}
function treeDigest(snapshot) {
  return sha(jsonBytes({ kind: snapshot.kind, files: snapshot.files.map(({ path, bytes, sha256, sourceStat }) => ({ path, bytes, sha256, sourceNlink: sourceStat.nlink })), links: snapshot.links }));
}
function flatManifest(value) {
  assert(object(value) && Object.keys(value).length); for (const [path, hash] of Object.entries(value)) { pathName(path); assert(/^[a-f0-9]{64}$/.test(hash)); } return value;
}
function changed(a, b) { return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(key => a[key] !== b[key]); }
function time(value) { assert(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'A real timestamp is required.'); return Date.parse(value); }
function validateProtected(repo, spec, finalInputs) {
  const full = under(repo, spec.source), result = readJson(fs.statSync(full).isDirectory() ? join(full, 'result.json') : full);
  assert.equal(result.schemaVersion, 1); assert.equal(result.passed, true); time(result.at);
  assert(/^[a-f0-9]{40}$/.test(result.baseline) && /^[a-f0-9]{40}$/.test(result.head));
  assert(Array.isArray(result.files)); equal(result.files.map(item => item.path).sort(), [...PROTECTED].sort());
  for (const item of result.files) {
    assert.equal(item.exactMatch, true); assert.equal(item.expectedBaselineMatches, true);
    equal(Object.keys(item.sources).sort(), ['baseline', 'head', 'index', 'worktree'].sort());
    const baseline = item.sources.baseline; assert(Number.isSafeInteger(baseline.bytes) && baseline.bytes >= 0 && /^[a-f0-9]{64}$/.test(baseline.sha256));
    for (const current of Object.values(item.sources)) equal(current, baseline);
    equal(readStable(under(repo, item.path), true).record, baseline); assert.equal(finalInputs[item.path], baseline.sha256);
  }
  return { role: spec.role, source: spec.source, at: result.at, baseline: result.baseline, head: result.head, passed: true, files: result.files.length };
}
function validateBatch(repo, spec) {
  const root = under(repo, spec.source), value = readJson(join(root, 'batch.json'));
  assert.equal(value.schemaVersion, 1); assert(GROUPS.includes(value.group)); assert(Array.isArray(value.plannedStages) && value.plannedStages.length);
  assert(Array.isArray(value.stages) && value.stages.length <= value.plannedStages.length);
  const start = time(value.startedAt), before = flatManifest(readJson(join(root, 'inputs-before.json')));
  let end = Infinity, after;
  const aborted = spec.disposition === 'aborted', interruptionProofs = [];
  if (aborted) {
    assert(['running', 'completed'].includes(value.status), 'An interrupted batch must retain its real running or completed collection status.');
    assert.equal(value.passed, false);
    assert.equal(spec.terminalConfirmed, true, 'The caller must first confirm this interrupted batch has stopped.');
    assert(typeof spec.note === 'string' && spec.note.trim());
    assert(Array.isArray(spec.terminationEvidence) && spec.terminationEvidence.length, 'An aborted batch needs external termination evidence.');
    for (const proofSource of spec.terminationEvidence) {
      assert(typeof proofSource === 'string'); const raw = readStable(under(repo, proofSource)).bytes;
      let proof; try { proof = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { continue; }
      if (!object(proof) || proof.kind !== 'operator-interruption') continue;
      assert(Number.isSafeInteger(proof.targetPid) && proof.targetPid > 0);
      assert(typeof proof.reason === 'string' && proof.reason.trim());
      assert(typeof proof.verifiedCommand === 'string' && proof.verifiedCommand.trim());
      assert(value.plannedStages.some(stage => Array.isArray(stage.argv) && stage.argv.join(' ') === proof.verifiedCommand), 'Operator proof command must identify a planned stage.');
      assert(typeof proof.termination === 'string');
      assert.match(proof.termination, /(?:^|[\\/"\s])taskkill(?:\.exe)?(?:["\s]|$)/i);
      assert.match(proof.termination, new RegExp('(?:^|\\s)/PID\\s+' + proof.targetPid + '(?:\\s|$)', 'i'), 'Operator termination command must identify its recorded target PID.');
      if (value.status === 'completed') {
        assert(value.stages.some(stage => stage.pid === proof.targetPid && Number.isInteger(stage.exitCode) && stage.exitCode !== 0
          && Array.isArray(stage.argv) && stage.argv.join(' ') === proof.verifiedCommand), 'A completed interrupted collection requires the operator-targeted nonzero stage.');
      }
      interruptionProofs.push({ source: proofSource, kind: proof.kind, targetPid: proof.targetPid, verifiedCommand: proof.verifiedCommand, termination: proof.termination });
    }
    assert(interruptionProofs.length, 'An interrupted batch needs an original operator-interruption proof bound to its planned command and target.');
  }
  if (value.status === 'completed') {
    assert.equal(value.status, 'completed'); end = time(value.endedAt); assert(end >= start);
    after = flatManifest(readJson(join(root, 'inputs-after.json'))); equal(value.changedInputs, changed(before, after));
    assert(typeof value.passed === 'boolean'); assert.equal(value.passed, spec.disposition === 'passed');
    if (aborted) assert(value.stages.some(stage => Number.isInteger(stage.exitCode) && stage.exitCode !== 0), 'A completed interrupted collection must retain a nonzero stage.');
  } else { assert(aborted); assert.equal(value.status, 'running'); assert.equal(value.endedAt, null); }
  let previous = start;
  for (const [index, stage] of value.stages.entries()) {
    const plan = value.plannedStages[index]; pathName(stage.name); assert(!stage.name.includes('/')); assert.equal(stage.name, plan.name);
    equal(stage.argv, plan.argv); equal(stage.cwd, plan.cwd); equal(stage.environment, plan.environment);
    const folder = under(root, stage.name); equal(readJson(join(folder, 'run.json')), stage);
    assert(Number.isInteger(stage.exitCode)); assert(Number.isSafeInteger(stage.pid) && stage.pid > 0);
    assert(time(stage.startedAt) >= previous); assert(time(stage.endedAt) >= time(stage.startedAt) && time(stage.endedAt) <= end); previous = time(stage.endedAt);
    assert(typeof stage.durationSeconds === 'number' && stage.durationSeconds >= 0);
    const a = flatManifest(readJson(join(folder, 'inputs-before.json'))), b = flatManifest(readJson(join(folder, 'inputs-after.json')));
    equal(stage.changedInputs, changed(a, b));
    assert.equal(readStable(join(folder, 'stdout.log')).record.sha256, stage.stdoutSha256);
    assert.equal(readStable(join(folder, 'stderr.log')).record.sha256, stage.stderrSha256);
  }
  if (value.status === 'completed') {
    const passed = value.stages.length === value.plannedStages.length && !changed(before, after).length
      && value.stages.every(stage => stage.exitCode === 0 && stage.changedInputs.length === 0);
    assert.equal(value.passed, passed, 'Raw batch status disagrees with its retained stages.');
  }
  return { source: spec.source, role: spec.role, group: value.group, disposition: spec.disposition, rawStatus: value.status,
    rawPassed: value.passed, startedAt: value.startedAt, endedAt: value.endedAt, stages: value.stages.length, plannedStages: value.plannedStages.length,
    note: spec.note ?? null, terminationEvidence: spec.terminationEvidence ?? [], interruptionProofs, before };
}
function excluded(spec, path, sourceRunId) {
  const preserved = DECISION_OUT + '/runtime/acceptance/';
  const strictTree = spec.role === 'final-browser' && ['defect-tickets', sourceRunId].some(name => path === preserved + name || path.startsWith(preserved + name + '/'));
  const profile = path.split('/').some(part => part === 'chromium-profile' || part.endsWith('-chromium-profile'));
  if (strictTree) {
    assert(!profile, 'A profile-named entry inside a strict complete tree must be rejected, never silently pruned: ' + path);
    return null;
  }
  if (profile) return 'chromium-profile';
  if (spec.kind !== 'batch' || !path.split('/').includes('runtime')) return null;
  return 'ordinary-runtime';
}
function strictOriginal(spec, path, sourceRunId) {
  return spec.role === 'final-browser' && path.startsWith(DECISION_OUT + '/') && excluded(spec, path, sourceRunId) === null;
}
function create({ configPath }) {
  assert(configPath, 'create requires --config <file>.');
  const configFull = resolve(configPath), configRaw = readStable(configFull), config = JSON.parse(configRaw.bytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert.equal(config.schemaVersion, 1); assert.equal(config.kind, 'd6-final-archive-inputs'); assert.equal(config.terminalSourcesOnly, true);
  const repo = fs.realpathSync(resolve(config.repositoryRoot)); assert.equal(config.archivePath, DESTINATION);
  const archive = under(repo, DESTINATION); assert.equal(fs.existsSync(archive), false, 'Never overwrite any final or partial archive.');
  assert(fs.statSync(dirname(archive)).isDirectory());
  const configSource = posix(relative(repo, configFull)); pathName(configSource); equal(readStable(under(repo, configSource)).record, configRaw.record);
  const toolSource = posix(relative(repo, SELF)); pathName(toolSource); readStable(under(repo, toolSource));
  assert(object(config.finalBatches)); equal(Object.keys(config.finalBatches).sort(), [...GROUPS].sort());
  assert(Array.isArray(config.history) && Array.isArray(config.supplemental));
  for (const role of REQUIRED_HISTORY) assert(config.history.some(item => item.role === role), 'Missing history role: ' + role);
  for (const role of REQUIRED_SUPPLEMENTS) assert(config.supplemental.some(item => item.role === role), 'Missing supplemental role: ' + role);
  const specs = GROUPS.map(group => ({ id: 'final-' + group, kind: 'batch', role: 'final-' + group, source: pathName(config.finalBatches[group]), disposition: 'passed' }));
  const historical = config.history.map(item => {
    assert(['failed', 'aborted'].includes(item.disposition)); assert(/^[a-z0-9-]+$/.test(item.id));
    return { ...item, kind: 'batch', source: pathName(item.source) };
  });
  specs.push(...historical);
  const summaries = specs.map(spec => validateBatch(repo, spec));
  for (const [index, group] of GROUPS.entries()) {
    assert.equal(summaries[index].group, group); equal(summaries[index].before, summaries[0].before);
    assert.equal(summaries[index].plannedStages, { static: 2, core: 1, browser: 27, docs: 1 }[group]);
  }
  for (const role of REQUIRED_HISTORY) {
    const item = summaries.find(value => value.role === role); assert.equal(item.group, 'core');
    assert.equal(item.disposition, role === 'core-first-failure' ? 'failed' : 'aborted');
  }
  const protectedChecks = [];
  for (const item of config.supplemental) {
    assert(/^[a-z0-9-]+$/.test(item.id)); assert.equal(item.terminalConfirmed, true); assert(typeof item.note === 'string' && item.note.trim());
    pathName(item.source);
    assert(!specs.some(spec => spec.source === item.source || spec.source.startsWith(item.source + '/')), 'A supplemental root must not contain batch roots.');
    if (['protected-eight-prestage', 'protected-eight-final'].includes(item.role)) protectedChecks.push(validateProtected(repo, item, summaries[0].before));
    specs.push({ ...item, kind: 'supplemental' });
  }
  for (const spec of historical) for (const [index, proof] of spec.terminationEvidence?.entries() ?? []) {
    specs.push({ id: spec.id + '-termination-' + index, kind: 'supplemental', role: 'external-termination-evidence', source: pathName(proof), terminalConfirmed: true,
      note: 'External evidence supplied by the caller. The archive preserves it without inventing a completed batch status.' });
  }
  assert.equal(new Set(specs.map(spec => spec.id)).size, specs.length, 'Source ids must be unique.');
  const browser = under(repo, config.finalBatches.browser), decisionRoot = under(browser, DECISION_OUT), summary = readJson(join(decisionRoot, 'summary.json'));
  assert.equal(summary.passed, true); pathName(summary.sourceRunId); assert(!summary.sourceRunId.includes('/'));
  const inputs = readJson(join(decisionRoot, 'implementation-inputs-before.json'));
  equal(inputs, readJson(join(decisionRoot, 'implementation-inputs-after.json'))); assert(object(inputs.sources) && object(inputs.consoleBundle));
  equal(Object.keys(inputs.sources).sort(), [...SOURCE_KEYS].sort()); assert(Object.keys(inputs.consoleBundle).length);
  const snapshots = SOURCE_KEYS.map(key => {
    const source = pathPosix.normalize('core/' + key); pathName(source);
    const current = readStable(under(repo, source), true); equal(current.record, inputs.sources[key]); assert.equal(current.record.sha256, summaries[0].before[source]);
    return { source, path: 'implementation/' + source, ...current.record, requireSingle: true };
  });
  const dist = sourceSnapshot(repo, { source: 'console/dist' }); assert.equal(dist.kind, 'directory'); assert.equal(dist.links.length, 0);
  assert(dist.files.every(file => file.sourceStat.nlink === '1'), 'The original built console tree must not contain hard links.');
  equal(Object.fromEntries(dist.files.map(({ path, bytes, sha256 }) => [path, { bytes, sha256 }])), inputs.consoleBundle);
  snapshots.push(...dist.files.map(({ path, bytes, sha256 }) => ({ source: 'console/dist/' + path, path: 'implementation/console/dist/' + path, bytes, sha256, requireSingle: true })));
  const originals = [{ source: configSource, path: 'inputs/archive-config.json', ...configRaw.record },
    { source: toolSource, path: 'archive-control.mjs', ...readStable(SELF).record }, ...snapshots];
  const exclusions = [], links = [], statistics = [{ id: 'implementation-console-dist', role: 'implementation-dist-snapshot', source: 'console/dist', sourceKind: 'directory',
    disposition: 'snapshot', note: 'The complete original dist tree must remain identical before/after copying and on --sources verification.', treeSha256: treeDigest(dist),
    sourceFiles: dist.files.length, sourceBytes: dist.files.reduce((sum, item) => sum + item.bytes, 0), keptFiles: dist.files.length,
    keptBytes: dist.files.reduce((sum, item) => sum + item.bytes, 0), excludedFiles: 0, excludedBytes: 0, symbolicLinks: 0 }];
  for (const spec of specs) {
    assert(!spec.source.startsWith(DESTINATION + '/') && spec.source !== DESTINATION);
    const snapshot = sourceSnapshot(repo, spec); let keptFiles = 0, keptBytes = 0, excludedFiles = 0, excludedBytes = 0;
    for (const file of snapshot.files) {
      const source = spec.source + (file.path ? '/' + file.path : ''), path = 'originals/' + spec.id + (file.path ? '/' + file.path : '/original-file');
      const reason = excluded(spec, file.path, summary.sourceRunId), requireSingle = strictOriginal(spec, file.path, summary.sourceRunId);
      if (requireSingle) assert.equal(file.sourceStat.nlink, '1', 'The original strict evidence must not contain hard links: ' + source);
      const entry = { source, path, bytes: file.bytes, sha256: file.sha256, ...(requireSingle ? { requireSingle: true } : {}) };
      if (reason) { exclusions.push({ source, bytes: file.bytes, sha256: file.sha256, reason }); excludedFiles++; excludedBytes += file.bytes; }
      else { originals.push(entry); keptFiles++; keptBytes += file.bytes; }
    }
    for (const link of snapshot.links) {
      assert(!strictOriginal(spec, link.path, summary.sourceRunId), 'The original strict evidence must not contain symbolic links: ' + spec.source + '/' + link.path);
      links.push({ source: spec.source + '/' + link.path, ...link, reason: 'Preserve readlink metadata without following or recreating the link.' });
    }
    statistics.push({ id: spec.id, role: spec.role, source: spec.source, sourceKind: snapshot.kind, disposition: spec.disposition ?? 'supplemental', note: spec.note ?? null,
      treeSha256: treeDigest(snapshot), sourceFiles: snapshot.files.length, sourceBytes: snapshot.files.reduce((sum, value) => sum + value.bytes, 0),
      keptFiles, keptBytes, excludedFiles, excludedBytes, symbolicLinks: snapshot.links.length });
  }
  assert.equal(new Set(originals.map(item => item.path)).size, originals.length);
  fs.mkdirSync(archive);
  for (const entry of originals) {
    const source = under(repo, entry.source), before = readStable(source, entry.requireSingle === true), destination = under(archive, entry.path); equal(before.record, { bytes: entry.bytes, sha256: entry.sha256 });
    fs.mkdirSync(dirname(destination), { recursive: true }); fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    equal(readStable(destination, true).bytes, before.bytes); const after = readStable(source, entry.requireSingle === true); equal(after.bytes, before.bytes); equal(after.stat, before.stat);
  }
  for (const item of statistics) {
    const after = sourceSnapshot(repo, { source: item.source }); assert.equal(treeDigest(after), item.treeSha256, 'A source root changed while being archived: ' + item.source);
  }
  const write = (name, bytes) => { const full = under(archive, name); fs.mkdirSync(dirname(full), { recursive: true }); fs.writeFileSync(full, bytes, { flag: 'wx' }); };
  write('.gitattributes', '* -text\n'); write('.gitignore', '# Keep every byte of this sealed evidence tree, including logs and bundles.\n!*\n!*/\n');
  write('source-statistics.json', jsonBytes(statistics)); write('source-links.json', jsonBytes({ policy: 'No source symlink is followed or recreated.', entries: links }));
  write('exclusions.json', jsonBytes({ sourceOriginalsUntouched: true, entries: exclusions }));
  write('batch-statuses.json', jsonBytes(summaries.map(({ before, ...item }) => item)));
  write('protected-eight-checks.json', jsonBytes(protectedChecks));
  const strictScript = under(archive, 'implementation/' + STRICT), strictOut = under(archive, 'originals/final-browser/' + DECISION_OUT);
  const strictStart = new Date().toISOString();
  const strict = spawnSync(process.execPath, [strictScript, strictOut], { cwd: under(archive, 'implementation'), windowsHide: true, shell: false,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const strictResult = { schemaVersion: 1, kind: 'copied-original-d6-strict-verifier', argv: [process.execPath, strictScript, strictOut],
    startedAt: strictStart, endedAt: new Date().toISOString(), exitCode: strict.status, signal: strict.signal, error: strict.error?.message ?? null,
    passed: strict.status === 0 && !strict.error && !strict.signal, stdoutSha256: sha(strict.stdout ?? Buffer.alloc(0)), stderrSha256: sha(strict.stderr ?? Buffer.alloc(0)) };
  write('verification/strict/stdout.log', strict.stdout ?? Buffer.alloc(0)); write('verification/strict/stderr.log', strict.stderr ?? Buffer.alloc(0));
  write('verification/strict/run.json', jsonBytes(strictResult));
  const readme = '# D6 最终门禁原件归档\n\n' +
    '2026-10-18。只复制显式指定且已结束的来源；源现场全部保留。此归档不替代精确提交 SHA 的后续 CI。\n\n' +
    '## 入口\n\n- [真实批次状态](batch-statuses.json)：四组最终门禁、首轮 Core 唯一失败及外部中止批次；原 batch.json/run.json 未改写。\n' +
    '- [逐目录统计](source-statistics.json)、[排除清单](exclusions.json)、[链接元数据](source-links.json)、[复制清单与封印](archive-manifest.json)。\n' +
    '- [原严格校验器再执行](verification/strict/run.json)，exitCode ' + strictResult.exitCode + '，passed ' + strictResult.passed + '；stdout/stderr 原字节独立保留。\n' +
    '- originals/final-browser/21-decision-artifacts/ 保存四案截图、DOM、raw、完整日志、全部 case 及完整 defect-tickets 树和 sourceRunId 树。没有为通过校验删减这两棵运行树的额外文件。\n' +
    '- implementation/ 保留原布局的12个源码文件及完整 console/dist，精确匹配四案 before==after；再执行的 verifier 就是其中原件，未修改。\n\n' +
    '## 来源与保证边界\n\n' + statistics.map(item => '- `' + item.id + '`：`' + item.source + '`；' + item.disposition + '；' + (item.note ?? '最终 ' + item.role + ' 门禁。')).join('\n') + '\n\n' +
    'Core 首轮失败和修后四案专项分别保存；native-http-fixture-connection 修前文件/说明及 http-keepalive-loopback 最小实验独立保留。最小实验的未复现结论不等于确认根因。protected-eight 发布前及最终 stage 后的原始 blob 核对材料独立保存。\n\n' +
    '中止测试 disposition 始终为 aborted，独立于采集 driver 的原 running/null 或 completed/false 状态；后者保留原 endedAt、非零 stage 与完整 run/log/input/time 校验。operator-interruption 原证明须绑定计划命令和目标 PID，completed 情形还须对应被中止的非零 stage。外部停止证据及调用方 terminalConfirmed 声明另存，归档器不改写原 batch，也不把它计为完整 Core 通过或启动进程推断现场。\n\n' +
    '全部 Chromium profile 排除；两棵完整 strict 依赖树若出现 profile 命名则直接拒绝，不能静默删减。批次普通 runtime 排除，仅最终21案完整保留上述两棵严格校验依赖树。supplemental 目录完整保留普通 runtime。每个排除普通文件均记录原路径、bytes、SHA-256。21案非排除原件、12源码和完整dist拒绝源symlink及硬链接；其余源符号链接只保存 readlink 元数据，未跟随。所有已复制文件都使用 COPYFILE_EXCL，并核对复制前后源 stat/SHA 与目标读回；完整dist来源文件集和所有来源nlink亦前后复验。\n\n' +
    '本归档纳入 prearchive docs 以及已stage维护输入的 frozen-index/protected-eight 原结果。归档本身和后续证据不要求事先stage；新增归档Markdown及最终报告链接后的 postarchive docs、最终整次stage/index原始复核由相邻独立 release-checks 接续，不能回写本封印。\n\n' +
    '## 只读核验\n\n```powershell\nnode ' + DESTINATION + '/archive-control.mjs verify\nnode ' + DESTINATION + '/archive-control.mjs verify --sources\n```\n\n' +
    '普通 verify 只读取归档，核验完整文件集合、全部字节、manifest封印、strict原输出摘要及实现快照匹配；--sources 另外核验本机每个已复制/排除文件、链接元数据和每棵来源完整文件集合。verify 不创建子进程。create 只允许运行一次副本内固定 strict verifier，不运行 Core、engine、Browser、测试或目标网络请求。失败也原样封存，不补造通过。\n';
  write('README.md', readme);
  const originalNames = new Set(originals.map(item => item.path)), all = scan(archive); assert.equal(all.links.length, 0);
  const controls = all.files.filter(item => !originalNames.has(item.path)).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const manifest = { schemaVersion: 1, kind: 'defect-ticket-decisions-final-originals', createdAt: new Date().toISOString(), sourceRoot: posix(repo),
    originals, controls, statistics, strict: strictResult, copiedFiles: originals.length, copiedBytes: originals.reduce((sum, item) => sum + item.bytes, 0),
    excludedFiles: exclusions.length, excludedBytes: exclusions.reduce((sum, item) => sum + item.bytes, 0), sourceLinkCount: links.length };
  const bytes = jsonBytes(manifest); write(MANIFEST, bytes); write(SEAL, sha(bytes) + '  ' + MANIFEST + '\n');
  return verify({ root: archive, sources: true });
}
function verify({ root = ARCHIVE, sources = false } = {}) {
  const manifestRaw = readStable(join(root, MANIFEST), true).bytes, manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'defect-ticket-decisions-final-originals');
  assert.equal(readStable(join(root, SEAL), true).bytes.toString('utf8'), sha(manifestRaw) + '  ' + MANIFEST + '\n');
  const entries = [...manifest.originals, ...manifest.controls]; assert.equal(new Set(entries.map(item => item.path)).size, entries.length);
  for (const item of entries) equal(record(root, item.path), { path: item.path, bytes: item.bytes, sha256: item.sha256 });
  const all = scan(root); assert.equal(all.links.length, 0); equal(all.files.map(item => item.path).sort(), [...entries.map(item => item.path), MANIFEST, SEAL].sort());
  const strict = readJson(join(root, 'verification/strict/run.json')); equal(strict, manifest.strict);
  assert.equal(sha(readStable(join(root, 'verification/strict/stdout.log')).bytes), strict.stdoutSha256);
  assert.equal(sha(readStable(join(root, 'verification/strict/stderr.log')).bytes), strict.stderrSha256);
  assert.equal(strict.passed, strict.exitCode === 0 && !strict.error && !strict.signal);
  const excludedEntries = readJson(join(root, 'exclusions.json')).entries;
  assert.equal(manifest.excludedFiles, excludedEntries.length); assert.equal(manifest.excludedBytes, excludedEntries.reduce((sum, item) => sum + item.bytes, 0));
  assert.equal(manifest.sourceLinkCount, readJson(join(root, 'source-links.json')).entries.length);
  const before = readJson(join(root, 'originals/final-browser/' + DECISION_OUT + '/implementation-inputs-before.json'));
  equal(before, readJson(join(root, 'originals/final-browser/' + DECISION_OUT + '/implementation-inputs-after.json')));
  equal(Object.keys(before.sources).sort(), [...SOURCE_KEYS].sort());
  for (const key of SOURCE_KEYS) equal(readStable(under(root, 'implementation/' + pathPosix.normalize('core/' + key)), true).record, before.sources[key]);
  const bundle = scan(under(root, 'implementation/console/dist')); assert.equal(bundle.links.length, 0);
  equal(Object.fromEntries(bundle.files.map(({ path, bytes, sha256 }) => [path, { bytes, sha256 }])), before.consoleBundle);
  if (sources) {
    const repo = fs.realpathSync(resolve(manifest.sourceRoot));
    for (const item of manifest.originals) equal(readStable(under(repo, item.source), item.requireSingle === true).record, { bytes: item.bytes, sha256: item.sha256 });
    for (const item of excludedEntries) equal(readStable(under(repo, item.source)).record, { bytes: item.bytes, sha256: item.sha256 });
    for (const item of manifest.statistics) assert.equal(treeDigest(sourceSnapshot(repo, { source: item.source })), item.treeSha256);
  }
  assert.equal(manifest.copiedFiles, manifest.originals.length); assert.equal(manifest.copiedBytes, manifest.originals.reduce((sum, item) => sum + item.bytes, 0));
  const complete = all.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  const result = { schemaVersion: 1, kind: 'd6-final-archive-verification', passed: strict.passed, integrityPassed: true, strictPassed: strict.passed,
    checkedSources: sources, archiveFiles: complete.length, archiveBytes: complete.reduce((sum, item) => sum + item.bytes, 0), copiedFiles: manifest.copiedFiles,
    copiedBytes: manifest.copiedBytes, excludedFiles: manifest.excludedFiles, excludedBytes: manifest.excludedBytes, manifestSha256: sha(manifestRaw), treeSha256: sha(jsonBytes(complete)) };
  console.log(JSON.stringify(result, null, 2)); return result;
}
const args = process.argv.slice(2);
assert(args[0] === 'create' || args[0] === 'verify', 'Usage: archive-control.mjs create --config <file> | verify [--sources]');
let result;
if (args[0] === 'create') { assert.equal(args.length, 3); assert.equal(args[1], '--config'); result = create({ configPath: args[2] }); }
else { assert(args.length === 1 || args.length === 2 && args[1] === '--sources'); result = verify({ sources: args[1] === '--sources' }); }
if (!result.passed) process.exitCode = 1;
