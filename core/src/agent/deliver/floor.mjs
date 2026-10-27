/**
 * agent/deliver/floor — Floor=Mirror 交付（E7-10，PRD 05 §5.5）
 *
 * 一句话：**没过门禁也交出完整的东西**。镜像永远是真值，也是兜底；重建项目按状态标注为成品或草稿。
 *
 *   passed                 重建项目（成品）+ 门禁报告 + 镜像附件
 *   passed_with_residuals  同上 + 残差清单
 *   failed_with_residuals
 *   budget_exhausted       镜像 + 报告 + 残差清单；重建项目标为「未通过的草稿」
 *   cancelled
 *
 * 交付目录（默认 workspace/<siteId>/agent/deliver/<page>-<时间>）：
 *   REPORT.md        人话报告：拿到什么、为什么、缺什么、怎么打开
 *   delivery.json    机器可读：状态、原因、每一项的路径与哈希
 *   residuals.json   残差清单（每个分段的判定、最好一次、下一步）
 *   MANIFEST.jsonl   包的每个文件一行 {path,bytes,sha256}
 *   mirror/          冻结镜像（自包含，双击 index.html 即可看）
 *   project/         重建项目源码（不含 node_modules / dist / .git）；非 passed 时带 DRAFT.md
 */
import { cpSync, existsSync, mkdirSync, readdirSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isSecretFile } from '../../paths.mjs';
import { writeFileAtomic } from '../../fsutil.mjs';
import { sha256 } from '../ids.mjs';
import { agentDir, requireMirror } from '../workspace.mjs';
import { readProjectConfig } from '../evidence/compare.mjs';
import { decisionsFor, readLedger } from '../loops/ledger.mjs';

/** 不进交付包的项目目录：依赖、构建产物、版本库、参考截图与逐次运行的原始证据 */
const PROJECT_SKIP = new Set(['node_modules', '.git', 'dist', '.vite', 'coverage', '.turbo']);
const PROJECT_SKIP_PATHS = new Set(['.heimdall/ref', '.heimdall/runs']);

const relOf = (root, file) => file.slice(root.length + 1).replace(/\\/g, '/');

function copyTree(src, dest, { skipDir = () => false, skipRel = () => false } = {}) {
  const root = resolve(src);
  const copied = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relOf(root, p);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;           // 交付包不做符号链接：换台机器就断
      if (st.isDirectory()) { if (!skipDir(name, rel)) walk(p); continue; }
      if (!st.isFile() || isSecretFile(p) || skipRel(rel)) continue;
      const out = join(dest, rel);
      mkdirSync(resolve(out, '..'), { recursive: true });
      writeFileSync(out, readFileSync(p));
      copied.push({ path: rel, bytes: st.size });
    }
  };
  walk(root);
  return copied;
}

/** 每个文件的 SHA-256：交付包自己能证明自己没被改过 */
export function manifestOf(rootDir, { skipDir = new Set(['node_modules', '.git']) } = {}) {
  const root = resolve(rootDir);
  const rows = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skipDir.has(name)) continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p); continue; }
      if (!st.isFile()) continue;
      const bytes = readFileSync(p);
      rows.push({ path: relOf(root, p), bytes: bytes.length, sha256: sha256(bytes) });
    }
  };
  walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 终态：只有正式裁判能给 passed；没有正式结果时按 Floor=Mirror 交付，并写明原因。
 * 终态枚举固定（PRD 03 §5.4），原因另放一个字段，不新造状态。
 */
export function deliveryState({ decisions = [], formal = null, cancelled = false, budgetExhausted = false } = {}) {
  if (cancelled || decisions.some(d => d.reason === 'cancelled')) return { state: 'cancelled', reason: 'cancelled' };
  if (budgetExhausted || decisions.some(d => d.reason === 'budget_exhausted')) return { state: 'budget_exhausted', reason: 'budget_exhausted' };
  const residuals = decisions.filter(d => d.action === 'accept-residual');
  if (formal?.status === 'passed') return { state: residuals.length ? 'passed_with_residuals' : 'passed', reason: 'formal_gate' };
  if (!decisions.length) return { state: 'failed_with_residuals', reason: 'no_iterations' };
  return { state: 'failed_with_residuals', reason: formal ? 'formal_gate_failed' : 'formal_gate_missing' };
}

/** 最近一次正式裁判的结果（`gate formal` 写在 agent/gate/<page>/formal-*.json）；没有就是 null */
export function latestFormalGate(siteId, page, projectDir = null) {
  const dir = join(agentDir(siteId), 'gate', page);
  const want = projectDir ? resolve(projectDir).toLowerCase() : null;
  try {
    const files = readdirSync(dir).filter(n => /^formal-.*\.json$/.test(n))
      .map(n => ({ n, mtime: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);   // 按写入时间，不是文件名
    for (const { n } of files) {
      const path = join(dir, n);
      const gate = JSON.parse(readFileSync(path, 'utf8'));
      // 同一站点同一页可能有多个重建工作区：只认这份报告自己的项目目录。
      // 早期报告没有 projectDir 字段，那就不认（宁可说没跑过，也不张冠李戴）。
      if (want && (!gate.projectDir || resolve(gate.projectDir).toLowerCase() !== want)) continue;
      return { status: gate.status === 'passed' ? 'passed' : 'failed', level: gate.level ?? null, path, runId: gate.acceptance?.runId ?? null };
    }
    return null;
  } catch { return null; }
}

const REASON_TEXT = {
  cancelled: '代理或用户中止了这次重建',
  budget_exhausted: '预算（金额 / 时长 / 工具调用）用尽',
  no_iterations: '一次对比都没跑过，没有可交付的重建',
  formal_gate_failed: '正式裁判判定未通过',
  formal_gate_missing: '还没跑正式裁判（E7-07），按 Floor=Mirror 交付',
  formal_gate: '正式裁判判定通过',
  anticheat: '候选页命中了反作弊检查（把参考截图当内容），不按通过交付',
  made_by_cli: '调用方指定了终态',
};

/** 残差清单：每个分段「停在哪、为什么停、最好的一次是哪次」 */
export function residualsOf(decisions) {
  return decisions.map(d => {
    const pixel = d.best ? (d.best.minPixel ?? d.best.score) : null;
    return {
      sectionId: d.key,
      action: d.action,
      reason: d.reason,
      ...(d.ladderStep ? { ladderStep: d.ladderStep } : {}),
      iterations: d.entries,
      best: d.best ? { runId: d.best.runId, verdict: d.best.verdict, ...(typeof pixel === 'number' ? { minPixel: pixel } : {}) } : null,
      last: d.last ? { runId: d.last.runId, verdict: d.last.verdict, ...(d.last.reached ? { reached: d.last.reached } : {}) } : null,
      // 只有「接受残差」才算被接受的偏差；其余是还开着的缺口
      accepted: d.action === 'accept-residual',
    };
  });
}

function renderReport({ siteId, page, state, reason, residuals, mirror, project, formal, ledgerCount }) {
  const passed = state === 'passed' || state === 'passed_with_residuals';
  const lines = [
    `# Heimdall 交付 · ${siteId}/${page}`,
    '',
    `**状态：\`${state}\`** —— ${REASON_TEXT[reason] ?? reason}`,
    '',
    passed
      ? '门禁通过：重建项目是成品，镜像作为附件一起给你（想对照随时能开）。'
      : '按 **Floor=Mirror**：交付的是**冻结镜像**——它就是今天的真值，不会比原来的更差。重建项目作为**未通过的草稿**附上，能看到做到哪一步。',
    '',
    '## 包里有什么',
    '',
    '| 路径 | 内容 |',
    '| --- | --- |',
    `| \`mirror/\` | 冻结镜像（${mirror.files} 个文件）。直接双击 \`mirror/index.html\` 就能看，不需要服务器 |`,
    `| \`project/\` | 重建项目源码（${project.files} 个文件，不含依赖与构建产物）${passed ? '' : '，带 \`DRAFT.md\` 标明未通过'} |`,
    '| `REPORT.md` | 本文件 |',
    '| `residuals.json` | 残差清单：每个分段停在哪、为什么停 |',
    '| `delivery.json` | 机器可读的交付清单与哈希 |',
    '| `MANIFEST.jsonl` | 每个文件的 SHA-256，可自行校验 |',
    '',
    '## 怎么用',
    '',
    '镜像：双击 `mirror/index.html`（多视口克隆会在入口自动跳到对应变体）。',
    '',
    passed
      ? '项目：`cd project && pnpm install --ignore-scripts && pnpm dev`。'
      : '草稿：`cd project && pnpm install --ignore-scripts && pnpm dev` 能起，但**不要直接上线**——先看下面的残差。',
    '',
    '## 残差清单',
    '',
  ];
  if (!residuals.length) lines.push('没有残差。');
  else {
    lines.push('| 分段 | 判定 | 原因 | 最好一次 | 迭代 |', '| --- | --- | --- | --- | --- |');
    for (const r of residuals) {
      const best = r.best ? `${r.best.verdict} · ${(r.best.minPixel * 100).toFixed(2)}%` : '—';
      lines.push(`| ${r.sectionId} | ${r.action} | ${r.reason}${r.ladderStep ? `（${r.ladderStep}）` : ''} | ${best} | ${r.iterations} |`);
    }
  }
  lines.push('',
    '## 证据',
    '',
    `- 对比记录：${ledgerCount} 次迭代`,
    `- 正式裁判：${formal ? formal.status : '未跑（E7-07 上线前，快速裁判不宣布通过）'}`,
    '- 交付包自证：`MANIFEST.jsonl` 里每个文件都有 SHA-256；`delivery.json.evidence.sha256` 是它自己的哈希',
    '');
  return lines.join('\n');
}

/**
 * 生成交付包。
 * @param {object} p { projectDir, state?, formal?, cancelled?, budgetExhausted?, outDir?, mirror?:boolean }
 */
export function deliverFloor({ projectDir, state: forced = null, formal = null, cancelled = false, budgetExhausted = false, outDir = null, mirror: withMirror = true } = {}) {
  const dir = resolve(projectDir);
  if (!existsSync(dir)) throw new Error(`项目目录不存在：${dir}`);
  const cfg = readProjectConfig(dir);
  const siteId = cfg.siteId;
  const page = cfg.pages?.[0]?.name ?? Object.keys(cfg.pages ?? {})[0] ?? 'home';
  const pageDir = requireMirror(siteId, page);
  const cloneDir = join(pageDir, 'clone');

  const entries = readLedger(dir);
  const decisions = decisionsFor(entries, cfg.budget);
  // 正式裁判的结果自动带上：交付状态不能比它更乐观
  const formalGate = formal ?? latestFormalGate(siteId, page, dir);
  let { state, reason } = forced ? { state: forced, reason: 'made_by_cli' } : deliveryState({ decisions, formal: formalGate, cancelled, budgetExhausted });
  // 反作弊命中过就不按「通过」交付：像素分再高也不认（E7-18）
  if (entries.some(e => e.anticheat === 'suspect') && (state === 'passed' || state === 'passed_with_residuals')) {
    ({ state, reason } = { state: 'failed_with_residuals', reason: 'anticheat' });
  }
  const residuals = residualsOf(decisions);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const out = outDir ? resolve(outDir) : join(agentDir(siteId), 'deliver', `${page}-${stamp}-${sha256(String(Date.now()) + siteId + page).slice(0, 6)}`);
  mkdirSync(out, { recursive: true });

  const mirrorDir = join(out, 'mirror');
  const mirrorFiles = withMirror ? copyTree(cloneDir, mirrorDir) : [];
  const projectDirOut = join(out, 'project');
  const projectFiles = copyTree(dir, projectDirOut, {
    skipDir: (name) => PROJECT_SKIP.has(name),
    skipRel: (rel) => [...PROJECT_SKIP_PATHS].some(p => rel === p || rel.startsWith(p + '/')),
  });
  const passed = state === 'passed' || state === 'passed_with_residuals';
  if (!passed) {
    writeFileSync(join(projectDirOut, 'DRAFT.md'), [
      '# 未通过的草稿',
      '',
      `这份重建在 Heimdall 的 ${state}（${REASON_TEXT[reason] ?? reason}）下交付，**不要直接上线**。`,
      '能用的版本是同一个交付包里的 `mirror/`。',
      '',
      `原因：${REASON_TEXT[reason] ?? reason}`,
      '', '残差见 `../residuals.json` 与 `../REPORT.md`。', '',
    ].join('\n'));
  }

  const report = renderReport({ siteId, page, state, reason, residuals, mirror: { files: mirrorFiles.length }, project: { files: projectFiles.length }, formal: formalGate, ledgerCount: entries.length });
  writeFileSync(join(out, 'REPORT.md'), report);
  writeFileSync(join(out, 'residuals.json'), JSON.stringify({ schema: 'heimdall.residuals/1', siteId, page, generatedAt: new Date().toISOString(), residuals }, null, 1) + '\n');

  const delivery = {
    schema: 'heimdall.delivery/1',
    siteId, page, generatedAt: new Date().toISOString(),
    state, reason, reasonText: REASON_TEXT[reason] ?? reason,
    floorIsMirror: !passed,
    notice: passed ? '门禁通过：重建项目为成品，镜像作为附件。' : '未通过门禁：镜像是交付物，重建项目是草稿。',
    contents: {
      mirror: withMirror ? { dir: 'mirror', files: mirrorFiles.length } : null,
      project: { dir: 'project', files: projectFiles.length, passed },
      report: 'REPORT.md', residuals: 'residuals.json', manifest: 'MANIFEST.jsonl',
    },
    residuals,
    formal: formalGate,
    ledger: { iterations: entries.length, sections: decisions.length },
  };
  const body = JSON.stringify(delivery, null, 1) + '\n';
  writeFileAtomic(join(out, 'delivery.json'), body);
  // 清单覆盖包里除它自己以外的每个文件（含 delivery.json），所以放在最后算、最后写
  const manifest = manifestOf(out, { skipDir: new Set(['node_modules']) });
  writeFileSync(join(out, 'MANIFEST.jsonl'), manifest.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { ...delivery, outDir: out, files: manifest.length, evidence: { uri: `file://${join(out, 'delivery.json').replace(/\\/g, '/')}`, sha256: sha256(body), bytes: body.length } };
}
