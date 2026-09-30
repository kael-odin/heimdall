/**
 * env — 统一的 .env 读取（core/.env，全流水线共享）
 *
 * 之前 pipeline 与 llm 各自实现 .env 解析（碎片化），此模块为唯一来源。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let cached = null;

export function getEnv() {
  if (cached) return cached;
  const env = { ...process.env };
  const p = join(CORE_ROOT, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];   // 进程环境变量优先
    }
  }
  cached = env;
  return env;
}

export const CORE = CORE_ROOT;
