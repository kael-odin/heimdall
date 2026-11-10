import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../../fsutil.mjs';
import { projectFingerprint } from '../deliver/project.mjs';
import { sha256 } from '../ids.mjs';
import { agentDir, assertPage } from '../workspace.mjs';

const projectKey = (dir) => {
  const path = resolve(dir);
  return process.platform === 'win32' ? path.toLowerCase() : path;
};
const attemptPrefix = (dir) => `formal-attempt-${sha256(projectKey(dir))}-`;

export function startFormalAttempt({ siteId, page, projectDir, level }) {
  const dir = join(agentDir(siteId), 'gate', assertPage(page));
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const gate = { schema: 'heimdall.gate/1', judge: 'formal', siteId, page, projectDir: resolve(projectDir), level,
    startedAt: new Date(started).toISOString(), status: 'incomplete', reason: 'formal_gate_running', dimensions: [] };
  for (let sequence = 0; sequence < 1000000; sequence++) {
    const file = join(dir, `${attemptPrefix(projectDir)}${started}-${String(sequence).padStart(6, '0')}.json`);
    let fd;
    try { fd = openSync(file, 'wx'); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { writeFileSync(fd, JSON.stringify(gate, null, 1) + '\n'); } finally { closeSync(fd); }
    return { file, gate };
  }
  throw new Error('无法创建正式门禁记录');
}

export function writeFormalAttempt(file, gate) {
  const body = JSON.stringify(gate, null, 1) + '\n';
  writeFileAtomic(file, body);
  return body;
}

/** Never promote an unbound, damaged, interrupted or stale attempt to passed. */
export function latestFormalGate(siteId, page, projectDir) {
  const dir = join(agentDir(siteId), 'gate', assertPage(page));
  const incomplete = (path, reason) => ({ status: 'incomplete', reason, path, dimensions: [] });
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return null; return incomplete(dir, 'formal_gate_unreadable'); }
  const prefix = attemptPrefix(projectDir);
  const attempts = names.filter(n => n.startsWith(prefix) && /^\d{13}-\d{6}\.json$/.test(n.slice(prefix.length))).sort().reverse();
  if (attempts.length) {
    const path = join(dir, attempts[0]);
    let gate;
    try { gate = JSON.parse(readFileSync(path, 'utf8')); } catch { return incomplete(path, 'formal_gate_unreadable'); }
    if (gate?.judge !== 'formal' || gate.siteId !== siteId || gate.page !== page || !gate.projectDir
        || projectKey(gate.projectDir) !== projectKey(projectDir) || !['passed', 'failed', 'incomplete'].includes(gate.status)) {
      return incomplete(path, 'formal_gate_unreadable');
    }
    if (gate.status === 'passed') {
      try {
        if (gate.projectSnapshot?.schema !== 'heimdall.project-snapshot/1'
            || gate.projectSnapshot.sha256 !== projectFingerprint(projectDir)) return incomplete(path, 'project_changed_or_unbound');
      } catch { return incomplete(path, 'project_unreadable'); }
    }
    return { ...gate, path, runId: gate.acceptance?.runId ?? null };
  }
  // Legacy reports were never bound to project contents; they are history, not a current verdict.
  const legacy = names.filter(n => /^formal-(?!attempt-).*\.json$/.test(n));
  try {
    legacy.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    for (const name of legacy) {
      const path = join(dir, name);
      let gate;
      try { gate = JSON.parse(readFileSync(path, 'utf8')); } catch { return incomplete(path, 'formal_gate_unreadable'); }
      if (gate.projectDir && projectKey(gate.projectDir) === projectKey(projectDir)) return incomplete(path, 'project_changed_or_unbound');
    }
  } catch { return incomplete(dir, 'formal_gate_unreadable'); }
  return null;
}
