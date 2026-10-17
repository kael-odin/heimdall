import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const out=join(here,'batch-'+randomUUID());mkdirSync(out);
const gates=['build','browser','core','original','managed','d3','d4','candidates','bindings','recovery','cdp','forge','benchmark','specbenchmark','comparisonbenchmark','lint','docs'];
const summary={startedAt:new Date().toISOString(),gates,results:[],passed:false};
for(const gate of gates){
  const startedAt=new Date().toISOString();
  const child=spawn(process.execPath,[join(here,'run.mjs'),gate],{windowsHide:true,stdio:'inherit'});
  const result=await new Promise(resolve=>{child.once('error',cause=>resolve({exitCode:null,error:String(cause)}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
  summary.results.push({gate,startedAt,endedAt:new Date().toISOString(),...result});
  writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  if(result.exitCode!==0||result.signal||result.error){process.exitCode=1;break;}
}
summary.endedAt=new Date().toISOString();summary.passed=summary.results.length===gates.length&&summary.results.every(result=>result.exitCode===0&&!result.signal&&!result.error);
writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({batchDirectory:out,...summary}));
