import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, 'failure-collection');
const REPO = 'kael-odin/heimdall', RUN = 39005540253, HEAD = 'b42826e4956d491b461bbd00af3d18b2ad702ad5';
const API = `repos/${REPO}/actions/runs/${RUN}`;
mkdirSync(OUT); mkdirSync(join(OUT, 'commands'));
const info = file => { const bytes = readFileSync(file); return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
const write = (name, bytes) => { const file = join(OUT, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: 'wx' }); assert.ok(readFileSync(file).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))); };
const json = name => JSON.parse(readFileSync(join(OUT, name), 'utf8'));
const commands = [];
async function command(tag, executable, args, name) {
  const prefix = 'commands/' + tag;
  const invocation = { executable, args, cwd: process.cwd(), startedAt: new Date().toISOString() };
  write(prefix + '.command.json', JSON.stringify(invocation, null, 2) + '\n');
  const stdout = openSync(join(OUT, prefix + '.stdout.bin'), 'wx'), stderr = openSync(join(OUT, prefix + '.stderr.log'), 'wx');
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', stdout, stderr] });
  const result = await new Promise(resolve => { child.once('error', error => resolve({ code: null, signal: null, error: String(error) })); child.once('close', (code, signal) => resolve({ code, signal, error: null })); });
  closeSync(stdout); closeSync(stderr);
  const record = { tag, ...invocation, finishedAt: new Date().toISOString(), ...result, stdout: { path: prefix + '.stdout.bin', ...info(join(OUT, prefix + '.stdout.bin')) }, stderr: { path: prefix + '.stderr.log', ...info(join(OUT, prefix + '.stderr.log')) } };
  write(prefix + '.exitcode.json', JSON.stringify(record, null, 2) + '\n'); commands.push(record);
  assert.equal(result.code, 0, tag + ' failed; wx evidence retained'); assert.equal(result.signal, null);
  const bytes = readFileSync(join(OUT, prefix + '.stdout.bin')); write(name, bytes); return bytes;
}
const reads = await Promise.allSettled([
  command('01-run', 'gh', ['api', API], 'run.json'),
  command('02-jobs', 'gh', ['api', API + '/jobs?per_page=100'], 'jobs.json'),
  command('03-artifacts', 'gh', ['api', API + '/artifacts?per_page=100'], 'artifacts.json'),
  command('04-view', 'gh', ['run', 'view', String(RUN), '--repo', REPO, '--json', 'attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName'], 'run-view.json'),
  command('05-workflow', 'gh', ['api', `repos/${REPO}/contents/.github/workflows/ci.yml?ref=${HEAD}`], 'workflow-content.json'),
  command('06-log', 'gh', ['run', 'view', String(RUN), '--repo', REPO, '--log'], 'ci.stdout.log'),
  command('07-zip', 'gh', ['api', API + '/logs'], 'run-logs.zip'),
]);
for (const result of reads) assert.equal(result.status, 'fulfilled', result.reason?.message);
const run = json('run.json'), jobs = json('jobs.json'), artifacts = json('artifacts.json');
assert.equal(run.id, RUN); assert.equal(run.head_sha, HEAD); assert.equal(run.head_branch, 'main'); assert.equal(run.event, 'push'); assert.equal(run.run_attempt, 1); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'failure');
assert.equal(jobs.total_count, jobs.jobs.length); assert.equal(artifacts.total_count, artifacts.artifacts.length);
assert.equal(readFileSync(join(OUT, 'run-logs.zip')).toString('ascii', 0, 2), 'PK');
await command('08-extract-logs', 'python', [join(HERE, 'extract-logs.py'), join(OUT, 'run-logs.zip'), join(OUT, 'extracted')], 'zip-inventory.json');
const downloaded = [];
for (const artifact of artifacts.artifacts) {
  assert.equal(artifact.expired, false); assert.equal(artifact.workflow_run.id, RUN); assert.equal(artifact.workflow_run.head_sha, HEAD);
  const base = 'artifacts/' + artifact.id;
  await command('09-artifact-' + artifact.id + '-zip', 'gh', ['api', `repos/${REPO}/actions/artifacts/${artifact.id}/zip`], base + '/artifact.zip');
  const archive = info(join(OUT, base, 'artifact.zip'));
  if (artifact.digest) assert.equal('sha256:' + archive.sha256, artifact.digest);
  await command('10-artifact-' + artifact.id + '-extract', 'python', [join(HERE, 'extract-logs.py'), join(OUT, base, 'artifact.zip'), join(OUT, base, 'extracted')], base + '/zip-inventory.json');
  downloaded.push({ id: artifact.id, name: artifact.name, metadataSizeInBytes: artifact.size_in_bytes, digest: artifact.digest ?? null, archive: { path: base + '/artifact.zip', ...archive }, inventory: { path: base + '/zip-inventory.json', ...info(join(OUT, base, 'zip-inventory.json')) } });
}
write('COLLECTED.json', JSON.stringify({ status: 'collected', runId: RUN, head: HEAD, conclusion: run.conclusion, completedAt: new Date().toISOString(), commands, downloadedArtifacts: downloaded }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'collected', directory: OUT, runId: RUN, head: HEAD, artifacts: downloaded, commands: commands.length }, null, 2));
