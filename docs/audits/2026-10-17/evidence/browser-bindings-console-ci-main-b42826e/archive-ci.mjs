import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = process.cwd();
const INPUT = join(HERE, 'failure-collection');
const OUT = join(ROOT, 'docs/audits/2026-10-17/evidence/browser-bindings-console-ci-main-b42826e');
const HEAD = 'b42826e4956d491b461bbd00af3d18b2ad702ad5', RUN = 39005540253;
const slash = value => value.replaceAll('\\', '/');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const info = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function walk(base, sub = '') {
  return readdirSync(join(base, sub)).flatMap(name => {
    const path = join(sub, name), stat = lstatSync(join(base, path)); assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) return walk(base, path);
    assert.equal(stat.isFile(), true); return [{ path: slash(path), ...info(join(base, path)) }];
  }).sort(compare);
}
const collected = json(join(INPUT, 'COLLECTED.json')), run = json(join(INPUT, 'run.json'));
const jobs = json(join(INPUT, 'jobs.json')), artifacts = json(join(INPUT, 'artifacts.json')), view = json(join(INPUT, 'run-view.json'));
assert.equal(collected.status, 'collected'); assert.equal(collected.runId, RUN); assert.equal(collected.head, HEAD);
assert.equal(run.id, RUN); assert.equal(run.head_sha, HEAD); assert.equal(run.head_branch, 'main'); assert.equal(run.event, 'push'); assert.equal(run.run_attempt, 1);
assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'failure'); assert.equal(run.path, '.github/workflows/ci.yml');
assert.equal(view.databaseId, RUN); assert.equal(view.headSha, HEAD); assert.equal(view.attempt, 1); assert.equal(view.conclusion, 'failure');
assert.equal(jobs.total_count, jobs.jobs.length); assert.equal(jobs.jobs.length, 3);
assert.ok(jobs.jobs.every(job => job.run_id === RUN && job.head_sha === HEAD && job.status === 'completed'));
assert.equal(jobs.jobs.filter(job => job.conclusion === 'failure').length, 1); assert.equal(jobs.jobs.filter(job => job.conclusion === 'success').length, 2);
assert.equal(artifacts.total_count, artifacts.artifacts.length); assert.equal(artifacts.total_count, collected.downloadedArtifacts.length);
for (const command of collected.commands) {
  assert.equal(command.code, 0); assert.equal(command.signal, null);
  for (const channel of ['stdout', 'stderr']) assert.deepEqual(info(join(INPUT, command[channel].path)), { bytes: command[channel].bytes, sha256: command[channel].sha256 });
}
const commandCopies = [
  ['01-run', 'run.json'], ['02-jobs', 'jobs.json'], ['03-artifacts', 'artifacts.json'], ['04-view', 'run-view.json'],
  ['05-workflow', 'workflow-content.json'], ['06-log', 'ci.stdout.log'], ['07-zip', 'run-logs.zip'], ['08-extract-logs', 'zip-inventory.json'],
  ...collected.downloadedArtifacts.flatMap(artifact => [
    ['09-artifact-' + artifact.id + '-zip', artifact.archive.path], ['10-artifact-' + artifact.id + '-extract', artifact.inventory.path],
  ]),
];
for (const [tag, path] of commandCopies) {
  const command = collected.commands.find(item => item.tag === tag); assert.ok(command);
  assert.ok(readFileSync(join(INPUT, command.stdout.path)).equals(readFileSync(join(INPUT, path))));
}
function verifyZip(archivePath, extractionPath, inventoryPath) {
  const inventory = json(join(INPUT, inventoryPath)); assert.equal(inventory.crcTestPassed, true); assert.equal(inventory.allExtractedBytesEqualZipEntries, true);
  assert.equal(inventory.fileCount, inventory.files.length); assert.equal(readFileSync(join(INPUT, archivePath)).toString('ascii', 0, 2), 'PK');
  assert.deepEqual(walk(join(INPUT, extractionPath)), inventory.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort(compare));
  return { archive: { path: archivePath, ...info(join(INPUT, archivePath)) }, extractedPath: extractionPath,
    inventory: { path: inventoryPath, ...info(join(INPUT, inventoryPath)) }, zipEntries: inventory.zipEntries,
    fileCount: inventory.fileCount, extractedBytes: inventory.bytes, crcTestPassed: true,
    allExtractedBytesEqualZipEntries: true, files: inventory.files };
}
const logsZip = verifyZip('run-logs.zip', 'extracted', 'zip-inventory.json');
const artifactZips = collected.downloadedArtifacts.map(item => {
  const metadata = artifacts.artifacts.find(artifact => artifact.id === item.id); assert.ok(metadata); assert.equal(metadata.expired, false);
  assert.equal(metadata.workflow_run.id, RUN); assert.equal(metadata.workflow_run.head_sha, HEAD);
  assert.equal(metadata.digest, 'sha256:' + info(join(INPUT, item.archive.path)).sha256);
  assert.equal(metadata.size_in_bytes, info(join(INPUT, item.archive.path)).bytes);
  return { id: item.id, name: item.name, metadataDigestVerified: true, ...verifyZip(item.archive.path, 'artifacts/' + item.id + '/extracted', item.inventory.path) };
});
const workflow = json(join(INPUT, 'workflow-content.json')); assert.equal(workflow.path, '.github/workflows/ci.yml'); assert.equal(workflow.encoding, 'base64');
const workflowBytes = Buffer.from(workflow.content, 'base64');
assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${workflowBytes.length}\0`), workflowBytes])).digest('hex'), workflow.sha);
const namedCommands = [...workflowBytes.toString('utf8').matchAll(/^      - name: (.+)\r?\n        run: (.+)\r?$/gm)].map(([, name, command]) => ({ name, command }));
const smokePrefixes = ['Acceptance console (', 'Spec contract console (', 'Acceptance comparison console (', 'Acceptance project catalog (', 'Acceptance catalog migration (', 'Spec baseline review (', 'Managed Spec preparation (', 'Managed Spec result reading (', 'Owned acceptance recovery (', 'Managed Spec execution (', 'Managed execution UI (', 'Browser candidate source (', 'Browser private source reader (', 'Browser source bindings (', 'Browser source binding console ('];
const expectedCommands = ['pnpm acceptance:smoke', 'pnpm acceptance:spec:smoke', 'pnpm acceptance:comparison:smoke', 'pnpm acceptance:catalog:smoke', 'pnpm acceptance:catalog:migration:smoke', 'pnpm acceptance:baseline:smoke', 'pnpm acceptance:managed:prepare:smoke', 'pnpm acceptance:managed:read:smoke', 'pnpm acceptance:owned:recovery:smoke', 'pnpm acceptance:managed:execute:smoke', 'pnpm acceptance:execution:ui:smoke', 'pnpm acceptance:browser:source:smoke', 'pnpm acceptance:browser:read:smoke', 'pnpm acceptance:browser:bindings:smoke', 'pnpm acceptance:browser:bindings:ui:smoke'];
const core = jobs.jobs.find(job => job.name === 'core (lint + test)'); assert.ok(core);
const compact = ({ number, name, status, conclusion, started_at, completed_at }) => ({ number, name, status, conclusion, startedAt: started_at, completedAt: completed_at });
const smokes = smokePrefixes.map((prefix, index) => {
  const matches = core.steps.filter(step => step.name.startsWith(prefix)); assert.equal(matches.length, 1);
  const step = matches[0]; assert.deepEqual(namedCommands.filter(item => item.name === step.name), [{ name: step.name, command: expectedCommands[index] }]);
  assert.equal(step.status, 'completed'); assert.equal(step.conclusion, index === 0 ? 'failure' : 'skipped'); return { ...compact(step), command: expectedCommands[index] };
});
const docker = core.steps.find(step => step.name === 'Docker offline delivery (SSR + SPA + data SPA + adapter)'); assert.ok(docker); assert.equal(docker.conclusion, 'skipped');
const coreStep = core.steps.find(step => step.name === 'Run pnpm test'); assert.equal(coreStep.conclusion, 'success');
const rows = readFileSync(join(INPUT, 'ci.stdout.log'), 'utf8').split(/\r?\n/).flatMap(line => {
  const a = line.indexOf('\t'), b = line.indexOf('\t', a + 1); return a < 0 || b < 0 ? [] : [{ job: line.slice(0, a), step: line.slice(a + 1, b), text: line.slice(b + 1).replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\S+Z ?/, '') }];
});
const stepRows = name => rows.filter(row => row.job === core.name && row.step === name);
const stepText = name => stepRows(name).map(row => row.text).join('\n');
function totals(text) {
  const values = {}, occurrences = {};
  for (const [, key, value] of text.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)\s*$/gm)) { values[key] = Number(value); occurrences[key] = (occurrences[key] ?? 0) + 1; }
  assert.equal(Object.keys(values).length, 8); assert.ok(Object.values(occurrences).every(count => count === 1));
  assert.equal(values.tests, values.pass + values.skipped); assert.equal(values.fail, 0); assert.equal(values.cancelled, 0); assert.equal(values.todo, 0); return values;
}
const coreSuite = totals(stepText('Run pnpm test'));
const coreSkipLines = stepRows('Run pnpm test').filter(row => /# SKIP(?:\s|$)/i.test(row.text)).map(row => row.text); assert.equal(coreSkipLines.length, coreSuite.skipped);
const coreZipLogs = logsZip.files.filter(file => file.path.startsWith(core.name + '/') && file.path.endsWith('_Run pnpm test.txt')); assert.equal(coreZipLogs.length, 1);
assert.deepEqual(totals(readFileSync(join(INPUT, 'extracted', coreZipLogs[0].path), 'utf8').replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\S+Z ?/gm, '')), coreSuite);
const failureArtifact = artifactZips.find(item => item.files.some(file => file.path.endsWith('/acceptance-failure.json'))); assert.ok(failureArtifact);
const failurePath = failureArtifact.extractedPath + '/' + failureArtifact.files.find(file => file.path.endsWith('/acceptance-failure.json')).path;
const screenshotPath = failureArtifact.extractedPath + '/' + failureArtifact.files.find(file => file.path.endsWith('/acceptance-failure.png')).path;
const failure = json(join(INPUT, failurePath)), png = readFileSync(join(INPUT, screenshotPath)); assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
const conflicts = failure.recentResponses.map((response, index) => ({ index, ...response })).filter(response => response.status === 409);
assert.equal(conflicts.length, 1); assert.equal(conflicts[0].method, 'GET'); assert.equal(conflicts[0].code, 'MANAGED_RUN_INTEGRITY_FAILED');
assert.equal(failure.consoleErrors.length, 1); assert.equal(failure.consoleErrors[0].location.url, conflicts[0].url);
const diagnostic = { schemaVersion: 1, failedStep: smokes[0], failureJson: failurePath, failureScreenshot: screenshotPath,
  screenshotDimensions: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, error: failure.error,
  consoleErrors: failure.consoleErrors, pageErrors: failure.pageErrors, recordedConflictResponses: conflicts,
  sameUrlResponses: failure.recentResponses.map((response, index) => ({ index, ...response })).filter(response => response.url === conflicts[0].url),
  rawFailureStepText: stepText(smokes[0].name), timingBoundary: 'recentResponses preserves order only; the uploaded failure JSON contains no per-response timestamp or full response body. No race root cause is asserted from the transient 409 alone.' };

assert.equal(existsSync(OUT), false, 'Never overwrite or silently resume any existing archive');
const inputs = walk(INPUT).map(file => ({ source: slash(relative(ROOT, join(INPUT, file.path))), path: file.path, bytes: file.bytes, sha256: file.sha256 }));
const monitoredNames = readdirSync(HERE).filter(name => /^(?:snapshot-[a-f0-9-]+\.json|(?:run-list|run-api|jobs-api|workflow-api|watch|collect-failure)-[a-f0-9-]+)$/.test(name));
for (const name of monitoredNames) {
  const source = join(HERE, name), stat = lstatSync(source); assert.equal(stat.isSymbolicLink(), false);
  const files = stat.isDirectory() ? walk(source) : [{ path: '', ...info(source) }];
  for (const file of files) inputs.push({ source: slash(relative(ROOT, join(source, file.path))), path: 'monitoring/' + name + (file.path ? '/' + file.path : ''), bytes: file.bytes, sha256: file.sha256 });
}
for (const [source, path] of [['AUTHORIZED.json', 'monitoring/AUTHORIZED.json'], ['poll-ci.mjs', 'monitoring/poll-ci.mjs'], ['run-recorded.mjs', 'monitoring/run-recorded.mjs'], ['collect-failed-ci.mjs', 'collect-ci.mjs'], ['extract-logs.py', 'extract-logs.py'], ['publish-failed-ci.mjs', 'archive-ci.mjs']]) inputs.push({ source: slash(relative(ROOT, join(HERE, source))), path, ...info(join(HERE, source)) });
assert.equal(new Set(inputs.map(file => file.path)).size, inputs.length);
for (const name of monitoredNames.filter(name => /^(?:watch|collect-failure)-/.test(name))) assert.equal(json(join(HERE, name, 'exitcode.json')).code, 0);
mkdirSync(OUT);
function write(path, bytes) { const file = join(OUT, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: 'wx' }); assert.ok(readFileSync(file).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))); return { path, ...info(file) }; }
const writeJson = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
write('.gitattributes', '* -text\nREADME.md text eol=lf\n.gitattributes text eol=lf\n.gitignore text eol=lf\n*.json whitespace=cr-at-eol\n\n# Preserve exact original output whitespace.\nci.stdout.log -whitespace\ncommands/*.stdout.bin -whitespace\ncommands/*.stderr.log -whitespace\nextracted/**/*.txt -whitespace\nmonitoring/*/stdout.bin -whitespace\nmonitoring/*/stderr.log -whitespace\nmonitoring/watch-*/stdout.log -whitespace\nmonitoring/collect-failure-*/stdout.log -whitespace\nartifacts/**/extracted/**/*.log -whitespace\n');
write('.gitignore', '# Retain original raw logs despite repository runtime-log rules.\n!*.log\n');
for (const file of inputs) write(file.path, readFileSync(join(ROOT, file.source)));
const verifyInputs = () => { for (const file of inputs) { assert.deepEqual(info(join(ROOT, file.source)), { bytes: file.bytes, sha256: file.sha256 }); assert.deepEqual(info(join(OUT, file.path)), { bytes: file.bytes, sha256: file.sha256 }); assert.ok(readFileSync(join(ROOT, file.source)).equals(readFileSync(join(OUT, file.path)))); } };
verifyInputs();
writeJson('input-files.json', { schemaVersion: 1, head: HEAD, runId: RUN, originalInputCount: inputs.length, files: inputs, byteCopyRoundTripPassed: true });
write('workflow-at-head.yml', workflowBytes);
writeJson('diagnostic-summary.json', diagnostic);
const strongPatterns = [
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g], ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ['openai-style-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g], ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key-header', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g], ['long-bearer-credential', /\bBearer\s+[A-Za-z0-9._=-]{24,}/g],
];
const scanned = [], binaryInputs = [], hits = [], keywords = /api[_-]?key|authorization|bearer|password|set-cookie|secret/gi;
for (const file of walk(OUT)) {
  const bytes = readFileSync(join(OUT, file.path));
  if (bytes.toString('ascii', 0, 2) === 'PK' || bytes.toString('hex', 0, 8) === '89504e470d0a1a0a') { binaryInputs.push({ ...file, format: bytes.toString('ascii', 0, 2) === 'PK' ? 'zip' : 'png' }); continue; }
  const text = bytes.toString('utf8'); assert.ok(Buffer.from(text, 'utf8').equals(bytes), 'Unknown non-UTF8 input refused: ' + file.path);
  scanned.push({ ...file, keywordOccurrences: [...text.matchAll(keywords)].length });
  for (const [pattern, regex] of strongPatterns) { regex.lastIndex = 0; const matches = [...text.matchAll(regex)]; if (matches.length) hits.push({ path: file.path, pattern, count: matches.length, lines: matches.map(match => text.slice(0, match.index).split('\n').length) }); }
}
const security = { schemaVersion: 1, scannedAt: new Date().toISOString(), scope: 'Every textual input and derived diagnostic present before later summary/security/manifest generation. ZIP entry bodies are independently extracted and scanned. Known ZIP/PNG binary bodies are listed separately.', strongPatterns: strongPatterns.map(([name, regex]) => ({ name, expression: regex.source })), strongMatchCount: hits.reduce((sum, hit) => sum + hit.count, 0), hits, fileCount: scanned.length, files: scanned, binaryInputs, keywordPolicy: 'Keywords are counts, not credentials. Zero strong matches is limited to the listed expressions; no credential value is emitted.' };
writeJson('sensitive-scan.json', security); assert.equal(security.strongMatchCount, 0, 'Review strong-pattern hits before completion');
const summary = { schemaVersion: 1, runId: RUN, head: HEAD, attempt: 1, headBranch: 'main', event: 'push', status: run.status, conclusion: run.conclusion, runUrl: run.html_url,
  createdAt: run.created_at, startedAt: run.run_started_at, updatedAt: run.updated_at, archivedAt: new Date().toISOString(),
  jobs: jobs.jobs.map(({ id, name, status, conclusion, started_at, completed_at }) => ({ id, name, status, conclusion, startedAt: started_at, completedAt: completed_at })),
  coreSuite, coreSkippedTests: coreSkipLines, coreCountsFromZipStep: 'extracted/' + coreZipLogs[0].path,
  acceptanceSmokes: { total: smokes.length, successful: 0, failed: 1, skipped: 14, steps: smokes }, phaseCConsole: smokes.at(-1),
  docker: { step: compact(docker), tests: null, boundary: 'Skipped after acceptance console failure; no Docker test result exists in this run.' },
  artifactsTotalCount: artifacts.total_count, downloadedArtifacts: artifactZips.map(({ files, ...item }) => item),
  rawLog: { path: 'ci.stdout.log', ...info(join(OUT, 'ci.stdout.log')) }, rawZip: { path: 'run-logs.zip', ...info(join(OUT, 'run-logs.zip')), entries: logsZip.zipEntries, extractedFiles: logsZip.fileCount, extractedBytes: logsZip.extractedBytes },
  strongSensitiveMatches: security.strongMatchCount, countPolicy: 'Only this remote full Core is counted once. Its success does not make the failed CI successful. First acceptance smoke failed; the next 14 including C and Docker were skipped. No local or other-commit result substitutes for them.',
  failure: { step: smokes[0], sourceLocation: 'core/scripts/smoke-acceptance-console.mjs:161:10', statusCode: 409, code: conflicts[0].code, method: conflicts[0].method, url: conflicts[0].url, diagnostic: 'diagnostic-summary.json', artifactFailureJson: failurePath, artifactScreenshot: screenshotPath },
};
writeJson('summary.json', summary);
writeJson('verification.json', { schemaVersion: 1, runId: RUN, head: HEAD, verifiedAt: new Date().toISOString(), checks: { exactMainPushRunAndHead: true, completedFailurePreserved: true, threeJobsFullyAccountedFor: true, exactRemoteWorkflowBlobVerified: true, fifteenRemoteSmokeCommandsVerified: true, firstSmokeFailedAndNextFourteenSkipped: true, phaseCConsoleNotClaimedPassed: true, dockerSkippedNotClaimedPassed: true, fullCoreCountsMatchGhAndZip: true, allLogZipEntriesCrcAndBytesVerified: true, uploadedArtifactMetadataDigestVerified: true, allArtifactZipEntriesCrcAndBytesVerified: true, allInputCopyBytesAndShaVerified: true, strongSensitivePatternScanPassed: true }, commandAttempts: collected.commands, binaryInputs: security.binaryInputs });
write('README.md', `# Browser source binding console：精确提交 CI 失败证据\n\nGitHub run [${RUN}](${run.html_url})，attempt 1，head \`${HEAD}\`，\`main / push\`，结果 **completed / failure**。本包完整保存该失败事实；归档完成仅表示证据包完整。\n\n- 完整 Linux Core：**${coreSuite.tests} total / ${coreSuite.pass} pass / ${coreSuite.fail} fail / ${coreSuite.skipped} skip**，${coreSuite.duration_ms} ms，步骤成功。\n- 第一个 Acceptance console smoke 失败；其后 **14 个 acceptance smoke 均 skipped**，包括片 C 控制台 smoke。\n- Docker 独立步骤 **skipped**。片 C 不能据该 CI 标记通过。\n- e2e smoke job 与 console build job 成功。\n\n失败断言为 \`smoke-acceptance-console.mjs:161:10\` 的 \`pageErrors == []\`；真实浏览器 GET 详情端点曾返回 **409 / MANAGED_RUN_INTEGRITY_FAILED**。同 URL 前后有 200 响应，之后 report、triage、证据读取及 reload 均记录为 200。原始上传数据仅含请求顺序，没有逐请求时间戳或完整响应 body；这里不推断根因，也不把该 409 作为预期冲突忽略。完整 stack、响应顺序与限制见 \`diagnostic-summary.json\`。\n\n\`run.json / jobs.json / artifacts.json / run-view.json / workflow-content.json\`、\`commands/\`、\`ci.stdout.log\` 与 \`run-logs.zip\` 均保存 gh/API 原字节。工作流直接读取该精确远端提交，验证 Git blob SHA-1 与全部 15 个 smoke 命令，未使用并行 D1 工作树代替合同。原始日志 ZIP 共 **${logsZip.zipEntries} entries / ${logsZip.fileCount} 文件**，每项已验证 CRC、解包集合、长度和字节。Core 总数在 gh 渲染日志与独立 ZIP step 日志中一致。\n\nGitHub 上传 **${artifacts.total_count} 个 failure artifact**，全部 ZIP 原件、逐项解压文件和清单保存在 \`artifacts/\`；下载 ZIP SHA 与 GitHub metadata digest 一致，所有条目均通过 CRC 与字节回环。截图来自该远端 artifact，不以本机素材补造。\n\n\`monitoring/\` 保留完整 SHA 的 run list、API/jobs、原始工作流读取和每 45 秒监控记录；\`input-files.json\` 逐项关联 ignored 原件与发布副本，所有 SHA 与字节发布前后不变。采集及发布操作均使用 new-only / wx；没有重新运行 CI、测试或浏览器，没有修改产品文件。\n\n强凭据扫描覆盖 **${security.fileCount} 份文本输入**及派生诊断，所列模式匹配 **0**；ZIP 内容按独立解压文本扫描，PNG/ZIP 原二进制单独列明，关键词仅记数量。此结论限于 \`sensitive-scan.json\` 明示的正则范围。\n\n原始字节、行尾和原生日志尾空格均保留；\`.gitattributes\` 仅对原始输出路径关闭 whitespace 检查。\`file-manifest.json\` 排除自身、\`SHA256SUMS.txt\` 与 \`COMPLETED.json\`；SHA 文本包含 manifest，最终完成凭据锚定二者。缺失完成凭据的目录属于不完整尝试，禁止覆盖或续写。\n`);
verifyInputs();
const inventory = walk(OUT), manifest = writeJson('file-manifest.json', { schemaVersion: 1, excludes: ['file-manifest.json', 'SHA256SUMS.txt', 'COMPLETED.json'], fileCount: inventory.length, bytes: inventory.reduce((sum, file) => sum + file.bytes, 0), files: inventory });
const sumFiles = [...inventory, manifest].sort(compare), sums = write('SHA256SUMS.txt', sumFiles.map(file => file.sha256 + '  ' + file.path).join('\n') + '\n');
for (const file of sumFiles) assert.deepEqual(info(join(OUT, file.path)), { bytes: file.bytes, sha256: file.sha256 }); verifyInputs();
const completed = writeJson('COMPLETED.json', { schemaVersion: 1, status: 'complete', ciConclusion: 'failure', runId: RUN, head: HEAD, completedAt: new Date().toISOString(), manifest, sha256sums: sums, originalInputFiles: inputs.length, allOriginalInputsUnchanged: true, copiedOriginalBytesRoundTripPassed: true, originalLogZipCrcPassed: true, extractedLogFiles: logsZip.fileCount, artifactZipCount: artifactZips.length, extractedArtifactFiles: artifactZips.reduce((sum, item) => sum + item.fileCount, 0), strongSensitiveMatchCount: security.strongMatchCount });
const final = walk(OUT); console.log(JSON.stringify({ status: 'archive-complete', ciConclusion: 'failure', directory: slash(relative(ROOT, OUT)), runId: RUN, head: HEAD, fileCount: final.length, bytes: final.reduce((sum, file) => sum + file.bytes, 0), coreSuite, acceptanceSmokeOutcomes: { success: 0, failure: 1, skipped: 14 }, docker: 'skipped', rawLog: summary.rawLog, rawZip: summary.rawZip, artifactZipCount: artifactZips.length, strongSensitiveMatchCount: security.strongMatchCount, manifest, sha256sums: sums, completed }, null, 2));
