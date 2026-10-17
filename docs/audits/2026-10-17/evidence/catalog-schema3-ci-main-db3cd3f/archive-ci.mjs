import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact remote run only. Every byte written below uses a new, exclusively created file.
const OUT = dirname(fileURLToPath(import.meta.url));
const REPO = 'kael-odin/heimdall', RUN = 38996824641, HEAD = 'db3cd3fd9efe7e46ae079cab8d529e64a14b842b';
const API = `repos/${REPO}/actions/runs/${RUN}`;
const startedAt = new Date().toISOString(), commands = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = path => path.split(sep).join('/');
const bytesInfo = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const parse = path => JSON.parse(readFileSync(path, 'utf8'));
function write(path, bytes) {
  const absolute = join(OUT, path); mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes, { flag: 'wx' });
  assert.ok(readFileSync(absolute).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
  return { path, ...bytesInfo(absolute) };
}
const writeJson = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
function allFiles(base = OUT) {
  const result = [];
  function visit(path) {
    const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else { assert.equal(stat.isFile(), true); result.push({ path: slash(relative(base, path)), ...bytesInfo(path) }); }
  }
  visit(base); return result;
}
async function command(tag, executable, args, outputPath, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const prefix = `commands/${tag}-attempt-${attempt}`, stdoutPath = prefix + '.stdout.bin', stderrPath = prefix + '.stderr.log';
    mkdirSync(join(OUT, 'commands'), { recursive: true });
    const stdout = openSync(join(OUT, stdoutPath), 'wx'), stderr = openSync(join(OUT, stderrPath), 'wx');
    const began = new Date().toISOString(), timer = Date.now();
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', stdout, stderr] });
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ code: null, signal: null, error: String(error) }));
      child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
    });
    closeSync(stdout); closeSync(stderr);
    const record = { tag, attempt, executable, args, startedAt: began, endedAt: new Date().toISOString(), elapsedMs: Date.now() - timer,
      ...result, stdout: { path: stdoutPath, ...bytesInfo(join(OUT, stdoutPath)) }, stderr: { path: stderrPath, ...bytesInfo(join(OUT, stderrPath)) } };
    writeJson(prefix + '.exitcode.json', record); commands.push(record);
    console.log(JSON.stringify({ event: 'command-completed', tag, attempt, code: result.code, stdoutBytes: record.stdout.bytes }));
    if (result.code === 0) {
      const bytes = readFileSync(join(OUT, stdoutPath)); write(outputPath, bytes); return bytes;
    }
  }
  throw new Error(`All attempts failed: ${tag}; original stderr and exit records retained.`);
}

assert.equal(existsSync(join(OUT, 'run.json')), false, 'Existing archive refused; do not overwrite or silently resume');
const run = JSON.parse(await command('01-run', 'gh', ['api', API], 'run.json'));
assert.equal(run.id, RUN); assert.equal(run.head_sha, HEAD); assert.equal(run.head_branch, 'main');
assert.equal(run.event, 'push'); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
assert.equal(run.run_attempt, 1);
const independent = await Promise.allSettled([
  command('02-jobs', 'gh', ['api', API + '/jobs?per_page=100'], 'jobs.json'),
  command('03-artifacts', 'gh', ['api', API + '/artifacts?per_page=100'], 'artifacts.json'),
  command('04-view', 'gh', ['run', 'view', String(RUN), '--repo', REPO, '--json',
    'attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName'], 'run-view.json'),
  command('05-workflow', 'gh', ['api', `repos/${REPO}/contents/.github/workflows/ci.yml?ref=${HEAD}`], 'workflow-content.json'),
]);
for (const item of independent) assert.equal(item.status, 'fulfilled', item.reason?.message);
const jobs = parse(join(OUT, 'jobs.json')), artifacts = parse(join(OUT, 'artifacts.json')), view = parse(join(OUT, 'run-view.json'));
assert.equal(jobs.total_count, jobs.jobs.length); assert.equal(jobs.jobs.length, 3);
assert.equal(artifacts.total_count, artifacts.artifacts.length);
assert.equal(view.databaseId, RUN); assert.equal(view.headSha, HEAD); assert.equal(view.attempt, run.run_attempt);
assert.equal(view.status, 'completed'); assert.equal(view.conclusion, 'success');
assert.ok(jobs.jobs.every(job => job.run_id === RUN && job.head_sha === HEAD && job.status === 'completed' && job.conclusion === 'success'));
const workflowMetadata = parse(join(OUT, 'workflow-content.json'));
assert.equal(workflowMetadata.encoding, 'base64');
const workflowBytes = Buffer.from(workflowMetadata.content, 'base64'); write('workflow-at-head.yml', workflowBytes);
assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${workflowBytes.length}\0`), workflowBytes])).digest('hex'), workflowMetadata.sha);
const downloads = await Promise.allSettled([
  command('06-log', 'gh', ['run', 'view', String(RUN), '--repo', REPO, '--log'], 'ci.stdout.log'),
  command('07-zip', 'gh', ['api', API + '/logs'], 'run-logs.zip'),
]);
for (const item of downloads) assert.equal(item.status, 'fulfilled', item.reason?.message);
assert.equal(readFileSync(join(OUT, 'run-logs.zip')).toString('ascii', 0, 2), 'PK');
await command('08-extract', 'python', [join(OUT, 'extract-logs.py'), join(OUT, 'run-logs.zip'), join(OUT, 'extracted')], 'zip-inventory.json', 1);
const zip = parse(join(OUT, 'zip-inventory.json'));
assert.ok(zip.crcTestPassed && zip.allExtractedBytesEqualZipEntries);
assert.equal(zip.fileCount, zip.files.length);
assert.deepEqual(allFiles(join(OUT, 'extracted')), zip.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const rows = readFileSync(join(OUT, 'ci.stdout.log'), 'utf8').split(/\r?\n/).flatMap(line => {
  const a = line.indexOf('\t'), b = line.indexOf('\t', a + 1);
  return a < 0 || b < 0 ? [] : [{ job: line.slice(0, a), step: line.slice(a + 1, b),
    text: line.slice(b + 1).replace(/^\d{4}-\d{2}-\d{2}T\S+Z ?/, '') }];
});
const core = jobs.jobs.find(job => job.name === 'core (lint + test)'); assert.ok(core);
const stepRows = name => rows.filter(row => row.job === core.name && row.step === name);
const stepText = name => stepRows(name).map(row => row.text).join('\n');
function totals(text) {
  const counts = {};
  for (const match of text.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)\s*$/gm)) counts[match[1]] = Number(match[2]);
  assert.equal(Object.keys(counts).length, 8, 'Incomplete TAP summary');
  assert.equal(counts.fail, 0); assert.equal(counts.cancelled, 0); assert.equal(counts.todo, 0);
  assert.equal(counts.tests, counts.pass + counts.skipped); return counts;
}
function summaryOf(text) {
  const lines = text.split('\n'), result = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === '{') {
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim() === '}') {
      try { const value = JSON.parse(lines.slice(i, j + 1).join('\n')); if (value.status === 'passed' || value.passed === true) { result.push(value); i = j; break; } } catch {}
    }
  }
  assert.equal(result.length, 1, 'Expected one successful stdout summary'); return result[0];
}
const smokePrefixes = ['Acceptance console (', 'Spec contract console (', 'Acceptance comparison console (',
  'Acceptance project catalog (', 'Acceptance catalog migration (', 'Spec baseline review (',
  'Managed Spec preparation (', 'Managed Spec result reading (', 'Owned acceptance recovery (',
  'Managed Spec execution (', 'Managed execution UI (', 'Browser candidate source (', 'Browser private source reader ('];
const smokeSteps = smokePrefixes.map(prefix => {
  const matches = core.steps.filter(step => step.name.startsWith(prefix)); assert.equal(matches.length, 1, prefix);
  assert.equal(matches[0].conclusion, 'success'); return matches[0];
});
assert.equal(smokeSteps.length, 13); assert.equal(core.steps.some(step => step.name.startsWith('Browser source bindings (')), false);
const compactStep = ({ name, status, conclusion, number, started_at, completed_at }) => ({ name, number, status, conclusion, startedAt: started_at, completedAt: completed_at });
const coreSuite = totals(stepText('Run pnpm test')), coreSkippedTests = stepRows('Run pnpm test').filter(row => /# SKIP(?:\s|$)/i.test(row.text)).map(row => row.text);
assert.equal(coreSkippedTests.length, coreSuite.skipped);
const dockerName = 'Docker offline delivery (SSR + SPA + data SPA + adapter)', dockerStep = core.steps.find(step => step.name === dockerName);
assert.equal(dockerStep.conclusion, 'success'); const dockerSuite = totals(stepText(dockerName));
assert.equal(dockerSuite.tests, 2); assert.equal(dockerSuite.pass, 2); assert.equal(dockerSuite.skipped, 0);
const extractedCounts = {};
for (const [name, counts] of [['Run pnpm test', coreSuite], [dockerName, dockerSuite]]) {
  const files = zip.files.filter(file => file.path.startsWith(core.name + '/') && file.path.endsWith('_' + name.replaceAll('/', '_') + '.txt'));
  assert.equal(files.length, 1, 'Unique extracted step log missing: ' + name);
  const raw = readFileSync(join(OUT, 'extracted', files[0].path), 'utf8').replace(/^\d{4}-\d{2}-\d{2}T\S+Z ?/gm, '');
  assert.deepEqual(totals(raw), counts, 'gh rendered log and ZIP step log totals differ');
  extractedCounts[name] = files[0].path;
}
const smokeSummaries = smokeSteps.map(step => ({ step: compactStep(step), summary: summaryOf(stepText(step.name)) }));
for (const item of smokeSummaries) {
  const summary = item.summary;
  if (summary.checks && !Object.hasOwn(summary.checks, 'total')) assert.ok(Object.values(summary.checks).every(value => value === true));
  else if (summary.checks) assert.equal(summary.checks.total, summary.checks.passed);
}
const strongPatterns = [
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ['openai-style-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key-header', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['long-bearer-credential', /\bBearer\s+[A-Za-z0-9._=-]{24,}/g],
];
const scanned = [], hits = [], keywords = /api[_-]?key|authorization|bearer|password|set-cookie|secret/gi;
for (const file of zip.files) {
  const text = readFileSync(join(OUT, 'extracted', file.path), 'utf8'), keywordCount = [...text.matchAll(keywords)].length;
  scanned.push({ path: file.path, bytes: file.bytes, sha256: file.sha256, keywordOccurrences: keywordCount });
  for (const [pattern, regex] of strongPatterns) {
    regex.lastIndex = 0; const matches = [...text.matchAll(regex)];
    if (matches.length) hits.push({ path: file.path, pattern, count: matches.length, lines: matches.map(match => text.slice(0, match.index).split('\n').length) });
  }
}
const security = { schemaVersion: 1, scannedAt: new Date().toISOString(), scope: 'Every independently extracted raw log; no secret values emitted in this report.',
  strongPatterns: strongPatterns.map(([name, regex]) => ({ name, expression: regex.source })),
  strongMatchCount: hits.reduce((sum, hit) => sum + hit.count, 0), hits, fileCount: scanned.length, files: scanned,
  keywordPolicy: 'Keyword occurrences are retained as counts, not treated as credentials. Zero strong-pattern matches is limited to the expressions recorded here.' };
writeJson('sensitive-scan.json', security); assert.equal(security.strongMatchCount, 0, 'Review strong-pattern matches before completing this archive');
const summary = {
  schemaVersion: 1, runId: RUN, head: HEAD, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion,
  headBranch: run.head_branch, event: run.event, runUrl: run.html_url, createdAt: run.created_at, startedAt: run.run_started_at,
  updatedAt: run.updated_at, archivedAt: new Date().toISOString(),
  jobs: jobs.jobs.map(({ id, name, status, conclusion, started_at, completed_at }) => ({ id, name, status, conclusion, startedAt: started_at, completedAt: completed_at })),
  coreSuite, coreSkippedTests, acceptanceSmokeCount: smokeSteps.length, acceptanceSmokeSteps: smokeSteps.map(compactStep),
  smokeSummaries, docker: { step: compactStep(dockerStep), tests: dockerSuite }, artifactsTotalCount: artifacts.total_count,
  rawLog: { path: 'ci.stdout.log', ...bytesInfo(join(OUT, 'ci.stdout.log')) },
  rawZip: { path: 'run-logs.zip', ...bytesInfo(join(OUT, 'run-logs.zip')), entries: zip.zipEntries, extractedFiles: zip.fileCount, extractedBytes: zip.bytes },
  strongSensitiveMatches: security.strongMatchCount,
  countingPolicy: 'Only the remote full Core suite is counted once. The 13 acceptance smokes and independent two-test Docker step are separate. No local or prior-commit result substitutes for this run.',
  boundary: artifacts.total_count === 0 ? 'This run uploaded no Actions artifacts; exact logs and ZIP entries are preserved, but fresh remote screenshot/run trees are unavailable and are not reconstructed from local materials.'
    : 'Artifact metadata retained; artifact binary contents are not claimed as included in this log archive.',
};
writeJson('summary.json', summary);
const verification = { schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), runId: RUN, head: HEAD,
  checks: { exactRunAndHead: true, completedSuccess: true, threeSuccessfulJobs: true, jobsPaginationComplete: true, artifactsPaginationComplete: true,
    remoteWorkflowBlobVerified: true, originalZipCrcPassed: true, originalZipEveryExtractedByteVerified: true,
    coreCountsMatchGhAndZip: true, independentDockerCountsMatchGhAndZip: true, thirteenSmokesSuccessful: true,
    noPhaseBBindingSmokeInPhaseA: true, strongSensitivePatternScanPassed: true },
  extractedCountSources: extractedCounts, commandAttempts: commands,
  newlinePolicy: 'Exact output bytes; root .gitattributes unsets text conversion. README and attributes use LF.',
};
writeJson('verification.json', verification);
write('README.md', `# Catalog schema3 精确提交 CI\n\nGitHub run [${RUN}](${run.html_url})，attempt ${run.run_attempt}，head \`${HEAD}\`，分支 \`main\`，事件 \`push\`，结果 **completed / success**。三个 job 均成功，时间线见 \`summary.json\` 与原始 \`jobs.json\`。\n\n- Linux Core：**${coreSuite.tests} total / ${coreSuite.pass} pass / ${coreSuite.fail} fail / ${coreSuite.skipped} skip**，耗时 ${coreSuite.duration_ms} ms。\n- Acceptance smoke：**13/13** 成功；各原始结构化摘要保存在 \`summary.json\`，不包含后续片 B 的 binding smoke。\n- Docker 独立步骤：**${dockerSuite.tests} total / ${dockerSuite.pass} pass / ${dockerSuite.fail} fail / ${dockerSuite.skipped} skip**。\n- Actions artifacts：**${artifacts.total_count}**。\n\nCore 只计远端这一次完整测试；smoke 与 Docker 单独报告，不加入 Core。未使用本机测试或其他提交 CI 替代该 run。跳过项目的原始 TAP 行见 \`summary.json\`。\n\n\`run.json\`、\`jobs.json\`、\`artifacts.json\`、\`run-view.json\` 和 \`workflow-content.json\` 是精确 gh/API 输出；\`workflow-at-head.yml\` 直接由 GitHub 在该 commit 返回的内容解码并验证 Git blob SHA-1。\`ci.stdout.log\` 为完整 gh 渲染日志；\`run-logs.zip\` 为 GitHub 原始 ZIP，包含 ${zip.zipEntries} entries，所有 ${zip.fileCount} 原日志已解压到 \`extracted/\` 并验证 CRC 和每个文件的字节。Linux Core 与 Docker 数量在 gh 输出及独立 ZIP step log 两边一致。\n\n${summary.boundary}\n\n\`commands/\` 保存每条命令（含参数、起止时间、退出码、stdout/stderr 原字节）的全部尝试；未读取或输出认证凭据。\`sensitive-scan.json\` 对全部 ${scanned.length} 份解压日志独立扫描，所列强凭据模式匹配 **0**；关键词出现次数另记，零匹配仅适用于记录的正则范围。\n\n目录只使用 new-only 写入；\`.gitattributes\` 阻止原始字节行尾转换。\`file-manifest.json\`、\`SHA256SUMS.txt\` 与最后写入的 \`COMPLETED.json\` 组成完成校验链，缺失完成凭据代表不完整尝试。清单明确排除其自身、SHA 文本和完成凭据，以避免循环摘要。\n`);
const inventory = allFiles();
const manifest = writeJson('file-manifest.json', { schemaVersion: 1, excludes: ['file-manifest.json', 'SHA256SUMS.txt', 'COMPLETED.json'], fileCount: inventory.length,
  bytes: inventory.reduce((sum, file) => sum + file.bytes, 0), files: inventory });
const sumFiles = [...inventory, manifest].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sums = write('SHA256SUMS.txt', sumFiles.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n');
for (const file of sumFiles) assert.deepEqual(bytesInfo(join(OUT, file.path)), { bytes: file.bytes, sha256: file.sha256 });
writeJson('COMPLETED.json', { schemaVersion: 1, status: 'complete', runId: RUN, head: HEAD, completedAt: new Date().toISOString(), manifest, sha256sums: sums,
  originalZipCrcPassed: true, extractedLogFiles: zip.fileCount, verifiedCommandAttempts: commands.length,
  strongSensitiveMatchCount: security.strongMatchCount });
const final = allFiles();
console.log(JSON.stringify({ status: 'complete', directory: OUT, runId: RUN, head: HEAD, fileCount: final.length,
  bytes: final.reduce((sum, file) => sum + file.bytes, 0), coreSuite, dockerSuite, acceptanceSmokeCount: smokeSteps.length,
  artifactsTotalCount: artifacts.total_count, rawLog: summary.rawLog, rawZip: summary.rawZip, manifest, sha256sums: sums }, null, 2));
