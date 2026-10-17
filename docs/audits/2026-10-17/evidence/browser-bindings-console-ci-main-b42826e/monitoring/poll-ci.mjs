import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const REPO = 'kael-odin/heimdall', HEAD = 'b42826e4956d491b461bbd00af3d18b2ad702ad5';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const info = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
async function command(tag, args) {
  const id = tag + '-' + randomUUID(), directory = join(OUT, id);
  mkdirSync(directory);
  const invocation = { executable: 'gh', args, cwd: process.cwd(), startedAt: new Date().toISOString() };
  writeJson(join(directory, 'command.json'), invocation);
  const stdout = openSync(join(directory, 'stdout.bin'), 'wx'), stderr = openSync(join(directory, 'stderr.log'), 'wx');
  const child = spawn('gh', args, { windowsHide: true, stdio: ['ignore', stdout, stderr] });
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: String(error) }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null }));
  });
  closeSync(stdout); closeSync(stderr);
  const record = { ...invocation, finishedAt: new Date().toISOString(), ...result,
    stdout: { path: id + '/stdout.bin', ...info(join(directory, 'stdout.bin')) },
    stderr: { path: id + '/stderr.log', ...info(join(directory, 'stderr.log')) } };
  writeJson(join(directory, 'exitcode.json'), record);
  assert.equal(record.code, 0, 'Remote read failed; wx evidence retained in ' + id);
  assert.equal(record.signal, null);
  return { id, record, value: JSON.parse(readFileSync(join(directory, 'stdout.bin'), 'utf8')) };
}
if (process.argv[2] === '--workflow') {
  const result = await command('workflow-api', ['api', `repos/${REPO}/contents/.github/workflows/ci.yml?ref=${HEAD}`]);
  assert.equal(result.value.encoding, 'base64');
  const bytes = Buffer.from(result.value.content, 'base64');
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), result.value.sha);
  console.log(JSON.stringify({ operation: result.id, blobSha1: result.value.sha, ...info(join(OUT, result.id, 'stdout.bin')) }));
  console.log(bytes.toString('utf8'));
  process.exit(0);
}
async function poll() {
const list = await command('run-list', ['run', 'list', '--repo', REPO, '--commit', HEAD, '--branch', 'main', '--event', 'push', '--limit', '20', '--json', 'attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName']);
assert.ok(list.value.every(run => run.headSha === HEAD && run.headBranch === 'main' && run.event === 'push'));
const exact = list.value.filter(run => run.workflowName === 'CI');
assert.equal(exact.length, 1, 'Require one exact-SHA main push CI run');
const id = exact[0].databaseId;
const results = await Promise.allSettled([
  command('run-api', ['api', `repos/${REPO}/actions/runs/${id}`]),
  command('jobs-api', ['api', `repos/${REPO}/actions/runs/${id}/jobs?per_page=100`]),
]);
for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
const [run, jobs] = results.map(result => result.value);
assert.equal(run.value.id, id); assert.equal(run.value.head_sha, HEAD); assert.equal(run.value.event, 'push'); assert.equal(run.value.head_branch, 'main');
assert.equal(jobs.value.total_count, jobs.value.jobs.length);
const snapshot = { capturedAt: new Date().toISOString(), runId: id, head: HEAD, attempt: run.value.run_attempt,
  status: run.value.status, conclusion: run.value.conclusion, startedAt: run.value.run_started_at, updatedAt: run.value.updated_at,
  url: run.value.html_url, rawOperations: [list.id, run.id, jobs.id], jobs: jobs.value.jobs.map(job => ({ id: job.id, name: job.name, status: job.status,
    conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at,
    activeSteps: job.steps.filter(step => step.status === 'in_progress').map(step => ({ number: step.number, name: step.name })) })) };
const filename = 'snapshot-' + randomUUID() + '.json'; writeJson(join(OUT, filename), snapshot);
return { filename, ...snapshot };
}
if (process.argv[2] === '--watch') {
  let previous = null;
  while (true) {
    const snapshot = await poll();
    const key = JSON.stringify({ status: snapshot.status, conclusion: snapshot.conclusion, jobs: snapshot.jobs });
    if (key !== previous) console.log(JSON.stringify(snapshot, null, 2));
    previous = key;
    if (snapshot.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 45000));
  }
} else console.log(JSON.stringify(await poll(), null, 2));
