import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(CORE, 'src', 'harvest', 'xlsx.mjs');

test('ExcelJS exports a readable workbook with the patched uuid and minimatch graph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-xlsx-'));
  const page = join(root, 'workspace', 'fixture.test', 'pages', 'home');
  mkdirSync(join(page, 'intel'), { recursive: true });
  writeFileSync(join(page, 'score.json'), JSON.stringify({
    total: 98, grade: 'A', pixel: .98, dom: { dom: .99 }, scoreFormulaVersion: 2,
    data: { data: 1 }, breakdown: { refinable: .9 },
  }));
  writeFileSync(join(page, 'intel', 'intel.json'), JSON.stringify({
    headings: [{ level: 1, text: 'Fixture' }], prices: ['$10'], cta: ['Start'], links: ['/next'],
  }));
  writeFileSync(join(page, 'intel', 'semantic.json'), JSON.stringify({
    pageType: 'landing', valueProps: ['Fast'], products: [{ name: 'Core', oneLiner: 'One' }],
    plans: [{ name: 'Pro', price: '$10', billing: 'month', features: ['A'] }], notableClaims: ['Claim'],
  }));
  try {
    const child = spawnSync(process.execPath, [SCRIPT, 'fixture.test'], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const output = join(root, 'workspace', 'fixture.test', 'intel', 'fixture.test-intel.xlsx');
    assert.equal(existsSync(output), true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['概览', '语义情报', '定价与CTA']);
    assert.equal(workbook.getWorksheet('概览').getCell('B2').value, 98);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
