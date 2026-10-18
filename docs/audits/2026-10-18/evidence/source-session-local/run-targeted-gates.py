import pathlib, subprocess, json, hashlib, datetime
root=pathlib.Path.cwd()
out=root/'core/workspace/_runs/source-capture-diagnosis-20261018'
paths=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
names=[p for p in paths if p and (p.startswith(('core/src/','core/scripts/','core/test/','console/src/','.github/')) or p in ['package.json','core/package.json','core/pnpm-lock.yaml','console/package.json','console/pnpm-lock.yaml','console/vite.config.js'])]
def inputs(): return {p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in names}
def write(name,value): (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
start=inputs();write('inputs-before.json',start)
results=[]
for name,argv,cwd in [('source-operations',['node','--test','--test-reporter=tap','test/source-operations.test.mjs'],root/'core'),('lint',['node','scripts/check-syntax.mjs'],root/'core'),('docs',['node','scripts/check-markdown-links.mjs'],root/'core')]:
    at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    with (out/(name+'.log')).open('wb') as f: result=subprocess.run(argv,cwd=cwd,stdout=f,stderr=subprocess.STDOUT)
    item={'name':name,'argv':argv,'cwd':str(cwd),'started':at,'ended':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result.returncode,'logSha256':hashlib.sha256((out/(name+'.log')).read_bytes()).hexdigest()}
    results.append(item);write('targeted-gates.json',{'complete':False,'results':results});print(json.dumps(item),flush=True)
    if result.returncode: break
end=inputs();write('inputs-after.json',end)
passed=len(results)==3 and all(r['exitCode']==0 for r in results) and start==end
write('targeted-gates.json',{'complete':True,'passed':passed,'results':results,'inputCount':len(start),'inputsUnchanged':start==end})
print(json.dumps({'passed':passed,'inputCount':len(start),'inputsUnchanged':start==end}),flush=True)
raise SystemExit(0 if passed else 1)
