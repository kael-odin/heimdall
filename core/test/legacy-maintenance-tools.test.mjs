/**
 * 旧产物维护工具的安全边界：只在临时目录中验证计划、预览、修复和备份。
 * 这些测试不读取或改写 core/workspace 下的真实历史产物。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { planFullshots } = await import('../src/crawler/fullshot.mjs');
const { planCssRefRepair, repairCssFile } = await import('../src/crawler/repair-css-refs.mjs');
const CORE = fileURLToPath(new URL('..', import.meta.url));
const REPAIR_CLI = fileURLToPath(new URL('../src/crawler/repair-css-refs.mjs', import.meta.url));
const FULLSHOT_CLI = fileURLToPath(new URL('../src/crawler/fullshot.mjs', import.meta.url));

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

test('fullshot 计划只收集缺图且同源的旧页面，并跳过坏 manifest', () => {
  const root = temp('heimdall-fullshot-plan-');
  const site = join(root, 'workspace');
  const pages = join(site, 'example.com', 'pages');
  try {
    const makePage = (name, manifest) => {
      const dir = join(pages, name);
      mkdirSync(dir, { recursive: true });
      if (manifest !== undefined) writeFileSync(join(dir, 'manifest.json'), manifest);
      return dir;
    };
    makePage('home', JSON.stringify({ target: 'https://example.com/' }));
    const present = makePage('present', JSON.stringify({ target: 'https://example.com/present' }));
    writeFileSync(join(present, 'shot-src-full.png'), 'existing');
    makePage('foreign', JSON.stringify({ target: 'https://evil.example/' }));
    makePage('broken', '{not-json');
    makePage('missing');

    const plan = planFullshots({ workspace: site, host: 'example.com' });
    assert.deepEqual(plan.targets.map(item => item.name), ['home']);
    assert.equal(plan.targets[0].url, 'https://example.com/');
    assert.deepEqual(plan.skipped.map(item => item.name).sort(), ['broken', 'foreign', 'missing']);
    assert.match(plan.skipped.find(item => item.name === 'foreign').reason, /origin-mismatch/);
    assert.equal(existsSync(join(pages, 'home', 'shot-src-full.png')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fullshot 拒绝路径穿越 site ID，并忽略跨目录符号链接', () => {
  const root = temp('heimdall-fullshot-boundary-');
  const site = join(root, 'workspace');
  const outside = join(root, 'outside');
  try {
    assert.throws(() => planFullshots({ workspace: site, host: '../outside' }), /站点 ID 不安全/);
    mkdirSync(join(site, 'safe.test', 'pages'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const linked = join(site, 'safe.test', 'pages', 'linked');
    try {
      symlinkSync(outside, linked, 'junction');
      const plan = planFullshots({ workspace: site, host: 'safe.test' });
      assert.equal(plan.targets.some(item => item.name === 'linked'), false);
      assert.equal(lstatSync(linked).isSymbolicLink(), true);
    } catch (error) {
      // Windows without symlink privilege still exercises the path traversal guard above.
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fullshot CLI 默认预览，不启动浏览器或创建截图', () => {
  const root = temp('heimdall-fullshot-cli-');
  const page = join(root, 'workspace', 'example.com', 'pages', 'home');
  try {
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://example.com/' }));
    const result = spawnSync(process.execPath, [FULLSHOT_CLI, 'example.com'], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run/);
    assert.match(result.stdout, /home https:\/\/example\.com\//);
    assert.equal(existsSync(join(page, 'shot-src-full.png')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fullshot 拒绝与 origin 摘要不符的 sibling 站点目录', () => {
  const root = temp('heimdall-fullshot-sibling-');
  const workspace = join(root, 'workspace');
  const siteId = 'example.com--origin-0000000000000000';
  const page = join(workspace, siteId, 'pages', 'home');
  try {
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://example.com:8443/' }));
    assert.throws(() => planFullshots({ workspace, host: siteId }), /origin 摘要与目录名不符/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair-css-refs dry-run 不写盘，正式修复保留 query/hash 并可备份', () => {
  const root = temp('heimdall-repair-css-');
  const clone = join(root, 'workspace', 'example.com', 'pages', 'home', 'clone');
  const styles = join(clone, 'styles');
  const assets = join(clone, 'assets');
  const backup = join(root, 'backup');
  const cssFile = join(styles, 'cssom.css');
  try {
    mkdirSync(styles, { recursive: true });
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'ref001.woff2'), 'font');
    writeFileSync(join(assets, 'theme.css'), 'body{}');
    const original = 'a{src:url("assets/ref001.woff2?v=7#font")}@import "assets/theme.css?rev=2#theme";';
    writeFileSync(cssFile, original);

    const preview = repairCssFile(cssFile, { dryRun: true, base: join(root, 'workspace', 'example.com') });
    assert.equal(preview.fixed, 2);
    assert.equal(readFileSync(cssFile, 'utf8'), original);

    const applied = repairCssFile(cssFile, { backupDir: backup, base: join(root, 'workspace', 'example.com') });
    assert.equal(applied.fixed, 2);
    const repaired = readFileSync(cssFile, 'utf8');
    assert.match(repaired, /url\("\.\.\/assets\/ref001\.woff2\?v=7#font"\)/);
    assert.match(repaired, /@import "\.\.\/assets\/theme\.css\?rev=2#theme"/);
    assert.equal(readFileSync(join(backup, 'pages', 'home', 'clone', 'styles', 'cssom.css'), 'utf8'), original);

    const second = repairCssFile(cssFile, { dryRun: true });
    assert.equal(second.fixed, 0, '修复必须幂等');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair-css-refs 计划跳过符号链接样式目录，并拒绝不安全 site ID', () => {
  const root = temp('heimdall-repair-boundary-');
  const workspace = join(root, 'workspace');
  try {
    assert.throws(() => planCssRefRepair({ workspace, host: '..\\escape' }), /站点 ID 不安全/);
    const page = join(workspace, 'example.com', 'pages', 'home', 'clone');
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(page, { recursive: true });
    try {
      symlinkSync(outside, join(page, 'styles'), 'junction');
      const plan = planCssRefRepair({ workspace, host: 'example.com' });
      assert.equal(plan.files.length, 0);
      assert.ok(plan.skipped.some(item => item.reason === 'unsafe-style-dir'));
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair CLI 默认只预览；--apply 自动在数据目录外备份后修复', () => {
  const root = temp('heimdall-repair-cli-');
  const css = join(root, 'workspace', 'example.com', 'pages', 'home', 'clone', 'styles', 'cssom.css');
  const asset = join(root, 'workspace', 'example.com', 'pages', 'home', 'clone', 'assets', 'ref001.woff2');
  const original = 'a{src:url("assets/ref001.woff2?v=7")}';
  const run = (...args) => spawnSync(process.execPath, [REPAIR_CLI, 'example.com', ...args], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 10_000,
  });
  try {
    mkdirSync(join(root, 'workspace', 'example.com', 'pages', 'home', 'clone', 'styles'), { recursive: true });
    mkdirSync(join(root, 'workspace', 'example.com', 'pages', 'home', 'clone', 'assets'), { recursive: true });
    writeFileSync(css, original);
    writeFileSync(asset, 'font');

    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /would-fix.*1/);
    assert.equal(readFileSync(css, 'utf8'), original);

    const workspace = join(root, 'workspace');
    const denied = run('--apply', '--backup-dir', workspace);
    assert.equal(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /备份目录不能在 workspace 内/);
    assert.equal(readFileSync(css, 'utf8'), original);
    try {
      const alias = join(root, 'workspace-alias');
      symlinkSync(workspace, alias, 'junction');
      const linked = run('--apply', '--backup-dir', alias);
      assert.equal(linked.status, 2, linked.stderr);
      assert.match(linked.stderr, /备份目录不能在 workspace 内/);
      assert.equal(readFileSync(css, 'utf8'), original);

      const backup = join(root, 'linked-backup');
      mkdirSync(backup);
      symlinkSync(workspace, join(backup, 'pages'), 'junction');
      const nested = run('--apply', '--backup-dir', backup);
      assert.equal(nested.status, 1, nested.stderr);
      assert.match(nested.stderr, /backup path entered workspace/);
      assert.equal(readFileSync(css, 'utf8'), original);
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    }

    const applied = run('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /backups:/);
    assert.match(readFileSync(css, 'utf8'), /\.\.\/assets\/ref001\.woff2\?v=7/);
    const maintenanceRoot = join(root, '_maintenance');
    const backupDirs = existsSync(maintenanceRoot) ? readdirSync(maintenanceRoot) : [];
    assert.equal(backupDirs.length, 1);
    const backup = join(maintenanceRoot, backupDirs[0], 'pages', 'home', 'clone', 'styles', 'cssom.css');
    assert.equal(readFileSync(backup, 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
