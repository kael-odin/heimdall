#!/usr/bin/env node
/**
 * skills:sync —— 技能与子代理的唯一来源同步（E4-07、E4-09）
 *
 *   plugin/skills/<name>/…  与 plugin/agents/<name>.md   是**唯一来源**
 *   .agents/skills/…        与 .agents/agents/…          是生成物（供其它代理与 CI 读取）
 *
 *   node scripts/sync-skills.mjs          复制并内联「不可信内容」块
 *   node scripts/sync-skills.mjs --check  只比对，不一致则退出 1（CI 用）
 *
 * 内联规则：每个 SKILL.md 与子代理文件末尾必须有一份 reference/untrusted.md 的块，
 * 由 heimdall:untrusted:begin/end 标记包住；同步时整段替换，保证逐字一致。
 * 同时做两项静态检查（E4-09）：allowed-tools 里不得出现 Bash(*) 一类通配；SKILL.md ≤ 500 行。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC_SKILLS = join(ROOT, 'plugin', 'skills');
const SRC_AGENTS = join(ROOT, 'plugin', 'agents');
const OUT_SKILLS = join(ROOT, '.agents', 'skills');
const OUT_AGENTS = join(ROOT, '.agents', 'agents');
const CHECK = process.argv.includes('--check');
const BEGIN = '<!-- heimdall:untrusted:begin';
const END = '<!-- heimdall:untrusted:end -->';
const problems = [];

/** 把共享块（reference/untrusted.md）整段替换到 heimdall:untrusted 标记之间 */
function inlineUntrusted(text, block, file) {
  const i = text.indexOf(BEGIN);
  const j = text.lastIndexOf(END);
  if (i < 0 || j < 0) { problems.push(`${file}: 缺少不可信内容块标记`); return text; }
  return text.slice(0, i) + block.trim() + '\n' + text.slice(j + END.length);
}

function checkText(file, text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) problems.push(`${file}: 缺 frontmatter`);
  const tools = fm?.[1].match(/^allowed-tools:\s*(.+)$/m)?.[1] ?? fm?.[1].match(/^tools:\s*(.+)$/m)?.[1] ?? '';
  if (/Bash\(\*\)|Bash\(sh|Bash\(curl|Bash\(bash/.test(tools)) problems.push(`${file}: allowed-tools 出现通配或危险命令`);
  if (/\bBash\(\*\)/.test(tools)) problems.push(`${file}: 不得 Bash(*)`);
  if (file.endsWith('SKILL.md') && text.split('\n').length > 500) problems.push(`${file}: 超过 500 行`);
  const desc = fm?.[1].match(/^description:\s*"([\s\S]*?)"\s*$/m)?.[1] ?? '';
  if (desc.length > 1536) problems.push(`${file}: description ${desc.length} 字符，超过 1536`);
  if (!text.includes(BEGIN)) problems.push(`${file}: 没有内联不可信内容块`);
}

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

/** 生成目标文件表 { 相对路径: 内容 } */
function buildOutputs() {
  const out = new Map();
  const sharedAgent = readFileSync(join(SRC_SKILLS, 'heimdall-rebuild', 'reference', 'untrusted.md'), 'utf8');
  for (const name of readdirSync(SRC_SKILLS)) {
    const dir = join(SRC_SKILLS, name);
    if (!statSync(dir).isDirectory()) continue;
    const refFile = join(dir, 'reference', 'untrusted.md');
    const shared = existsSync(refFile) ? readFileSync(refFile, 'utf8') : readFileSync(join(SRC_SKILLS, 'heimdall-rebuild', 'reference', 'untrusted.md'), 'utf8');
    for (const f of walk(dir)) {
      const rel = relative(dir, f).replace(/\\/g, '/');
      if (rel === 'reference/untrusted.md') continue;   // 单一来源，不复制
      const text = readFileSync(f, 'utf8');
      out.set(`skills/${name}/${rel}`, f.endsWith('.md') ? inlineUntrusted(text, shared, f) : text);
    }
  }
  for (const f of readdirSync(SRC_AGENTS)) {
    if (!f.endsWith('.md')) continue;
    out.set(`agents/${f}`, inlineUntrusted(readFileSync(join(SRC_AGENTS, f), 'utf8'), sharedAgent, join(SRC_AGENTS, f)));
  }
  // 内联后的正文也要过一遍静态检查
  for (const [rel, text] of out) if (rel.endsWith('.md')) checkText(rel, text);
  return out;
}

const outputs = buildOutputs();
let changed = 0;
for (const [rel, text] of outputs) {
  const target = join(ROOT, '.agents', rel);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current === text) continue;
  changed++;
  if (CHECK) { console.log(`drift: .agents/${rel}`); continue; }
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, text);
}
if (problems.length) {
  console.error(`skills:sync 检查未通过（${problems.length} 项）：`);
  for (const p of problems) console.error('  - ' + p.replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/') + '/', ''));
  process.exit(1);
}
if (CHECK && changed) { console.error(`skills:sync 发现 ${changed} 个文件不同步；运行 pnpm skills:sync`); process.exit(1); }
console.log(CHECK ? `skills:sync 一致（${outputs.size} 个文件）` : `skills:sync 完成（${changed} 个文件更新，共 ${outputs.size} 个）`);
