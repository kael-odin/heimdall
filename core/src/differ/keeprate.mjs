/**
 * keeprate — AI 校准补丁命中率统计
 *
 * 扫描 workspace 下各 host 各页面的 fixup-history.json，统计：
 *   总轮次 / KEEP 数 / KEEP 率 / 平均分差 / 回滚造成的最差跌幅
 * 目标基线：KEEP 率 > 40%（style-probe 弹药加持后观测点）
 *
 * 用法: node src/differ/keeprate.mjs [host]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

const hostFilter = process.argv[2];
const hosts = existsSync(WORKSPACE) ? readdirSync(WORKSPACE).filter(n => existsSync(join(WORKSPACE, n, 'pages'))) : [];

let rounds = 0, kept = 0, deltas = [], worst = null;
for (const host of hosts) {
  if (hostFilter && host !== hostFilter) continue;
  for (const page of readdirSync(join(WORKSPACE, host, 'pages'))) {
    const p = join(WORKSPACE, host, 'pages', page, 'fixup-history.json');
    if (!existsSync(p)) continue;
    const h = JSON.parse(readFileSync(p, 'utf8'));
    for (const r of h.rounds ?? []) {
      rounds++;
      const d = +(r.after - r.before).toFixed(1);
      deltas.push(d);
      if (r.kept) kept++;
      if (!worst || d < worst.delta) worst = { host, page: r.round === undefined ? page : page, delta: d };
    }
  }
}

if (!rounds) { console.log('no fixup rounds recorded yet'); process.exit(0); }
const avg = (deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(1);
const keepRate = ((kept / rounds) * 100).toFixed(0);
console.log(`AI 校准补丁命中率: ${kept}/${rounds} = ${keepRate}%  (目标 >40%)`);
console.log(`平均分差: ${avg >= 0 ? '+' : ''}${avg} 分  |  最差回滚: ${worst ? worst.delta + ' 分 (' + worst.host + '/' + worst.page + ')' : '-'}`);
