#!/usr/bin/env node
/**
 * check-frozen-verifier — 保护验收指纹：任何参与 fingerprint 的源文件被改动时报警。
 *
 * 验收子系统给每次运行盖一个由这些文件字节哈希组成的指纹。动一个字节（哪怕只是格式化），
 * 新运行就无法与历史运行生成可比基线。三份指纹清单分别来自：
 *   acceptance/managed-run-store.mjs  （9 个 acceptance 文件 + verify/compare.mjs）
 *   acceptance/browser-operation-store.mjs（4 个 browser 文件 + runner/report/identity + verify/compare.mjs）
 * 这里取两份清单的并集，manifest 在 core/FROZEN-VERIFIER.sha256。
 *
 *   node scripts/check-frozen-verifier.mjs            # 检查（pnpm check 会调用）
 *   node scripts/check-frozen-verifier.mjs --update   # 确认历史可比性已失效后，显式更新
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(CORE, 'FROZEN-VERIFIER.sha256');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (!existsSync(MANIFEST)) {
  console.error('frozen-verifier: 缺少 core/FROZEN-VERIFIER.sha256。先运行 `node scripts/check-frozen-verifier.mjs --update` 生成。');
  process.exit(1);
}
const entries = readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map(line => {
  const [hash, file] = line.trim().split(/\s+/, 2);
  return { hash, file };
});
if (!entries.length) {
  console.error('frozen-verifier: manifest 为空。');
  process.exit(1);
}

if (process.argv.includes('--update')) {
  const next = entries.map(({ file }) => `${sha256(join(CORE, file))}  ${file}`);
  writeFileSync(MANIFEST, next.join('\n') + '\n', 'utf8');
  console.log(`frozen-verifier: 已更新 ${next.length} 个文件的哈希。`);
  process.exit(0);
}

let failed = 0;
for (const { hash, file } of entries) {
  const path = join(CORE, file);
  if (!existsSync(path)) { console.error(`MISSING ${file}`); failed++; continue; }
  const actual = sha256(path);
  if (actual !== hash) {
    console.error(`CHANGED ${file}\n  manifest ${hash}\n  actual   ${actual}`);
    failed++;
  }
}
if (failed) {
  console.error(`\nfrozen-verifier: ${failed} 个文件与指纹清单不一致。`);
  console.error('这些文件参与验收运行指纹；改动会让新运行无法与历史运行生成可比基线。');
  console.error('如果这是有意的（历史可比性已被接受），先确认没有未完成的验收复验，再运行：');
  console.error('  node core/scripts/check-frozen-verifier.mjs --update');
  process.exit(1);
}
console.log(`frozen-verifier: ${entries.length} 个文件 OK`);
