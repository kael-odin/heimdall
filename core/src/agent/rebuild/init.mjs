/**
 * agent/rebuild/init — 生成重建工作区（E7-01、E7-02、E7-05、E7-11，PRD 03 §4.3）
 *
 * 一条命令生成一个独立目录，它是人、代理、CI 之间的合同：
 *   AGENTS.md + CLAUDE.md（只含 @AGENTS.md）   怎么闭环、命令、红线、已知缺口
 *   heimdall.config.json                      站点、页面、dev server、视口、保真旋钮、门禁、预算
 *   .heimdall/brief|sections|ref              简报、分段计划、参考截图（整页 + 按分段裁剪）
 *   public/assets/ + public/fonts.css         原件资产与字体（来自镜像，不外链、不重画）
 *   技术栈脚手架                               html-css 或 vite-react-ts-tailwind
 * 然后初始化 git 仓库并做第一次提交（每次迭代一次提交，变差就能回退）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CORE_ROOT } from '../../paths.mjs';
import { extractTokens } from '../../extract/tokens.mjs';
import { CapabilityError } from '../envelope.mjs';
import { buildBrief, ensurePlan } from '../brief/brief.mjs';
import { ensureReference } from '../evidence/reference.mjs';
import { crop, readPng, writePng } from '../evidence/image.mjs';
import { launchBrowser } from '../evidence/capture.mjs';
import { pageDir, readManifest, requireMirror } from '../workspace.mjs';
import { STACKS, stackFiles, devCommand } from './templates.mjs';
import { renderAgentsMd } from './agents-md.mjs';
import { llmConfig } from '../llm.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** 镜像引用的 CSS 文件里的 @font-face：字体文件拷进 public/assets/fonts，url 改指本地 */
function collectFonts(mirrorClone, outFonts) {
  const html = existsSync(join(mirrorClone, 'index.html')) ? readFileSync(join(mirrorClone, 'index.html'), 'utf8') : '';
  const variants = readdirSync(mirrorClone).filter(f => /^index(-\d+)?\.html$/.test(f)).map(f => readFileSync(join(mirrorClone, f), 'utf8'));
  const cssFiles = new Set();
  for (const doc of [html, ...variants]) {
    for (const m of doc.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"'#?]+)/gi)) {
      const p = join(mirrorClone, m[1]);
      if (existsSync(p)) cssFiles.add(p);
    }
  }
  const faces = [], missing = [];
  const copied = new Map();
  for (const cssFile of cssFiles) {
    for (const block of readFileSync(cssFile, 'utf8').match(/@font-face\s*\{[^}]*\}/g) ?? []) {
      let ok = true;
      const rewritten = block.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, u) => {
        if (/^(?:https?:)?\/\//i.test(u) || u.startsWith('data:')) { if (!u.startsWith('data:')) { missing.push(u); ok = false; } return m; }
        const src = join(dirname(cssFile), u.split(/[?#]/)[0]);
        if (!existsSync(src)) { missing.push(u); ok = false; return m; }
        let name = copied.get(src);
        if (!name) {
          name = basename(src);
          if ([...copied.values()].includes(name)) name = `${sha(readFileSync(src)).slice(0, 8)}-${name}`;
          copyFileSync(src, join(outFonts, name));
          copied.set(src, name);
        }
        return `url("/assets/fonts/${name}")`;
      });
      if (ok) faces.push(rewritten);
    }
  }
  return { css: faces.join('\n') + '\n', files: copied.size, missing };
}

function tokensCssOf(cssomFile) {
  if (!existsSync(cssomFile)) return ':root {}\n';
  const t = extractTokens(readFileSync(cssomFile, 'utf8'));
  const vars = Object.entries(t.variables).sort((a, b) => b[1].count - a[1].count).slice(0, 60);
  const safe = vars.filter(([name, v]) => /^--[\w-]{1,60}$/.test(name) && !/[{};<>]/.test(v.value) && v.value.length < 200);
  return `/* 设计令牌：原站 :root 上的 CSS 变量（按使用次数取前 ${safe.length} 个）。由 heimdall rebuild init 从镜像的 CSSOM 提取。 */\n:root {\n${safe.map(([name, v]) => `  ${name}: ${v.value};`).join('\n')}\n}\n`;
}

function git(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
}

/**
 * @param {object} opts { siteId, page, url, stack, fidelity, gate, dir, port, modelClass, git:boolean, install:boolean, registry?, onProgress? }
 * @returns {Promise<object>} 结果摘要
 */
export async function initWorkspace(opts) {
  const { siteId, page, stack = 'html-css', fidelity = 'balanced', gateLevel = 'silver', port = 5199, modelClass = 'standard', onProgress = () => {} } = opts;
  if (!STACKS.includes(stack)) throw new CapabilityError('invalid_args', `技术栈只支持 ${STACKS.join(' / ')}（vite-vue3-ts-tailwind 在 Ph3）`);
  const dir = resolve(opts.dir);
  if (existsSync(dir) && readdirSync(dir).some(f => f !== '.git')) {
    throw new CapabilityError('invalid_args', `目录不是空的：${dir}`, { hint: '换一个新目录，或先清空它' });
  }
  const pdir = requireMirror(siteId, page);
  const manifest = readManifest(siteId, page);
  mkdirSync(dir, { recursive: true });
  onProgress({ stage: 'evidence', message: '测量分段与参考截图（首次约 10–30 秒）' });
  const browser = await launchBrowser();
  let plan, ref;
  try {
    plan = await ensurePlan(siteId, page, { browser });
    ref = await ensureReference(siteId, page, { browser, sections: plan.sections.map(s => ({ id: s.id, anchors: s.anchors })) });
  } finally { await browser.close().catch(() => {}); }
  const hd = join(dir, '.heimdall');
  for (const d of ['brief', 'sections', join('ref', page, 'sections'), 'runs']) mkdirSync(join(hd, d), { recursive: true });

  // 简报与分段计划（围栏后的文本，代理直接读文件即可）
  onProgress({ stage: 'brief', message: '写简报' });
  const outline = await buildBrief(siteId, page, { detail: 'outline', fidelity });
  const sections = await buildBrief(siteId, page, { detail: 'sections', fidelity });
  writeFileSync(join(hd, 'brief', `${page}.json`), JSON.stringify({ ...outline.brief, trust: outline.fence.trust(outline.untrustedPaths) }, null, 1));
  writeFileSync(join(hd, 'sections', `${page}.json`), JSON.stringify({ ...sections.brief, trust: sections.fence.trust(sections.untrustedPaths) }, null, 1));

  // 参考截图：整页 + 按分段裁剪
  onProgress({ stage: 'reference', message: '整理参考截图' });
  let crops = 0;
  for (const w of [375, 768, 1440]) {
    const src = join(ref.dir, `${w}.png`);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(hd, 'ref', page, `${w}.png`));
    const img = readPng(src);
    for (const s of plan.sections) {
      const b = s.boxes[w];
      if (!b || b.h < 2) continue;
      const y = Math.max(0, Math.floor(b.y)), h = Math.min(img.height - y, Math.ceil(b.h));
      if (h < 2) continue;
      writePng(join(hd, 'ref', page, 'sections', `${s.id}-${w}.png`), crop(img, 0, y, img.width, h));
      crops++;
    }
  }

  // 原件资产与字体
  onProgress({ stage: 'assets', message: '复制原件资产与字体' });
  const pub = join(dir, 'public');
  const assetsOut = join(pub, 'assets');
  mkdirSync(join(assetsOut, 'fonts'), { recursive: true });
  const clone = join(pdir, 'clone');
  const assetMap = readJson(join(pdir, 'asset-map.json'));
  const reverse = new Map(Object.entries(assetMap?.resMap ?? assetMap?.imgMap ?? {}).map(([url, local]) => [String(local).replace(/^\.?\//, ''), url]));
  const index = [];
  let bytes = 0;
  if (isDir(join(clone, 'assets'))) {
    for (const f of readdirSync(join(clone, 'assets'))) {
      const src = join(clone, 'assets', f);
      if (!statSync(src).isFile()) continue;
      const buf = readFileSync(src);
      copyFileSync(src, join(assetsOut, f));
      bytes += buf.length;
      index.push({ path: `/assets/${f}`, bytes: buf.length, sha256: sha(buf), original: reverse.get(`assets/${f}`) ?? null });
    }
  }
  const fonts = collectFonts(clone, join(assetsOut, 'fonts'));
  writeFileSync(join(pub, 'fonts.css'), `/* 原站字体（文件已本地化到 /assets/fonts/）。由 heimdall rebuild init 生成。 */\n${fonts.css}`);
  writeFileSync(join(assetsOut, 'assets.json'), JSON.stringify({ note: 'original 是采集时的原站地址，只作对照；页面里只引用 path（/assets/…）', assets: index }, null, 1));

  // 技术栈脚手架
  onProgress({ stage: 'scaffold', message: `生成 ${stack} 脚手架` });
  const effectiveBg = plan.pageBg ?? 'rgb(255, 255, 255)';
  const files = stackFiles(stack, {
    siteId, page, port, title: `${siteId} · ${page}（重建）`, lang: 'zh-CN', effectiveBg,
    tokensCss: tokensCssOf(join(pdir, 'cssom.css')),
    sections: plan.sections,
  });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const devUrl = `http://127.0.0.1:${port}/`;
  const config = {
    schema: 'heimdall.config/1', siteId, stack,
    devServer: { command: devCommand(stack, port), url: devUrl },
    pages: [{ name: page, route: '/', sections: 'auto' }],
    viewports: [375, 768, 1440], fidelity, modelClass,
    // 模型档位只写端点与模型名；Key 一律从环境变量读（PRD 08 §8、10 §4 R17）
    llm: llmConfig(),
    gate: { level: gateLevel }, offline: gateLevel !== 'bronze',
    budget: { maxIterationsPerSection: 4, maxIterationsPerPage: 8 },
    reference: { refId: ref.meta.refId, capturedAt: ref.meta.capturedAt, originalUrl: manifest?.target ?? null },
    createdAt: new Date().toISOString(), createdBy: 'heimdall rebuild init',
  };
  writeFileSync(join(dir, 'heimdall.config.json'), JSON.stringify(config, null, 2) + '\n');
  const cli = `node "${join(CORE_ROOT, 'src', 'cli.mjs').replace(/\\/g, '/')}"`;
  const flow = plan.sections.filter(s => !s.overlay);
  writeFileSync(join(dir, 'AGENTS.md'), renderAgentsMd({
    siteId, url: manifest?.target ?? siteId, page, stack, fidelity, gate: config.gate, budget: config.budget, cli,
    devCommand: config.devServer.command, devUrl, sections: plan.sections, overlays: plan.sections.filter(s => s.overlay),
    gaps: outline.brief.gaps ?? [],
  }));
  writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n.heimdall/runs/\n');

  // 依赖（vite 栈）：首次安装带 --ignore-scripts（PRD 08 §7：不跑第三方安装脚本）
  let install = null;
  if (stack === 'vite-react-ts-tailwind' && opts.install !== false) {
    onProgress({ stage: 'install', message: 'pnpm install --ignore-scripts（首次约 30–90 秒）' });
    const args = ['install', '--ignore-scripts', ...(opts.registry ? ['--registry', opts.registry] : [])];
    const r = process.platform === 'win32'
      ? spawnSync(`pnpm ${args.join(' ')}`, { cwd: dir, encoding: 'utf8', shell: true, windowsHide: true, timeout: 600_000 })
      : spawnSync('pnpm', args, { cwd: dir, encoding: 'utf8', timeout: 600_000 });
    install = { ok: r.status === 0, ...(r.status === 0 ? {} : { error: String(r.stderr || r.stdout || r.error?.message || '').split('\n').slice(-5).join('\n').slice(0, 500) }) };
  }

  // git：每次迭代一次提交，变差就能回退（PRD 05 §5.4）
  let gitResult = null;
  if (opts.git !== false) {
    const hasGit = git(dir, ['--version']).status === 0;
    if (hasGit) {
      git(dir, ['init', '-q']);
      git(dir, ['add', '-A']);
      const who = git(dir, ['config', 'user.email']).stdout.trim() ? [] : ['-c', 'user.name=Heimdall', '-c', 'user.email=heimdall@localhost'];
      const c = git(dir, [...who, 'commit', '-q', '-m', `heimdall rebuild init: ${siteId}/${page} (${stack}, ${fidelity}, ${gateLevel})`]);
      gitResult = { ok: c.status === 0, ...(c.status === 0 ? {} : { error: (c.stderr || c.stdout).slice(0, 300) }) };
    } else gitResult = { ok: false, error: '没有找到 git；变差回退要靠你自己备份' };
  }
  return {
    dir, siteId, page, stack, fidelity, gate: gateLevel, port, devServer: config.devServer,
    sections: plan.sections.length, flowSections: flow.length, firstSection: flow[0]?.id ?? null, referenceCrops: crops,
    assets: { files: index.length, bytes, fonts: fonts.files, fontsMissing: fonts.missing.length },
    install, git: gitResult, coverage: sections.brief.coverage,
  };
}
