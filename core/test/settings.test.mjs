/**
 * settings — 模型服务配置的读写与校验
 *
 * 关键不变量：
 *   ① 原地改值，注释/顺序/未知键必须原样保留（用户手写的 .env 不能被工具洗掉）
 *   ② 非白名单键一律拒绝
 *   ③ Key 永不回显（只给 hasKey + 末 4 位）
 *   ④ 省略 apiKey = 保持不变（控制台不回显 Key，不能让它把已存的 Key 覆盖成空）
 *
 * 用 HEIMDALL_ENV_FILE 指向临时文件，绝不碰真实的 core/.env。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hd-settings-'));
process.env.HEIMDALL_ENV_FILE = join(dir, '.env');

const { readEnvFile, writeEnvKeys, llmSettings, normalizePatch, envFile } = await import('../src/settings.mjs');

const SAMPLE = [
  '# Heimdall 配置示例',
  '',
  'HEIMDALL_LLM=1',
  'LLM_BASE_URL=https://relay.example.com/v1',
  'LLM_API_KEY=sk-abcdefghijklmnop',
  'LLM_MODEL=glm-5.3-flash',
  '',
  '# 还原度阈值',
  'FIXUP_MIN_STATIC=0.002',
  'UNKNOWN_KEY=keep-me',
  '',
].join('\n');

function resetSample() {
  writeFileSync(envFile(), SAMPLE);
}
resetSample();

test('settings: 原地改值，注释/空行/未知键原样保留', () => {
  resetSample();
  const r = writeEnvKeys({ LLM_MODEL: 'deepseek-v4-flash' });
  assert.deepEqual(r.written, ['LLM_MODEL']);
  assert.deepEqual(r.appended, []);

  const after = readFileSync(envFile(), 'utf8');
  assert.match(after, /# Heimdall 配置示例/, '注释保留');
  assert.match(after, /# 还原度阈值/, '中段注释保留');
  assert.match(after, /UNKNOWN_KEY=keep-me/, '未知键保留');
  assert.match(after, /^LLM_MODEL=deepseek-v4-flash$/m);
  assert.equal(after.split('\n').length, SAMPLE.split('\n').length, '行数不变（原位替换）');
});

test('settings: 不存在的键追加到末尾', () => {
  resetSample();
  const r = writeEnvKeys({ LLM_MODEL_FAST: 'flash-x' });
  assert.deepEqual(r.appended, ['LLM_MODEL_FAST']);
  const after = readFileSync(envFile(), 'utf8');
  assert.match(after, /^LLM_MODEL_FAST=flash-x$/m);
  assert.ok(after.endsWith('\n'), '写回后以换行结尾，便于下次追加');
});

test('settings: 非白名单键被拒绝，且文件不动', () => {
  resetSample();
  assert.throws(() => writeEnvKeys({ HEIMDALL_TOKEN: 'x' }), /不可写入的配置键/);
  assert.throws(() => writeEnvKeys({ EVIL: 'x' }), /不可写入的配置键/);
  assert.equal(readFileSync(envFile(), 'utf8'), SAMPLE, '被拒绝时不得改动文件');
});

test('settings: normalizePatch 校验各字段并给出可读错误', () => {
  assert.deepEqual(normalizePatch({ protocol: 'anthropic' }), { LLM_PROTOCOL: 'anthropic' });
  assert.deepEqual(normalizePatch({ enabled: false }), { HEIMDALL_LLM: '0' });
  assert.deepEqual(normalizePatch({ baseUrl: 'https://x.test/v1/' }), { LLM_BASE_URL: 'https://x.test/v1' }, '去掉末尾斜杠');

  assert.throws(() => normalizePatch({ protocol: 'grpc' }), /协议必须是/);
  assert.throws(() => normalizePatch({ baseUrl: 'ftp://x' }), /http\/https/);
  assert.throws(() => normalizePatch({ baseUrl: 'not a url' }), /合法地址/);
  assert.throws(() => normalizePatch({ model: '   ' }), /主模型不能为空/);
  assert.throws(() => normalizePatch({ timeoutMs: 10 }), /超时需在/);
  assert.throws(() => normalizePatch({ retries: 99 }), /重试次数需在/);
  assert.throws(() => normalizePatch({ nope: 1 }), /不支持的字段/);
  assert.throws(() => normalizePatch({}), /没有需要修改的字段/);
});

test('settings: 省略 apiKey = 保持不变（不会被覆盖成空）', () => {
  resetSample();
  writeEnvKeys(normalizePatch({ model: 'm1' }));
  assert.match(readFileSync(envFile(), 'utf8'), /^LLM_API_KEY=sk-abcdefghijklmnop$/m);

  // 显式传 apiKey 才改
  writeEnvKeys(normalizePatch({ apiKey: 'sk-new-key-9876' }));
  assert.match(readFileSync(envFile(), 'utf8'), /^LLM_API_KEY=sk-new-key-9876$/m);

  // 显式空串 = 清空
  writeEnvKeys(normalizePatch({ apiKey: '' }));
  assert.match(readFileSync(envFile(), 'utf8'), /^LLM_API_KEY=$/m);
  resetSample();
});

test('settings: Key 永不回显，只给 hasKey 与末 4 位', () => {
  resetSample();
  const s = llmSettings();
  assert.equal(s.hasKey, true);
  assert.equal(s.keyHint, '****mnop');
  const dump = JSON.stringify(s);
  assert.ok(!dump.includes('sk-abcdefghijklmnop'), '序列化结果里不能出现完整 Key');
  assert.equal(s.baseHost, 'relay.example.com');
  assert.equal(s.ready, true);
});

test('settings: Key 缺失时 ready=false，短 Key 打码不泄露', () => {
  writeFileSync(envFile(), 'HEIMDALL_LLM=1\nLLM_BASE_URL=https://a.test/v1\nLLM_MODEL=m\n');
  const s = llmSettings();
  assert.equal(s.hasKey, false);
  assert.equal(s.ready, false);

  writeFileSync(envFile(), 'LLM_API_KEY=ab\n');
  assert.equal(llmSettings().keyHint, '****');
  resetSample();
});

test('settings: 文件不存在时 readEnvFile 返回 exists=false，不抛错', () => {
  const prev = process.env.HEIMDALL_ENV_FILE;
  process.env.HEIMDALL_ENV_FILE = join(dir, 'nope', '.env');
  try {
    const r = readEnvFile();
    assert.equal(r.exists, false);
    assert.equal(r.entries.size, 0);
  } finally { process.env.HEIMDALL_ENV_FILE = prev; }
});

test.after(() => { rmSync(dir, { recursive: true, force: true }); });

test('settings: 落盘值不能含换行（否则会在 .env 里注入白名单之外的键）', () => {
  const NL = String.fromCharCode(10), CR = String.fromCharCode(13);
  for (const [field, value] of [['model', 'a' + NL + 'HEIMDALL_TOKEN=x'], ['apiKey', 'k' + CR + 'X=1'], ['baseUrl', 'https://x.test/v1' + NL + 'Y=2'], ['fastModel', 'm' + NL + 'Z=3']]) {
    assert.throws(() => normalizePatch({ [field]: value }), /换行/, field + ' 应被拒');
  }
  // 普通值照旧，前后空白仍然裁掉
  assert.deepEqual(normalizePatch({ model: ' gpt-5 ', baseUrl: 'https://x.test/v1/' }), { LLM_BASE_URL: 'https://x.test/v1', LLM_MODEL: 'gpt-5' });
});
