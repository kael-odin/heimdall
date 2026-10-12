/**
 * child-run — 跑一个同仓库脚本，失败时报出**为什么**
 *
 * 起因是一次真实的排查死路：任务历史里躺着 `Error: crawler/build_clone.mjs exited 1`，
 * 而真正的原因（子进程 stderr）当时只流去了引擎控制台，没有任何地方留存。
 * 用户看到的就是这么一句，无从下手；我们事后翻 jobs.db 也只翻到同一句。
 *
 * 所以规矩是：**stderr 既实时转发，又留一份尾巴**，失败时并进错误信息。
 * stdout 保持继承 —— `@@EVENT@@` 协议走那条路，不能被截走。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** 错误信息里最多带几行 stderr 尾巴、总共几个字符（进 jobStore / SSE，要短） */
export const DEFAULT_KEEP = 4;
export const TAIL_CHARS = 400;

/**
 * 把一段 stderr 追加进尾巴缓冲（纯函数，单测直接喂输入）。
 * 按行切（CRLF 与 LF 都认），只保留最后 `keep` 行；空行不算，免得尾巴全是空。
 */
export function tailPush(tail, chunk, keep = DEFAULT_KEEP) {
  const out = Array.isArray(tail) ? tail : [];
  for (const line of String(chunk ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    out.push(t);
    if (out.length > keep) out.shift();
  }
  return out;
}

/** 把尾巴拼成一句能读的错误后缀 */
export function tailText(tail) {
  const s = (tail ?? []).join(' | ').slice(-TAIL_CHARS);
  return s ? `：${s}` : '';
}

/**
 * 跑 `src/<script> <args...>`，返回 Promise。
 * @param {string} script 相对 src/ 的路径（如 'crawler/build_clone.mjs'）
 * @returns {Promise<void>} 非 0 退出时 reject，错误信息带上 stderr 尾巴
 */
export function runScript(script, args = [], { env, keep = DEFAULT_KEEP, quiet = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join('src', script), ...args], {
      stdio: ['ignore', 'inherit', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
      // 大多数调用方就在 core/ 下跑，不用传 cwd；要脱离 cwd 假设的（多视口升级那条 CLI）
      // 必须显式给，否则从别处调用会找不到 src/
      ...(cwd ? { cwd } : {}),
    });
    const tail = [];
    p.stderr?.on('data', (buf) => {
      if (!quiet) process.stderr.write(buf);    // 照旧实时可见
      tailPush(tail, buf, keep);
    });
    p.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${script} exited ${code}${tailText(tail)}`));
    });
    p.on('error', reject);
  });
}

/** 同 runScript，但把结果折成布尔（批量流程里"这一步没成"不该中断整批） */
export async function runScriptBool(script, args = [], opts) {
  try { await runScript(script, args, opts); return true; } catch { return false; }
}
