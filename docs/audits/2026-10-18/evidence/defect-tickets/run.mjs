import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..'),gate=process.argv[2];
const out=join(here,gate+'-'+randomUUID());mkdirSync(out);
const walk=directory=>readdirSync(join(root,directory),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(directory+'/'+entry.name):entry.isFile()?[directory+'/'+entry.name]:[]);
const directories=['core/src','core/scripts','core/test','console/src','console/public','config',...(gate==='build'?[]:['console/dist'])];
const fixedFiles=['package.json','pnpm-lock.yaml','core/package.json','core/pnpm-lock.yaml','console/package.json','console/pnpm-lock.yaml','console/index.html','console/vite.config.js','.github/workflows/ci.yml','docs/audits/2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json'];
const inventory=()=>[...new Set([...directories.filter(dir=>existsSync(join(root,dir))).flatMap(walk),...fixedFiles.filter(file=>existsSync(join(root,file)))])].sort();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const snapshot=()=>inventory().map(file=>{const bytes=readFileSync(join(root,file));return {file,bytes:bytes.length,sha256:hash(bytes)};});
const before=snapshot();for(const row of before){const path=join(out,'source',row.file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,readFileSync(join(root,row.file)),{flag:'wx'});}
writeFileSync(join(out,'runner.mjs'),readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
const node={lint:['core/scripts/check-syntax.mjs'],docs:['core/scripts/check-markdown-links.mjs'],core:['core/scripts/test-core.mjs'],forge:['core/scripts/smoke-forge.mjs'],
  benchmark:['core/scripts/benchmark-acceptance.mjs'],specbenchmark:['core/scripts/benchmark-acceptance-spec.mjs'],comparisonbenchmark:['core/scripts/benchmark-acceptance-comparison.mjs'],
  browser:['core/scripts/smoke-acceptance-defect-tickets-console.mjs',join(out,'browser')],
  original:['core/scripts/smoke-acceptance-console.mjs',join(out,'browser')],managed:['core/scripts/smoke-acceptance-execution-ui.mjs',join(out,'browser')],
  d3:['core/scripts/smoke-acceptance-browser-execution-console.mjs',join(out,'browser')],d4:['core/scripts/smoke-acceptance-browser-resolution-console.mjs',join(out,'browser')],
  candidates:['core/scripts/smoke-acceptance-browser-candidates-console.mjs',join(out,'browser')],bindings:['core/scripts/smoke-acceptance-browser-bindings-console.mjs','--migrate-catalog',join(out,'browser')],
  recovery:['core/scripts/smoke-acceptance-owned-recovery.mjs',join(out,'browser')],
  cdp:['core/scripts/smoke-console-cdp.mjs',join(out,'browser')]};
let cmd=process.execPath,args=node[gate],cwd=root;
if(gate==='build'){cmd=process.platform==='win32'?'cmd.exe':'pnpm';args=process.platform==='win32'?['/d','/s','/c','pnpm -C console build']:['-C','console','build'];}
if(!args)throw Error('unknown gate '+gate);
const startedAt=new Date().toISOString();console.log(JSON.stringify({event:'started',gate,startedAt,out}));
const stdout=[],stderr=[],child=spawn(cmd,args,{cwd,windowsHide:true,env:gate==='cdp'?{...process.env,HEIMDALL_E2E_CDP_SELF:'1'}:process.env});
child.stdout.on('data',bytes=>{stdout.push(Buffer.from(bytes));appendFileSync(join(out,'stdout.partial.log'),bytes);});child.stderr.on('data',bytes=>{stderr.push(Buffer.from(bytes));appendFileSync(join(out,'stderr.partial.log'),bytes);});
const result=await new Promise(resolve=>{child.once('error',cause=>resolve({exitCode:null,signal:null,error:String(cause)}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal,error:null}));});
const a=Buffer.concat(stdout),b=Buffer.concat(stderr),after=snapshot();writeFileSync(join(out,'stdout.log'),a,{flag:'wx'});writeFileSync(join(out,'stderr.log'),b,{flag:'wx'});
const tap=a.toString('utf8'),totals=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>[key,Number(new RegExp('^# '+key+' (\\d+)$','m').exec(tap)?.[1]??NaN)]));
const summary={gate,startedAt,endedAt:new Date().toISOString(),cmd,args,cwd,...result,totals,before,after,unchanged:JSON.stringify(before)===JSON.stringify(after),
  maintainedSourceSha256:hash(Buffer.from(JSON.stringify(before))),output:{stdout:{bytes:a.length,sha256:hash(a)},stderr:{bytes:b.length,sha256:hash(b)}},outputDirectory:out};
writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({gate,...result,totals,unchanged:summary.unchanged,maintainedSourceSha256:summary.maintainedSourceSha256,out}));
process.exitCode=result.exitCode===0&&!result.signal&&!result.error&&summary.unchanged?0:1;
