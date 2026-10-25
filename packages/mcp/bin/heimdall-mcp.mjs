#!/usr/bin/env node
/**
 * heimdall-mcp —— MCP v2 入口
 *
 *   node packages/mcp/bin/heimdall-mcp.mjs              stdio（默认；客户端配置里用 node 的绝对路径启动它）
 *   node packages/mcp/bin/heimdall-mcp.mjs --http 8931  无状态 Streamable HTTP：POST http://127.0.0.1:8931/mcp
 *
 * stdout 只给 MCP 协议用；任何日志都走 stderr。
 * HTTP 只监听 127.0.0.1，并在进入 SDK 前校验 Host / Origin（防 DNS 重绑定）。
 */
import { createServer as createHttpServer } from 'node:http';
import { createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, originValidationResponse, localhostAllowedOrigins } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/server.mjs';

const log = (...a) => process.stderr.write('[heimdall-mcp] ' + a.join(' ') + '\n');
const factory = createServer({ client: 'mcp', detachEngine: true });

/** node:http → Web 标准 Request / Response（SDK 的 HTTP 入口是 fetch 形状；@modelcontextprotocol/node 没有 2.4.0 版） */
async function bridge(handler, req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
  const response = rejected ?? await handler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
  res.end();
}

const httpIdx = process.argv.indexOf('--http');
if (httpIdx > -1) {
  const port = Number(process.argv[httpIdx + 1] ?? 8931);
  const handler = createMcpHandler(factory, { legacy: 'stateless', onerror: e => log('error', e.message) });
  createHttpServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404); return res.end(); }
    bridge(handler, req, res).catch(e => { log('bridge', e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
  }).listen(port, '127.0.0.1', () => log(`MCP HTTP on http://127.0.0.1:${port}/mcp`));
} else {
  serveStdio(factory, { onerror: e => log('error', e.message) });
}
