/**
 * 探针：这个站能不能用增量重克隆？
 *
 * 取一个 URL 的源站 HTML 指纹，并判断它是不是"空壳"——
 * 空壳（纯 CSR）站的服务端 HTML 不变不代表内容不变，增量模式对它无效。
 *
 * 用法: node scripts/probe-fingerprint.mjs <url> [more-urls...]
 */
import { sourceFingerprint } from '../src/fingerprint.mjs';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('用法: node scripts/probe-fingerprint.mjs <url> [more-urls...]');
  process.exit(1);
}

for (const url of urls) {
  const fp = await sourceFingerprint(url);
  if (!fp.ok) { console.log(`${url}\n  抓取失败: ${fp.error}\n`); continue; }
  console.log(`${url}`);
  console.log(`  status     ${fp.status}`);
  console.log(`  正文粒度   ${fp.shell ? '空壳（JS 渲染站）→ 增量不可信' : '有正文（SSR/静态）→ 增量可用'}`);
  console.log(`  hash       ${fp.hash}`);
  console.log(`  etag       ${fp.etag ?? '—'}`);
  console.log(`  modified   ${fp.lastModified ?? '—'}`);
  console.log(`  字节       ${fp.bytes}`);
  console.log('');
}
