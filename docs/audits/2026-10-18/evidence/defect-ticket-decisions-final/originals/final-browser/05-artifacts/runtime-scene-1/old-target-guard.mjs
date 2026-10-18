import http from 'node:http';
import https from 'node:https';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const origins = new Set(["http://127.0.0.1:52352"]);
const trace = "C:\\Users\\44548\\AppData\\Local\\Temp\\heimdall-acceptance-catalog-migration-QEShLX\\old-target-attempts.jsonl";
function deny(input, protocol, channel) {
  let url;
  try {
    url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : input?.url ? new URL(input.url)
      : new URL((input?.protocol ?? protocol) + '//' + (input?.hostname ?? input?.host ?? 'localhost') + (input?.port ? ':' + input.port : '') + (input?.path ?? '/'));
  } catch { return; }
  if (!origins.has(url.origin)) return;
  appendFileSync(trace, JSON.stringify({ channel, url: url.href }) + '\n');
  throw new Error('MIGRATION_SMOKE_OLD_TARGET_FORBIDDEN');
}
const fetch = globalThis.fetch;
globalThis.fetch = function(input, options) { deny(input, 'http:', 'engine-fetch'); return fetch.call(this, input, options); };
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function(input, ...rest) { deny(input, protocol, 'engine-' + protocol + method); return original.call(this, input, ...rest); };
  }
}
syncBuiltinESMExports();
