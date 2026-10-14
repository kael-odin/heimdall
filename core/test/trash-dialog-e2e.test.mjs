import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { quarantineSite, restoreTrash } from '../src/audit/site-trash.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(CORE, '..', 'console', 'dist');
const EVIDENCE_DIR = process.env.HEIMDALL_AUDIT_EVIDENCE_DIR;

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('recently deleted dialog backs up, purges, recovers and restores through the UI', {
  timeout: 45_000,
  skip: existsSync(join(DIST, 'index.html')) ? false : 'build console before browser test',
}, async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-ui-'));
  const backupRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-ui-backup-'));
  let engine, browser;
  try {
    for (const host of ['ready.test', 'restored.test']) {
      const site = join(dataRoot, 'workspace', host);
      mkdirSync(site, { recursive: true });
      writeFileSync(join(site, 'evidence.txt'), `${host} evidence`);
    }
    const ready = quarantineSite('ready.test', { dataRoot });
    const restored = quarantineSite('restored.test', { dataRoot });
    restoreTrash(restored.trashId, { dataRoot });
    const scan = spawnSync(process.execPath, [join(CORE, 'src', 'audit', 'storage.mjs')], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(scan.status, 0, scan.stderr);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    engine = spawn(process.execPath, [join(CORE, 'src', 'engine-server.mjs'), String(port)], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: DIST,
        HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: '', HEIMDALL_TRASH_WARN_BYTES: '1',
        HEIMDALL_TRASH_BACKUP_DIR: backupRoot },
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/api/status')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await fetch(base + '/api/status')).ok, true);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let trashReads = 0;
    await page.route('**/api/trash', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      trashReads++;
      if (trashReads > 3) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.summary = trashReads === 1
        ? { ...body.summary, uniqueBytes: null, pending: true, stale: false, scanning: true, warning: false }
        : { ...body.summary, uniqueBytes: trashReads === 2 ? 42 : 100,
          pending: false, stale: false, scanning: false, warning: true, warningBytes: 1 };
      await route.fulfill({ response, json: body });
    });
    await page.goto(base);
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '查看并恢复' }).click();
    const dialog = page.getByRole('dialog', { name: '最近删除' });
    await dialog.getByText('隔离区占用', { exact: false }).waitFor();
    await dialog.getByText('容量盘点正在更新。').waitFor();
    await dialog.getByText('已达到容量告警阈值', { exact: false }).waitFor({ timeout: 5_000 });
    assert.ok(trashReads >= 2, 'pending capacity summary must be polled');
    await dialog.getByRole('button', { name: '刷新容量' }).click();
    await dialog.getByText('隔离区占用 100 B').waitFor();
    assert.match(await dialog.locator('.trash-summary').textContent(), /容量告警阈值/);

    const readyRow = dialog.locator('.trash-row').filter({ hasText: ready.trashId });
    await readyRow.getByRole('button', { name: '预览' }).click();
    assert.match(await readyRow.locator('.trash-preview').textContent(), /verified external backup/);
    assert.equal(await readyRow.getByRole('button', { name: '恢复' }).count(), 1);
    assert.equal(await readyRow.getByRole('button', { name: '清理隔离副本' }).count(), 0);

    const terminalRow = dialog.locator('.trash-row').filter({ hasText: restored.trashId });
    await terminalRow.getByRole('button', { name: '预览' }).click();
    const purgeButton = terminalRow.getByRole('button', { name: '永久清理记录' });
    assert.equal(await purgeButton.isDisabled(), true);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await terminalRow.evaluate((row) => {
        const rect = (selector) => row.querySelector(selector).getBoundingClientRect();
        const actions = rect('.trash-actions');
        const preview = rect('.trash-preview');
        const bounds = row.closest('.trash-body').getBoundingClientRect();
        return { previewTop: preview.top, actionsBottom: actions.bottom,
          previewLeft: preview.left, previewRight: preview.right,
          bodyLeft: bounds.left, bodyRight: bounds.right };
      });
      assert.ok(layout.previewTop >= layout.actionsBottom, `preview must occupy its own row at ${width}px`);
      assert.ok(layout.previewLeft >= layout.bodyLeft && layout.previewRight <= layout.bodyRight,
        `preview must fit the dialog at ${width}px`);
      if (EVIDENCE_DIR) {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        await dialog.screenshot({ path: join(EVIDENCE_DIR, `trash-dialog-${width}.png`) });
      }
    }
    await terminalRow.getByRole('textbox').fill(restored.trashId);
    assert.equal(await purgeButton.isEnabled(), true);
    await purgeButton.click();
    await dialog.getByText(`已清理记录 ${restored.trashId}`, { exact: false }).waitFor();
    await dialog.locator('.trash-row').filter({ hasText: restored.trashId }).waitFor({ state: 'detached' });
    await readyRow.getByRole('button', { name: '创建并核验备份' }).click();
    await dialog.getByText('已逐文件校验备份', { exact: false }).waitFor();
    const readyPurge = readyRow.getByRole('button', { name: '清理隔离副本' });
    await readyPurge.waitFor();
    const risk = readyRow.getByRole('checkbox', { name: /同一文件系统/ });
    if (await risk.count()) await risk.check();
    await readyRow.getByRole('textbox').fill(ready.trashId);
    await readyPurge.click();
    await dialog.getByText(`已清理隔离副本 ${ready.trashId}`, { exact: false }).waitFor();
    const backedRow = dialog.locator('.trash-purged .trash-row').filter({ hasText: ready.trashId });
    await backedRow.waitFor();
    await backedRow.getByRole('textbox').fill(ready.trashId);
    await backedRow.getByRole('button', { name: '从备份重建' }).click();
    await dialog.getByText(`已从外部备份重建隔离条目 ${ready.trashId}`, { exact: false }).waitFor();
    const recoveredRow = dialog.locator('.trash-list .trash-row').filter({ hasText: ready.trashId }).first();
    await recoveredRow.getByRole('button', { name: '恢复' }).click();
    await dialog.getByText('已恢复 站点 ready.test').waitFor();
    assert.equal(readFileSync(join(dataRoot, 'workspace', 'ready.test', 'evidence.txt'), 'utf8'), 'ready.test evidence');
    assert.equal(readFileSync(join(dataRoot, 'workspace', 'restored.test', 'evidence.txt'), 'utf8'), 'restored.test evidence');
    assert.equal(JSON.parse(readFileSync(join(dataRoot, 'trash', '.purge-receipts', `${restored.trashId}.json`), 'utf8')).state, 'complete');
    assert.deepEqual(errors, []);
    if (EVIDENCE_DIR) writeFileSync(join(EVIDENCE_DIR, 'trash-dialog.json'), JSON.stringify({
      capturedAt: new Date().toISOString(), viewports: [1280, 390],
      capacity: { controlledApiResponses: true, pendingPolled: trashReads >= 2, manualRefresh: true },
      recoverablePayloadBackedUpPurgedAndRestored: true, terminalRecordCleared: true,
      receiptState: 'complete', pageErrors: errors,
    }, null, 2));
  } finally {
    await browser?.close();
    if (engine?.exitCode === null && engine.signalCode === null) {
      engine.kill();
      await new Promise(resolve => engine.once('exit', resolve));
    }
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});
