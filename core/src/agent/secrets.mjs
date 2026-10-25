/**
 * agent/secrets — 按目录兜底的秘密路径判定（E12-02，PRD 03 §4.2）
 *
 * isSecretFile（paths.mjs）按文件名拦 session* / network* / operation-*；这里再加三条：
 *   · .env 一类、私钥与证书文件
 *   · 旅程目录 agent/journeys/<id>/ 下，除清洗后的 journey.json 与 steps/* 之外都按秘密级
 *   · 登录态目录（sessions/、.auth/）
 * 所有新工具与资源读取统一先过 isSecretPath()。
 */
import { basename } from 'node:path';
import { isSecretFile } from '../paths.mjs';

export function isSecretPath(file) {
  const p = String(file).replace(/\\/g, '/');
  if (isSecretFile(p)) return true;
  const name = basename(p).toLowerCase();
  if (/^\.env(?:\..*)?$/.test(name) || /\.(?:pem|key|p12|pfx|crt|cer)$/.test(name)) return true;
  if (/(?:^|\/)(?:sessions?|\.auth|cookies)(?:\/|$)/i.test(p)) return true;
  const journey = p.match(/(?:^|\/)agent\/journeys\/[^/]+\/(.+)$/);
  if (journey && !/^(?:journey\.json|steps\/[^/]+)$/.test(journey[1])) return true;
  return false;
}
