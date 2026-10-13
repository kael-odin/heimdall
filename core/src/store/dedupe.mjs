#!/usr/bin/env node
/**
 * store/dedupe — 对站点 workspace（或任意目录）做内容寻址去重
 *
 * 用法:
 *   node src/store/dedupe.mjs <host> [--dry-run] [--dir <path>]
 *
 * 产出:
 *   DATA_ROOT/assets-cas/**            共享 CAS
 *   workspace/<host>/asset-ledger.json 本次去重账本（文件数/唯一数/节省字节/失败数）
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, WORKSPACE } from '../paths.mjs';
import { dedupeTree } from './cas.mjs';
import { mb } from '../fsutil.mjs';

const host = process.argv[2] ?? '';
const dryRun = process.argv.includes('--dry-run');
const dirIdx = process.argv.indexOf('--dir');
const rootDir = dirIdx > -1 ? process.argv[dirIdx + 1] : (host ? join(WORKSPACE, host) : '');
if (!rootDir) { console.error('usage: node src/store/dedupe.mjs <host> [--dry-run] [--dir <path>]'); process.exit(2); }
if (!existsSync(rootDir)) { console.error('no such dir:', rootDir); process.exit(1); }

const storeDir = join(DATA_ROOT, 'assets-cas');
const started = Date.now();
// 范围 = **产物资产树 + 捕获下来的资产目录**。它们都是"写一次就不再改"的文件，
// 硬链接它们是安全的，而且去重的收益几乎全在这里（实测 apify：608MB / 全量 642MB）。
// 排除的是捕获**输入**（cssom*.css / dom*.html / network.har）与各种清单、报告、评分 ——
// 那些文件会被后续步骤反复重写，硬链接它们等于让一次写入改到别处去。
const ledger = dedupeTree(rootDir, storeDir, { dryRun, skip: ['node_modules'], onlyUnder: ['clone', 'live', 'assets', 'styles'] });
ledger.ms = Date.now() - started;
ledger.generatedAt = new Date().toISOString();
console.log(`dedupe${dryRun ? ' (dry-run)' : ''}: ${ledger.files} files | unique ${ledger.unique} | duplicates ${ledger.duplicates}`);
console.log(`  bytes: total ${mb(ledger.bytesTotal)} | saved ~${mb(ledger.bytesSaved)} | skipped ${ledger.skipped} | linked ${ledger.linked} | ${ledger.ms}ms`);
if (!dryRun) writeFileSync(join(rootDir, 'asset-ledger.json'), JSON.stringify(ledger, null, 2));
