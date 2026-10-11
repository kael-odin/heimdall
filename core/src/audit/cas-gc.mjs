/**
 * audit/cas-gc — CAS 孤儿回收
 *
 * 判据：CAS 里 nlink === 1 的文件 —— 去重后 CAS 与 workspace 副本共用同一个 inode，
 * 只剩一个链接就说明没有任何站点文件在用它是孤儿。CAS 从不被直接读取（纯去重源），
 * 所以删除孤儿不会破坏任何产物；后续若又需要，下一次 dedupe 会重新登记。
 *
 * 用法:
 *   node src/audit/cas-gc.mjs              只统计（默认，不动任何文件）
 *   node src/audit/cas-gc.mjs --apply      真正回收
 *   node src/audit/cas-gc.mjs --json       机器可读输出
 */
import { join } from 'node:path';
import { DATA_ROOT } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { gcCas } from '../store/cas.mjs';
import { mb } from '../fsutil.mjs';

const apply = process.argv.includes('--apply');
const asJson = process.argv.includes('--json');
const storeDir = join(DATA_ROOT, 'assets-cas');

const r = gcCas(storeDir, { apply });

if (asJson) {
  console.log(JSON.stringify({ storeDir, ...r, orphans: undefined }, null, 2));
} else {
  console.log(`CAS ${storeDir}`);
  console.log(`  文件 ${r.files} · 磁盘 ${mb(r.bytes)}`);
  console.log(`  在用 ${r.linkedFiles} 个 / ${mb(r.linkedBytes)}`);
  console.log(`  孤儿 ${r.orphanFiles} 个 / ${mb(r.orphanBytes)}${r.empty ? `（含 ${r.empty} 个 0 字节）` : ''}`);
  if (apply) console.log(`  已回收 ${mb(r.freed)} · 失败 ${r.failed} · 跳过（扫描后又被链上）${r.skipped}`);
  else if (r.orphanFiles) console.log('  → 加 --apply 回收');
  console.log(`  ${r.ms}ms`);
}
emit({
  kind: 'cas-gc', apply, orphanFiles: r.orphanFiles, orphanBytes: r.orphanBytes, freed: r.freed ?? 0, failed: r.failed ?? 0,
});
