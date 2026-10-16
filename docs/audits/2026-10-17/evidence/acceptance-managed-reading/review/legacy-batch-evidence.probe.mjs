import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createAcceptanceRun, finishAcceptanceRun, readAcceptanceSnapshot, readAcceptanceSnapshots } from '../../../src/acceptance/store.mjs';
import { normalizeSpecPlan } from '../../../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../../../src/acceptance/spec-runner.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-batch-review-')));
const plan = normalizeSpecPlan({ mode:'spec', name:'legacy batch freshness probe', targetUrl:'http://127.0.0.1:9',
 spec:{source:{id:'REQ-PROBE',revision:'1',type:'manual'},approved:false,checks:[{id:'contract',title:'contract',method:'GET',path:'/healthy',severity:'high',expect:{status:200}}]}});
const create = async () => { const m=createAcceptanceRun(plan,{root}); const d=join(root,m.runId); finishAcceptanceRun(m.runId,await runSpecAcceptance(plan,{runId:m.runId,outputDir:d}),{root}); return {id:m.runId,dir:d}; };
const nativeOpen = fs.openSync;
try {
 const first=await create(), second=await create();
 const initial=readAcceptanceSnapshot(first.id,{root}); assert.equal(initial.integrity.valid,true);
 const ref=Object.values(initial.report.checks[0].evidence)[0], path=join(first.dir,ref), before=sha(fs.readFileSync(path));
 let changed=false;
 fs.openSync=(pathArg,...args)=>{ if(!changed && String(pathArg)===join(second.dir,'manifest.json')) { changed=true; fs.writeFileSync(path,Buffer.from('{"tampered":true}\n')); } return nativeOpen(pathArg,...args); };
 syncBuiltinESMExports();
 const snapshots=readAcceptanceSnapshots([first.id,second.id],{root});
 fs.openSync=nativeOpen;syncBuiltinESMExports();
 const fresh=readAcceptanceSnapshot(first.id,{root});
 console.log(JSON.stringify({changedDuringLaterRun:changed,batchFirstIntegrityValid:snapshots[0].integrity.valid,batchFirstEvidenceVerified:snapshots[0].integrity.evidenceVerified,batchSecondIntegrityValid:snapshots[1].integrity.valid,evidenceBytesChanged:sha(fs.readFileSync(path))!==before,immediateFreshFirstIntegrityValid:fresh.integrity.valid,immediateFreshErrors:fresh.integrity.errors.map(e=>e.code)},null,2));
} finally { fs.openSync=nativeOpen;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true}); }