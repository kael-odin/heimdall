/**
 * env — 统一的 .env 读取（core/.env，全流水线共享）
 *
 * 之前 pipeline 与 llm 各自实现 .env 解析（碎片化），此模块为唯一来源。
 *
 * **不缓存**：控制台改完 `.env` 必须立即生效（`settings.mjs` 直接写这个文件）。
 * 文件只有几 KB，每次读的代价可以忽略。
 * 优先级：进程环境变量 > core/.env（Node 常规约定）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 配置文件路径：可用 HEIMDALL_ENV_FILE 覆盖（Docker 挂载 / 单测隔离用） */
export const envFilePath = () => process.env.HEIMDALL_ENV_FILE || join(CORE_ROOT, '.env');

export function getEnv() {
  const env = { ...process.env };
  const p = envFilePath();
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

export const CORE = CORE_ROOT;
