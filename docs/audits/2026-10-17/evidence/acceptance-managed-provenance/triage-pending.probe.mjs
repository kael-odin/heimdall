import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createAcceptanceRun,finishAcceptanceRun} from './core/src/acceptance/store.mjs';
import {runSpecAcceptance} from './core/src/acceptance/spec-runner.mjs';
const parent=fs.mkdtempSync(join(tmpdir(),'heimdall-triage-quarantine-probe-')),root=join(parent,'acceptance');
fs.mkdirSync(root);
let child,model,modelCalls=0,modelReply,resolveModel;
const modelReached=new Promise(resolve=>{resolveModel=resolve;});
try{
 const plan={name:'triage await quarantine probe',mode:'spec',targetUrl:'http://127.0.0.1:1',spec:{source:{id:'REQ',revision:'v1'},approved:false,checks:[{id:'HEALTH',title:'health',path:'/health',method:'GET',expect:{status:200}}]}};
 const run=createAcceptanceRun(plan,{root}),dir=join(root,run.runId);
 const raw=await runSpecAcceptance(run.plan,{runId:run.runId,outputDir:dir});finishAcceptanceRun(run.runId,raw,{root});
 const reportFile=join(dir,'report.json'),manifestFile=join(dir,'manifest.json'),originalReport=fs.readFileSync(reportFile),manifestBefore=fs.readFileSync(manifestFile);
 model=createServer((req,res)=>{modelCalls++;let body='';req.on('data',bytes=>body+=bytes);req.on('end',()=>{modelReply=res;resolveModel();});});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 child=spawn(process.execPath,['src/engine-server.mjs',String(port)],{cwd:join(process.cwd(),'core'),env:{...process.env,HEIMDALL_DATA_DIR:parent,HEIMDALL_HOST:'127.0.0.1',HEIMDALL_TOKEN:'',HEIMDALL_CONSOLE_DIR:'',HEIMDALL_ENV_FILE:join(parent,'absent.env'),HEIMDALL_LLM:'1',LLM_BASE_URL:'http://127.0.0.1:'+model.address().port+'/v1',LLM_API_KEY:'probe-key',LLM_MODEL:'probe',LLM_MODEL_FAST:'probe',LLM_PROTOCOL:'chat',LLM_MAX_RETRIES:'0'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
 const base='http://127.0.0.1:'+port;
 const deadline=Date.now()+15000;let ready=false;
 while(Date.now()<deadline){if(child.exitCode!==null)throw Error('engine exited: '+output);try{const response=await fetch(base+'/api/status');if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,30));}
 assert.equal(ready,true,output);
 const mutate=()=>{const report=JSON.parse(originalReport);report.managed=null;fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');};
 mutate();
 const before=await fetch(base+'/api/acceptance/runs/'+run.runId+'/triage',{method:'POST'});assert.equal(before.status,503);assert.equal((await before.json()).code,'MANAGED_EXECUTION_REQUIRED');assert.equal(modelCalls,0);
 fs.writeFileSync(reportFile,originalReport);
 const pending=fetch(base+'/api/acceptance/runs/'+run.runId+'/triage',{method:'POST'});
 await Promise.race([modelReached,new Promise((_,reject)=>setTimeout(()=>reject(Error('local model not reached')),10000))]);
 mutate();modelReply.setHeader('content-type','application/json');modelReply.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'probe explanation',items:[]})}}]}));
 const after=await pending;assert.equal(after.status,503);assert.equal((await after.json()).code,'MANAGED_EXECUTION_REQUIRED');
 assert.equal(modelCalls,1);assert.equal(fs.existsSync(join(dir,'triage.json')),false);assert.deepEqual(fs.readFileSync(manifestFile),manifestBefore);
 console.log(JSON.stringify({beforeAwait:{status:503,modelCalls:0},afterAwait:{status:503,code:'MANAGED_EXECUTION_REQUIRED'},totalModelCalls:modelCalls,triageWritten:false,manifestUnchanged:true}));
}finally{
 if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
 if(model)await new Promise(resolve=>model.close(resolve));
 fs.rmSync(parent,{recursive:true,force:true});
}
