/**
 * LLM 多协议单测：请求构造 / 响应解析 / 模拟服务器端到端
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildRequest, parseResponse, llmChatWith } from '../src/llm.mjs';

const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }];

test('llm: buildRequest shapes for chat/responses/anthropic', () => {
  const chat = buildRequest({ protocol: 'chat', base: 'https://x/v1', key: 'k', model: 'm', messages, json: true, maxTokens: 100 });
  assert.equal(chat.url, 'https://x/v1/chat/completions');
  assert.equal(chat.headers.Authorization, 'Bearer k');
  assert.equal(chat.body.response_format.type, 'json_object');
  assert.equal(chat.body.messages.length, 2);

  const resp = buildRequest({ protocol: 'responses', base: 'https://x/v1', key: 'k', model: 'm', messages, maxTokens: 100 });
  assert.equal(resp.url, 'https://x/v1/responses');
  assert.equal(resp.body.input[0].role, 'developer');
  assert.equal(resp.body.input[1].content[0].type, 'input_text');
  assert.equal(resp.body.max_output_tokens, 100);

  const anth = buildRequest({ protocol: 'anthropic', base: 'https://x', key: 'k', model: 'm', messages, maxTokens: 100 });
  assert.equal(anth.url, 'https://x/messages');
  assert.equal(anth.headers['x-api-key'], 'k');
  assert.equal(anth.headers['anthropic-version'], '2023-06-01');
  assert.equal(anth.body.system, 'sys');
  assert.equal(anth.body.messages[0].content[0].type, 'text');
});

test('llm: vision content maps per protocol', () => {
  const vision = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  const chat = buildRequest({ protocol: 'chat', base: 'https://x/v1', key: 'k', model: 'm', messages: vision });
  assert.equal(chat.body.messages[0].content[1].type, 'image_url');
  const resp = buildRequest({ protocol: 'responses', base: 'https://x/v1', key: 'k', model: 'm', messages: vision });
  assert.equal(resp.body.input[0].content[1].type, 'input_image');
  const anth = buildRequest({ protocol: 'anthropic', base: 'https://x', key: 'k', model: 'm', messages: vision });
  assert.equal(anth.body.messages[0].content[1].type, 'image');
  assert.equal(anth.body.messages[0].content[1].source.data, 'AAAA');
});

test('llm: parseResponse per protocol', () => {
  assert.equal(parseResponse({ protocol: 'chat', data: { choices: [{ message: { content: 'a' } }] } }), 'a');
  assert.equal(parseResponse({ protocol: 'responses', data: { output_text: 'b' } }), 'b');
  assert.equal(parseResponse({ protocol: 'responses', data: { output: [{ content: [{ type: 'output_text', text: 'b2' }] }] } }), 'b2');
  assert.equal(parseResponse({ protocol: 'anthropic', data: { content: [{ type: 'text', text: 'c' }] } }), 'c');
});

test('llm: llmChatWith works end-to-end against a mock server', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? req.headers['x-api-key'], body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true,"p":"chat"}' } }] }));
      else if (req.url === '/v1/responses') res.end(JSON.stringify({ output_text: '{"ok":true,"p":"responses"}' }));
      else if (req.url === '/v1/messages') res.end(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true,"p":"anthropic"}' }] }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  try {
    for (const protocol of ['chat', 'responses', 'anthropic']) {
      const out = await llmChatWith({ protocol, base, key: 'test-key', model: 'm', timeout: 5000, retries: 1 }, messages, { json: true, maxTokens: 50 });
      assert.deepEqual(out, { ok: true, p: protocol });
    }
    assert.equal(seen.length, 3);
    assert.ok(seen.every(s => s.auth === 'test-key' || s.auth === 'Bearer test-key'));
  } finally { server.close(); }
});
