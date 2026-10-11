/**
 * 代理响应头 —— 上游响应头原样交给客户端
 *
 * 单独成模块的唯一理由是**可测**：这里曾经埋着一个不报错、只"悄悄少东西"的坑。
 *
 * Node 的 res.writeHead 只认普通对象或扁平数组，**不认 WHATWG Headers**。
 * 传一个 Headers 进去不会抛错、状态码也照样正确，只是所有头被静默丢掉。
 * 症状极具迷惑性：PNG/JPG 靠魔数嗅探仍能渲染，于是看起来只是"个别图挂了"；
 * 实际是 Content-Type 全没了 —— 浏览器以 `MIME type of ""` 拒绝执行模块脚本，
 * 也就是交互镜像的 JS 从头到尾就没跑起来过（实测 vitest.dev：7 个 module script 全被拒）。
 */
export function writeProxyHead(res, status, headers) {
  const h = {};
  for (const [k, v] of headers) h[k] = v;
  // set-cookie 单列：迭代 Headers 会把多条 cookie 逗号拼成一条，必须走 getSetCookie
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length) h['set-cookie'] = cookies;
  res.writeHead(status, h);
}

/**
 * 从请求的 Host 头解析"独立域名入口"里的镜像站。
 *
 * `<host>.localhost:<port>` → `<host>`；其余（127.0.0.1、localhost、IPv6 字面量）→ null。
 * 用完整域名当子域（vitest.dev.localhost 而不是 vitest-dev.localhost）是为了**无损往返**：
 * 前者能直接还原出原站 host，后者在含连字符的域名上会歧义。
 */
export function mirrorHostOf(hostHeader) {
  const name = String(hostHeader ?? '').toLowerCase().split(':')[0];
  const m = /^([a-z0-9.-]+)\.localhost$/.exec(name);
  return m ? m[1] : null;
}
