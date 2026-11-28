/**
 * agent/gate/formal — 正式裁判
 *
 * 只有它有权对外宣布「通过」。在本地完成确定性的完整基线净化与多视口六维核验：
 *   1. 准备正式基线（回环只读服务体检，不健康就先做清洗副本）；
 *   2. 对全部配置视口（默认 375 / 768 / 1440）执行整页视觉与六维评估；
 *   3. 校验项目指纹在测量前后未发生变化；
 *   4. 合成 `heimdall.gate/1`：基线健康且每一维都通过，才判 passed。
 */
import { join, resolve } from 'node:path';
import { sha256 } from '../ids.mjs';
import { agentDir } from '../workspace.mjs';
import { projectFingerprint } from '../deliver/project.mjs';
import { launchBrowser } from '../evidence/capture.mjs';
import { fastCompare, readProjectConfig } from '../evidence/compare.mjs';
import { prepareBaseline, copySanitizedBaseline } from './baseline.mjs';
import { composeGate } from './report.mjs';
import { startFormalAttempt, writeFormalAttempt } from './attempt.mjs';

const VIEWPORTS = Object.freeze([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]);

export const configuredViewports = (cfg) => {
  const raw = cfg.viewports ?? VIEWPORTS.map(v => v.width);
  if (!Array.isArray(raw)) throw new Error('正式门禁的 viewports 必须是数组');
  const widths = raw.map(Number);
  if (!widths.length) throw new Error('正式门禁没有可用视口；viewports 只能取 375 / 768 / 1440');
  if (widths.some(width => !VIEWPORTS.some(v => v.width === width))) throw new Error('正式门禁的 viewports 只能取 375 / 768 / 1440');
  if (new Set(widths).size !== widths.length) throw new Error('正式门禁的 viewports 不能重复');
  return widths.map(width => VIEWPORTS.find(v => v.width === width));
};

export function baselineDimension(base, normalized) {
  if (!base) return { id: 'baseline', status: 'not_measured', detail: '正式基线未完成体检' };
  if (base.status === 'blocked') {
    return {
      id: 'baseline',
      status: 'not_measured',
      value: { status: 'blocked', reason: base.reason ?? null },
      detail: `正式基线阻塞：${base.reason ?? '镜像与清洗副本均未通过体检'}`,
    };
  }
  const anchorCount = normalized?.changes?.filter(c => c.kind === 'anchor_normalized').length ?? 0;
  return {
    id: 'baseline',
    status: 'pass',
    value: { status: base.status, normalizedLinks: anchorCount },
    detail: `正式基线 ${base.status}（归一化 ${anchorCount} 个站内链接）`,
  };
}

/**
 * 跑一次正式门禁。
 * @returns {Promise<{status:'passed'|'failed'|'incomplete', reportPath, fast, gate, evidence}>}
 */
export async function formalGate({ siteId, page, projectDir, level = 'silver', timeoutMs = 8 * 60_000, browser = null, onProgress = () => {} } = {}) {
  const attempt = startFormalAttempt({ siteId, page, projectDir, level });
  const own = !browser;
  const deadline = Date.now() + timeoutMs;
  try {
    const snapshot = { schema: 'heimdall.project-snapshot/1', sha256: projectFingerprint(projectDir) };
    const cfg = readProjectConfig(projectDir);
    const viewports = configuredViewports(cfg);
    const widths = viewports.map(viewport => viewport.width);
    if (Date.now() >= deadline) {
      const gate = { ...attempt.gate, generatedAt: new Date().toISOString(), reason: 'formal_gate_timeout', projectSnapshot: snapshot,
        dimensions: [], status: 'incomplete', note: '正式门禁在完成全部视口测量前超时，不当作通过。' };
      const body = writeFormalAttempt(attempt.file, gate);
      return { status: 'incomplete', reason: 'formal_gate_timeout', gate, reportPath: attempt.file, evidence: { sha256: sha256(body), bytes: Buffer.byteLength(body) } };
    }
    browser ??= await launchBrowser();
    onProgress({ stage: 'baseline', message: '准备正式基线' });
    const prepDir = join(agentDir(siteId), 'gate', page, `baseline-prep-${sha256(attempt.file).slice(0, 16)}`);
    const base = await prepareBaseline(browser, { siteId, page, viewport: widths.at(-1), stateDir: prepDir });
    const formalDir = join(agentDir(siteId), 'gate', page, `baseline-formal-${sha256(attempt.file).slice(0, 16)}`);
    const normalized = copySanitizedBaseline(base.dir, formalDir, { normalizeLinks: true });
    const baseDim = baselineDimension(base, normalized);
    onProgress({ stage: 'baseline', message: baseDim.detail });

    if (Date.now() >= deadline) {
      const gate = { ...attempt.gate, generatedAt: new Date().toISOString(), reason: 'formal_gate_timeout', projectSnapshot: snapshot,
        dimensions: [baseDim], status: 'incomplete', note: '正式门禁在完成全部视口测量前超时，不当作通过。' };
      const body = writeFormalAttempt(attempt.file, gate);
      return { status: 'incomplete', reason: 'formal_gate_timeout', gate, reportPath: attempt.file, evidence: { sha256: sha256(body), bytes: Buffer.byteLength(body) } };
    }

    onProgress({ stage: 'evaluate', message: '评估器：整页视觉与六维' });
    const fastR = await fastCompare({ siteId, page, candidate: { dir: projectDir }, viewports: widths }, { browser, record: false });
    const fast = composeGate(fastR.packet, { level, thresholds: cfg.gate?.thresholds ?? null });

    const dims = [...fast.dimensions, baseDim];
    const anyFail = dims.some(d => d.status === 'fail');
    const anyUnknown = dims.some(d => d.status === 'not_measured');
    const changed = projectFingerprint(projectDir) !== snapshot.sha256;
    const status = changed ? 'incomplete' : anyUnknown ? 'incomplete' : anyFail ? 'failed' : 'passed';

    const gate = {
      ...attempt.gate, level, projectDir: resolve(projectDir), generatedAt: new Date().toISOString(), projectSnapshot: snapshot,
      dimensions: dims, status, ...(changed ? { reason: 'project_changed_during_gate' } : { reason: null }),
      thresholds: fast.thresholds,
      note: status === 'passed'
        ? '正式裁判通过：基线与评估器每一维都过了。'
        : status === 'incomplete'
          ? '有维度没测到或项目在测量期间变化，不当作通过。'
          : '至少一维没过；按 dimensions 与修复包定位。',
    };
    const body = writeFormalAttempt(attempt.file, gate);
    return { status, gate, fast, reportPath: attempt.file, evidence: { sha256: sha256(body), bytes: Buffer.byteLength(body) } };
  } catch (error) {
    try { writeFormalAttempt(attempt.file, { ...attempt.gate, generatedAt: new Date().toISOString(), reason: 'formal_gate_error' }); } catch {}
    throw error;
  } finally {
    if (own) await browser?.close().catch(() => {});
  }
}
