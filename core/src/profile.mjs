/**
 * profile — 查看某个站点当前生效的配方（含来源标注）
 *
 * 用法:
 *   node src/profile.mjs <host>            打印合并后的配方
 *   node src/profile.mjs <host> --json     机器可读
 *   node src/profile.mjs <host> --learned  只看运行时学到的事实
 *   node src/profile.mjs --list            列出已有内置配方的站点
 *
 * 配方三层合并（后者覆盖前者）：内置默认 → workspace/<host>/site.json → core/sites/<host>.json
 */
import { readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadProfile, profilePaths, BUILTIN_DIR, DEFAULTS } from './site-profile.mjs';
import { requireArg } from './args.mjs';
import { WORKSPACE } from './paths.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const learnedOnly = argv.includes('--learned');

if (argv.includes('--list') || argv[0] === 'list') {
  const builtin = existsSync(BUILTIN_DIR)
    ? readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.json')).map(f => basename(f, '.json'))
    : [];
  const learned = existsSync(WORKSPACE)
    ? readdirSync(WORKSPACE).filter(h => existsSync(join(WORKSPACE, h, 'site.json')))
    : [];
  console.log('内置配方（core/sites/）:', builtin.length ? builtin.join(', ') : '（无）');
  console.log('运行时学到（workspace/*/site.json）:', learned.length ? learned.join(', ') : '（无）');
  process.exit(0);
}

const host = requireArg(argv.find(a => !a.startsWith('--')), 'node src/profile.mjs <host> [--json|--learned|--list]', '站点 host');
const profile = loadProfile(host, { fresh: true });
const paths = profilePaths(host);

if (asJson) {
  console.log(JSON.stringify({ ...profile, sources: undefined, sourceFiles: {
    builtin: paths.builtin, learned: paths.learned,
    hasBuiltin: existsSync(paths.builtin), hasLearned: existsSync(paths.learned),
  } }, null, 2));
  process.exit(0);
}

if (learnedOnly) {
  console.log(JSON.stringify(profile.learned ?? { note: '尚未学到任何东西（跑一次批量克隆或 forge 后会出现）' }, null, 2));
  process.exit(0);
}

const src = (label, file, on, note = '') =>
  `${on ? '✓' : '·'} ${label.padEnd(28)} ${on ? file : '（不存在）'} ${note}`;

console.log(`站点 ${profile.host} 的生效配方`);
console.log('─'.repeat(72));
console.log(src('内置默认', 'src/site-profile.mjs DEFAULTS', true));
console.log(src('运行时学到', paths.learned, existsSync(paths.learned), existsSync(paths.learned) ? '（覆盖默认）' : ''));
console.log(src('人工整理', paths.builtin, existsSync(paths.builtin), existsSync(paths.builtin) ? '（覆盖以上全部）' : '（可选：加一个文件即可固化站点调参）'));
console.log('─'.repeat(72));

const show = (obj, prefix = '') => {
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'host' || k === 'sources' || k === 'learned' || k === 'learnedAt') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) show(v, prefix + k + '.');
    else console.log(`  ${(prefix + k).padEnd(30)} ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(v)}`);
  }
};
show(profile);

if (profile.learned) {
  console.log('\n运行时观察到的事实（learned）：');
  for (const [k, v] of Object.entries(profile.learned)) {
    console.log(`  ${k.padEnd(30)} ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(v)}`);
  }
}
if (profile.notes) console.log('\n备注：' + profile.notes);

const overridden = [];
for (const key of Object.keys(DEFAULTS)) {
  if (JSON.stringify(profile[key]) !== JSON.stringify(DEFAULTS[key])) overridden.push(key);
}
console.log('\n与默认不同的项：' + (overridden.length ? overridden.join(', ') : '（无）'));
