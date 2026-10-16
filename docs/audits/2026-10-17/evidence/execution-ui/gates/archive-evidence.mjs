import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
const [source, destination] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = readFileSync(source), compressed = gzipSync(original);
assert.deepEqual(gunzipSync(compressed), original);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, compressed);
writeFileSync(destination + '.json', JSON.stringify({ schemaVersion: 1, encoding: 'gzip',
  originalBytes: original.length, originalSha256: hash(original),
  compressedBytes: compressed.length, compressedSha256: hash(compressed), roundTripVerified: true }, null, 2) + '\n');
