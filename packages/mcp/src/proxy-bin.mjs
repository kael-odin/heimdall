#!/usr/bin/env node
/**
 * 插件形态的 MCP 入口（被打成单文件 plugin/server/heimdall-mcp.mjs）。
 * stdio；日志一律走 stderr（stdout 是 MCP 协议）。
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './proxy-server.mjs';

serveStdio(() => createServer(), { onerror: (e) => process.stderr.write('[heimdall-mcp] ' + (e?.message ?? e) + '\n') });
