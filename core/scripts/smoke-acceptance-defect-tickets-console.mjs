#!/usr/bin/env node
/** D5: real captured source -> fixed manual members -> explicit close/reopen.
 * Browser plugin not available; use the maintained repository Playwright/CDP path. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceCatalogStore } from '../src/acceptance/catalog.mjs';

const CORE = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(process.argv[2] ?? join(CORE, 'workspace/_runs/defect-tickets-console-smoke-' + randomUUID()));
assert.equal(process.argv.length <= 3, true); assert.equal(fs.existsSync(OUT), false, 'Use a fresh evidence directory.');
fs.mkdirSync(OUT, { recursive: true });
const DATA = join(OUT, 'runtime'), ROOT = join(DATA, 'acceptance'); fs.mkdirSync(DATA);
const token = 'd5-controlled-local-fixture', headers = { 'content-type': 'application/json', 'x-heimdall-token': token };
const checks = new Proxy({}, { set(target,key,value) { target[key]=value;
  fs.writeFileSync(join(OUT,'progress.json'),JSON.stringify({at:new Date().toISOString(),checks:target},null,2)+'\n');
  console.log(JSON.stringify({event:'check',name:key,passed:value,at:new Date().toISOString()})); return true; } });
const browserRequests = [], targetRequests = [], pageErrors = [], consoleMessages = [], controlledReplies = [], captures = [], layouts = [];
const startedAt = new Date().toISOString(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => fs.writeFileSync(join(OUT, name), Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const parse = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const cas = value => ({ expectedGenerationId: value.generationId, expectedRevision: value.revision });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let engine, browser, chromiumProcess, context, page, target, base, targetBase, project, candidate, source, sourceAvailable = true;
let engineLog = '', chromiumLog = '', failure;
async function waitFor(fn, label, budget = 65000) {
  const deadline = Date.now() + budget; let last;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (cause) { last = cause; } await delay(100); }
  throw new Error(label + ': ' + (last?.message ?? 'state not reached'), { cause: last });
}
async function listen(server) {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function api(path, body, status = 200) {
  const at=Date.now();
  const response = await fetch(base + '/api/acceptance/' + path, { headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const payload = await response.json();
  fs.appendFileSync(join(OUT,'http.jsonl'),JSON.stringify({path,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body}),status:response.status,elapsedMs:Date.now()-at,payload})+'\n');
  assert.equal(response.status, status, path + ': ' + JSON.stringify(payload)); return payload;
}
const latest = () => api('projects'), ticketPath = () => 'projects/' + project.id + '/defect-tickets';
const executionPath = () => 'projects/' + project.id + '/browser-executions';
const fullTicketPath = () => '/api/acceptance/' + ticketPath();
const component = () => page.getByTestId('defect-tickets'), panel = () => page.getByTestId('acceptance-catalog');
const posts = () => browserRequests.filter(value => value.method === 'POST' && value.path.startsWith(fullTicketPath()));
function tree(root) {
  const output = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [name, fact] of Object.entries(tree(path))) output[entry.name + '/' + name] = fact;
    else { assert.equal(entry.isFile(), true); const bytes = fs.readFileSync(path); output[entry.name] = { bytes: bytes.length, sha256: hash(bytes) }; }
  }
  return output;
}
const originals = () => ({ catalog: hash(fs.readFileSync(join(ROOT, 'catalog.json'))), browser: tree(join(ROOT, 'browser-operations')) });
function html({ visual = false, behavior = false } = {}) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>D5 controlled acceptance</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial;background:#eef2f6;color:#172438}header{padding:16px 24px;background:#172438;color:white;display:flex;justify-content:space-between}main{max-width:900px;padding:24px;margin:auto}button,input{font:inherit;padding:8px}.panel{height:250px;padding:24px;border:1px solid #bbc9d7;background:' + (visual ? '#8d2b10;color:white;transform:translateY(60px)' : 'white') + '}nav[hidden]{display:none}nav{padding:12px;background:#d6e8ff}@media(max-width:500px){main{padding:16px}input{max-width:100%}}</style></head><body><header><strong>NORTHSTAR</strong><button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button></header><main><h1>Fixed manual defect members</h1><nav id="menu" hidden>Expanded navigation</nav><section class="panel"><h2>Captured approved source</h2><label>Test entry <input id="entry"></label><p id="literal">d5-captured-source-sentinel</p></section></main><script>document.querySelector("#menu-toggle").addEventListener("click",function(){' + (behavior ? 'return;' : 'const menu=document.querySelector("#menu");menu.hidden=!menu.hidden;this.setAttribute("aria-expanded",String(!menu.hidden))') + '})</script></body></html>';
}
async function startEngine() {
  if (!base) { const socket = createServer(); base = await listen(socket); await close(socket); }
  engine = spawn(process.execPath, ['src/engine-server.mjs', new URL(base).port], { cwd: CORE, windowsHide: true,
    env: { ...process.env, HEIMDALL_DATA_DIR: DATA, HEIMDALL_CONSOLE_DIR: resolve(CORE, '../console/dist'),
      HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: token, HEIMDALL_LLM: '0' }, stdio: ['ignore','pipe','pipe'] });
  const child = engine;
  child.stdout.on('data', bytes => { engineLog += bytes; }); child.stderr.on('data', bytes => { engineLog += bytes; });
  await waitFor(async () => { if (child.exitCode !== null) throw Error(engineLog); return (await fetch(base + '/api/status', { headers })).ok; }, 'fixed-port engine ready');
}
async function startBrowser() {
  const profile = join(OUT, 'chromium-profile'); fs.mkdirSync(profile);
  chromiumProcess = spawn(chromium.executablePath(), ['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0','--user-data-dir=' + profile,'--no-first-run','--no-default-browser-check','about:blank'],
    { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  chromiumProcess.stdout.on('data', bytes => { chromiumLog += bytes; }); chromiumProcess.stderr.on('data', bytes => { chromiumLog += bytes; });
  const active = join(profile, 'DevToolsActivePort');
  await waitFor(() => fs.existsSync(active) && fs.readFileSync(active,'utf8').split('\n')[0], 'CDP ready');
  const cdp = 'http://127.0.0.1:' + fs.readFileSync(active,'utf8').split('\n')[0];
  save('cdp-version.json', await (await fetch(cdp + '/json/version')).json()); browser = await chromium.connectOverCDP(cdp);
  context = await browser.newContext({ viewport: { width:1440,height:1000 }, reducedMotion:'reduce', extraHTTPHeaders:{'x-heimdall-token':token} });
  await context.addInitScript(value => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('heimdall-token',value); },token);
  page = await context.newPage(); page.setDefaultTimeout(60000);
  page.on('pageerror', cause => pageErrors.push(cause.message));
  page.on('console', message => { if (['warning','error'].includes(message.type())) consoleMessages.push({type:message.type(),text:message.text(),location:message.location()}); });
  page.on('request', request => { const url=new URL(request.url()); if (url.pathname.startsWith('/api/acceptance/')) browserRequests.push({method:request.method(),path:url.pathname,
    ...(request.method()==='POST'?{body:request.postDataJSON()}:{} )}); });
}
async function openConsole() {
  await page.goto(base,{waitUntil:'networkidle'}); await page.getByRole('button',{name:'项目验收',exact:true}).click();
  await panel().getByTestId('catalog-toggle').click(); await panel().locator('[name="catalog-project"]').selectOption(project.id);
  await component().waitFor(); await waitFor(async()=>!(await panel().getByTestId('catalog-refresh').isDisabled()),'catalog ready');
  await component().getByTestId('defect-tickets-toggle').click();
}
async function operation(release, beforeOperationId=null) {
  const input={...cas(await latest()),operationId:'bo-'+randomUUID(),candidateId:candidate.id,contentDigest:candidate.contentDigest,targetReleaseId:release.id};
  await api(executionPath(),input,202);
  await waitFor(async()=>{const value=await api(executionPath()+'/'+input.operationId);return value.state==='completed'&&value;},'real completed Browser operation',90000);
  const report=await api(executionPath()+'/'+input.operationId+'/report');
  await api(executionPath()+'/'+input.operationId+'/register-result',beforeOperationId?{beforeOperationId}:{});
  return {input,report};
}
async function refreshTicket(ticketId) {
  await component().getByTestId('defect-tickets-refresh').click();
  await waitFor(async()=>!(await component().getByTestId('defect-tickets-refresh').isDisabled()),'complete ticket list refresh');
  const open=component().locator('[data-testid="defect-ticket-open"][data-ticket-id="'+ticketId+'"]');
  await waitFor(async()=>!(await open.isDisabled()),'ticket list refreshed');await open.click();
  await waitFor(async()=>(await component().getByTestId('defect-ticket-detail').innerText()).includes(ticketId),'exact ticket detail rendered');
}
async function uiStatus(handling,verification,passed) {
  await waitFor(async()=>await component().getByTestId('defect-ticket-handling').innerText()==='人工处理：'+handling
    && await component().getByTestId('defect-ticket-verification').innerText()==='当前核验：'+verification,'real rendered handling and verification');
  assert.equal((await component().locator('.verification-summary > strong').innerText()).trim(),passed+' / 2');
}
async function previewClose(afterOperationId) {
  await component().getByTestId('defect-ticket-preview').click();
  await component().getByTestId('defect-ticket-confirm').waitFor();
  await waitFor(async()=>await component().getByTestId('defect-ticket-after').innerText()===afterOperationId,'preview pins latest registered after');
}
async function closeTicket({loseReply=false}={}) {
  await component().getByTestId('defect-ticket-resolution').fill('两项固定检查均已在当前登记中通过。');
  await component().getByTestId('defect-ticket-confirm').check();
  const button=component().getByTestId('defect-ticket-close');await waitFor(async()=>!(await button.isDisabled()),'explicit close ready');
  const pattern='**'+fullTicketPath()+'/*/close';
  const handler=async route=>{const response=await route.fetch();assert.equal(response.status(),201);controlledReplies.push({kind:'lost-close',status:502,path:new URL(route.request().url()).pathname});await route.fulfill({status:502,contentType:'text/html',body:'<title>Controlled lost close response</title>'});};
  if(loseReply)await page.route(pattern,handler);
  const count=posts().length;await button.click();await waitFor(()=>posts().length===count+1&&posts().at(-1).body,'one explicit close POST');
  const request=posts().at(-1).body;
  if(loseReply){await waitFor(()=>controlledReplies.some(value=>value.kind==='lost-close'),'lost close reply observed');await page.unroute(pattern,handler);
    await waitFor(async()=>await component().getByTestId('defect-ticket-error').isVisible()&&await component().getAttribute('aria-busy')==='false','stable unknown close response');}
  return request;
}
async function reconcile(actionId) {
  const button=component().locator('[data-testid="defect-ticket-reconcile"][data-action-id="'+actionId+'"]');
  await waitFor(async()=>await button.count()===1&&!(await button.isDisabled()),'read-only reconciliation ready');
  const count=posts().length;await button.click();
  await waitFor(async()=>await button.count()===0,'exact recorded receipt reconciled');assert.equal(posts().length,count,'reconciliation never POSTs');
}
async function capture(name,width,height,theme) {
  await page.setViewportSize({width,height});await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  const anchor=component().getByTestId('defect-ticket-detail');await anchor.scrollIntoViewIfNeeded();await anchor.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));
  const layout=await component().evaluate(element=>({documentWidth:document.documentElement.scrollWidth,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,text:element.innerText}));
  assert.ok(layout.clientWidth>0&&layout.documentWidth<=width+1&&layout.scrollWidth<=layout.clientWidth+1,JSON.stringify(layout));
  layouts.push({name,width,height,theme,...layout});captures.push(name+'.png');await page.screenshot({path:join(OUT,name+'.png'),fullPage:false});save(name+'-dom.txt',layout.text);
}
console.log(JSON.stringify({event:'started',startedAt,outputDirectory:OUT}));
try {
  assert.equal(fs.existsSync(resolve(CORE,'../console/dist/index.html')),true,'Build console first.');
  const owner=acquireAcceptanceOwner({root:ROOT});try{await createAcceptanceCatalogStore({root:ROOT,owner}).initialize({createSchemaVersion:4});}finally{owner.release();}
  target=createServer((request,response)=>{const path=new URL(request.url,'http://fixture.invalid').pathname;targetRequests.push({method:request.method,path,at:new Date().toISOString()});
    const missing=path.startsWith('/source')&&!sourceAvailable;response.writeHead(missing?410:200,{'content-type':'text/html'});
    response.end(missing?'Source intentionally unavailable after capture':html({visual:/^\/(broken|regressed)/.test(path),behavior:/^\/(broken|partial|regressed)/.test(path)}));});
  targetBase=await listen(target);save('controlled-source.html',html());save('controlled-bug.html',html({visual:true,behavior:true}));await startEngine();
  const plan={name:'D5 fixed manual defect closure',mode:'regression',baselineUrl:targetBase+'/source?token=d5-source-url-sentinel',targetUrl:targetBase+'/broken',routes:['/'],
    viewports:[{name:'desktop',width:960,height:640},{name:'mobile',width:375,height:812}],timeoutMs:4000,settleMs:50,
    points:[{id:'menu',title:'Expanded menu',route:'/',severity:'high',steps:[{action:'fill',selector:'#entry',value:'d5-fill-sentinel'},{action:'click',selector:'#menu-toggle'}],
      assertions:[{kind:'visible',selector:'#menu'},{kind:'attribute',selector:'#menu-toggle',attribute:'aria-expanded',equals:'true'},{kind:'text',selector:'#literal',equals:'d5-captured-source-sentinel'}]}]};
  source=await api('runs',plan,202);await waitFor(async()=>(await api('runs/'+source.runId)).status==='completed','fresh source captured',90000);
  const sourceReport=await api('runs/'+source.runId+'/report');assert.equal(sourceReport.gate,'failed');assert.equal(sourceReport.checks.length,14);
  project=(await api('projects',{...cas(await latest()),name:'D5 fixed manual defect tickets'},201)).project;
  const release=(await api('projects/'+project.id+'/releases',{...cas(await latest()),label:'Approved captured source',targetUrl:plan.baselineUrl},201)).release;
  const binding=(await api('projects/'+project.id+'/browser-source-bindings',{...cas(await latest()),releaseId:release.id,runId:source.runId,sourceSide:'baseline'},201)).binding;
  const review=await api('projects/'+project.id+'/browser-source-bindings/'+binding.id+'/candidate-preview');
  candidate=(await api('projects/'+project.id+'/browser-baseline-candidates',{...cas(await latest()),sourceBindingId:binding.id,contentDigest:review.contentDigest},201)).candidate;
  const releases={};for(const path of ['broken','partial','healthy','regressed'])releases[path]=(await api('projects/'+project.id+'/releases',{...cas(await latest()),label:path,targetUrl:targetBase+'/'+path},201)).release;
  const sourceBytes=tree(join(ROOT,source.runId)),sourceRequestsBeforeUnavailable=targetRequests.filter(value=>value.path.startsWith('/source')).length;sourceAvailable=false;
  const bad=await operation(releases.broken), badChecks=bad.report.report.checks;
  const selected=[badChecks.find(check=>check.identity.facet==='visual'&&check.viewport==='desktop'&&check.verdict==='bug'),badChecks.find(check=>check.identity.facet==='behavior'&&check.viewport==='desktop'&&check.verdict==='bug')];
  assert.ok(selected.every(Boolean));assert.equal(new Set(selected.map(check=>check.id)).size,2);checks.realSourceAndRegisteredVisualBehaviorFailures=true;
  const initialOriginals=originals(),initialTargetCount=targetRequests.length;
  await startBrowser();await openConsole();assert.equal(await page.url(),base+'/');assert.ok((await page.title()).length>0);assert.equal(await page.locator('vite-error-overlay').count(),0);
  await component().getByTestId('defect-tickets-candidate').selectOption(candidate.id);
  await component().getByTestId('defect-tickets-source').selectOption(bad.input.operationId);
  for(const check of selected)await component().locator('[data-testid="defect-ticket-member"][data-check-id="'+check.id+'"]').check();
  await component().getByTestId('defect-ticket-title').fill('菜单还原的两个固定检查');await component().getByTestId('defect-ticket-description').fill('Compare dashboard?session=EXPORT_SENTINEL and //user:password@example.test/path?token=OTHER_SENTINEL');
  await component().getByTestId('defect-ticket-reproduction').fill('打开固定页面并展开菜单，核对布局与行为。');await component().getByTestId('defect-ticket-severity').selectOption('high');
  await component().getByTestId('defect-ticket-create-confirm').check();
  const createPattern='**'+fullTicketPath(),loseCreate=async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();assert.equal(response.status(),201);
    controlledReplies.push({kind:'lost-create',status:502,path:new URL(route.request().url()).pathname});await route.fulfill({status:502,contentType:'text/html',body:'<title>Controlled lost create response</title>'});};
  await page.route(createPattern,loseCreate);await component().getByTestId('defect-ticket-create').click();await waitFor(()=>posts().length===1&&posts()[0].body,'one manual create');
  const create=posts()[0].body;await waitFor(()=>controlledReplies.some(value=>value.kind==='lost-create'),'lost create observed');await page.unroute(createPattern,loseCreate);
  await waitFor(async()=>await component().getByTestId('defect-ticket-error').isVisible()&&await component().getAttribute('aria-busy')==='false','stable unknown creation response');
  assert.deepEqual([...create.memberCheckIds].sort(),selected.map(check=>check.id).sort());await openConsole();assert.equal(posts().length,1,'reload cannot repeat original write');await reconcile(create.actionId);
  await refreshTicket(create.ticketId);assert.equal((await api(ticketPath()+'/'+create.ticketId)).ticket.processingStatus,'open');await uiStatus('待处理','仍有可靠失败',0);assert.deepEqual(originals(),initialOriginals);assert.equal(targetRequests.length,initialTargetCount);
  checks.fixedMembersAndLostCreateReconcileAfterReloadWithoutPost=true;
  await capture('defect-ticket-open-desktop',1440,1000,'light');await capture('defect-ticket-open-mobile',390,844,'dark');await page.setViewportSize({width:1440,height:1000});
  const partial=await operation(releases.partial,bad.input.operationId);await refreshTicket(create.ticketId);await previewClose(partial.input.operationId);
  await uiStatus('待处理','部分检查通过',1);
  const partialPreview=(await api(ticketPath()+'/'+create.ticketId+'/close-preview?afterOperationId='+partial.input.operationId)).preview;save('partial-preview.json',partialPreview);
  assert.equal(partialPreview.closeEligible,false);assert.equal(partialPreview.counts.passed,1);assert.equal(partialPreview.counts.failed,1);assert.equal(await component().getByTestId('defect-ticket-close').isDisabled(),true);checks.partialRepairCannotCloseFixedMemberSet=true;
  const healthy=await operation(releases.healthy,partial.input.operationId);await refreshTicket(create.ticketId);await previewClose(healthy.input.operationId);const beforeClose=originals(),beforeTarget=targetRequests.length;
  const firstClose=await closeTicket({loseReply:true});await reconcile(firstClose.actionId);await refreshTicket(create.ticketId);
  let ticket=(await api(ticketPath()+'/'+create.ticketId)).ticket;assert.equal(ticket.processingStatus,'closed');assert.equal(ticket.verificationStatus,'verified_passed');assert.equal(ticket.revision,1);
  await uiStatus('已明确关闭','关联检查已复验通过',2);
  assert.deepEqual(originals(),beforeClose);assert.equal(targetRequests.length,beforeTarget);checks.allMembersRequireExplicitCloseAndLostCloseUsesOnlyGet=true;
  const regressed=await operation(releases.regressed,healthy.input.operationId);await refreshTicket(create.ticketId);ticket=(await api(ticketPath()+'/'+create.ticketId)).ticket;assert.equal(ticket.processingStatus,'reopened');assert.ok(ticket.reopenReasons.length>=2);
  await uiStatus('再次发现','仍有可靠失败',0);
  await capture('defect-ticket-reopened-desktop',1440,1000,'dark');await capture('defect-ticket-reopened-mobile',390,844,'light');await page.setViewportSize({width:1440,height:1000});
  const healthyAgain=await operation(releases.healthy,regressed.input.operationId);await refreshTicket(create.ticketId);ticket=(await api(ticketPath()+'/'+create.ticketId)).ticket;assert.equal(ticket.processingStatus,'reopened');assert.equal(ticket.verificationStatus,'verified_passed');
  await uiStatus('再次发现','关联检查已复验通过',2);
  checks.reliableFailureReopensAndLaterPassDoesNotAutoClose=true;
  await previewClose(healthyAgain.input.operationId);const newest=await operation(releases.healthy,healthyAgain.input.operationId);
  const stale=await closeTicket();await waitFor(async()=>/已变化|重新预览/.test(await component().innerText()),'definite stale rejection visible');
  await waitFor(async()=>await component().getAttribute('aria-busy')==='false','definite rejection settled');
  assert.equal(await component().getByTestId('defect-ticket-resolution').inputValue(),'两项固定检查均已在当前登记中通过。');
  assert.equal(await component().getByTestId('defect-ticket-confirm').isChecked(),false);assert.equal(await component().getByTestId('defect-ticket-close').isDisabled(),true);
  const rejected=await api(ticketPath()+'/actions/'+stale.actionId);assert.equal(rejected.outcome,'unresolved');
  assert.equal(await component().locator('[data-testid="defect-ticket-reconcile"][data-action-id="'+stale.actionId+'"]').count(),0,'definite original 409 does not leave unknown pending');
  controlledReplies.push({kind:'stale-facts',status:409,path:fullTicketPath()+'/'+create.ticketId+'/close'});
  await refreshTicket(create.ticketId);await previewClose(newest.input.operationId);await closeTicket();await waitFor(async()=>(await api(ticketPath()+'/'+create.ticketId)).ticket.processingStatus==='closed','new explicit close');await refreshTicket(create.ticketId);
  checks.definiteStalePostRetainsDraftAndRequiresFreshExplicitPreview=true;
  for(const format of ['md','json']){const download=page.waitForEvent('download');await component().getByTestId('defect-ticket-export-'+format).click();const artifact=await download;
    assert.equal(artifact.suggestedFilename(),create.ticketId+'.'+format);const path=join(OUT,'ticket-export.'+format);await artifact.saveAs(path);const text=fs.readFileSync(path,'utf8');
    assert.equal(/EXPORT_SENTINEL|OTHER_SENTINEL|user:password/.test(text),false);if(format==='json'){const value=JSON.parse(text);assert.equal(value.handling.status,'closed');assert.equal(value.history.length,3);assert.equal(value.verification.repairVerified,true);}}
  checks.markdownAndJsonDownloadsPreserveHistoryAndOmitRecognizedSecrets=true;
  const persisted=await api(ticketPath()+'/'+create.ticketId),persistedOriginals=originals(),restartTargetCount=targetRequests.length;
  // Leave the polling view before the deliberately offline restart window.
  // Keep the context and its durable confirmations; collect every later error.
  await page.goto('about:blank');await stop(engine);await startEngine();assert.deepEqual(await api(ticketPath()+'/'+create.ticketId),persisted);await openConsole();await refreshTicket(create.ticketId);
  assert.equal(targetRequests.length,restartTargetCount);assert.deepEqual(originals(),persistedOriginals);checks.restartReadsExactTicketWithoutStartingOrRegisteringBrowserWork=true;
  const storage=await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage},hrefs:[...document.querySelectorAll('a[href]')].map(element=>element.getAttribute('href'))}));
  assert.equal(/d5-source-url-sentinel|d5-fill-sentinel|d5-captured-source-sentinel/.test(JSON.stringify(storage)),false);save('browser-storage.json',storage);
  assert.deepEqual(tree(join(ROOT,source.runId)),sourceBytes);assert.equal(targetRequests.filter(value=>value.path.startsWith('/source')).length,sourceRequestsBeforeUnavailable,'only original baseline capture visits source');
  for(const message of consoleMessages){const path=new URL(message.location.url,base).pathname;
    assert.ok(message.type==='error'&&controlledReplies.some(reply=>reply.path===path&&message.text.includes(String(reply.status))),JSON.stringify(message));}
  assert.equal(pageErrors.length,0);assert.equal(await page.locator('vite-error-overlay').count(),0);checks.renderedDesktopMobileAndOriginalSourceIntegrity=true;checks.consoleErrorsAreOnlyTheExplicitControlledHttpFailures=true;
  save('final-ticket.json',await api(ticketPath()+'/'+create.ticketId));save('ticket-events.json',tree(join(ROOT,'defect-tickets')));save('source-file-digests.json',sourceBytes);
} catch(cause){failure=cause;save('failure.json',{name:cause.name,message:cause.message,stack:cause.stack});if(page){await page.screenshot({path:join(OUT,'failure.png'),fullPage:false}).catch(()=>{});save('failure-dom.txt',await page.locator('body').innerText().catch(()=>'unavailable'));}}
finally{
  await browser?.close().catch(()=>{});await stop(chromiumProcess);await stop(engine);await close(target);
  save('engine.log',engineLog);save('chromium.log',chromiumLog);save('browser-requests.json',browserRequests);save('target-requests.json',targetRequests);save('browser-errors.json',{pageErrors,consoleMessages,controlledReplies});save('checks.json',checks);save('layouts.json',layouts);
  const summary={startedAt,endedAt:new Date().toISOString(),passed:!failure,checkCount:Object.keys(checks).length,checks,captures,outputDirectory:OUT,
    evidenceLevel:'real-local-chromium-fixed-captured-source-explicit-manual-ticket-lifecycle',browserPath:'Browser plugin not available; repository Playwright/CDP',
    pageErrors,consoleMessageCount:consoleMessages.length,controlledReplyCount:controlledReplies.length,...(failure?{failure:{message:failure.message}}:{})};
  save('summary.json',summary);console.log(JSON.stringify(summary));if(failure)process.exitCode=1;
}
