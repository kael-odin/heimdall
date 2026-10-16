import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [project, manifestPath, destination] = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
const changed = manifest.files.filter(file => {
  const bytes = fs.readFileSync(join(project, file.path));
  return bytes.length !== file.bytes || sha(bytes) !== file.sha256;
}).map(file => file.path);
fs.writeFileSync(destination, JSON.stringify({ checkedAt: new Date().toISOString(), count: manifest.files.length,
  changed, manifestSha256: sha(manifestBytes), project }, null, 2) + '\n');
if (changed.length) process.exit(2);
