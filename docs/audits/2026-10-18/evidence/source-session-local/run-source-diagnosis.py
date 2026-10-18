import pathlib, subprocess, json, hashlib, datetime
root = pathlib.Path.cwd()
out = root / 'core/workspace/_runs/source-capture-diagnosis-20261018'
out.mkdir(parents=True, exist_ok=True)
original = (root/'core/test/source-operations.test.mjs').read_text(encoding='utf-8')
probe = original.replace("'../src/", "'../../../src/").replace("assert.equal(report.flows[0].passed, true);", "assert.equal(report.flows[0].passed, true, JSON.stringify(report.flows[0]));")
(out/'diagnostic.test.mjs').write_text(probe, encoding='utf-8')
records=[]
for index in range(1, 21):
    argv=['node','--test','--test-reporter=tap','--test-name-pattern=^source capture separates named sessions per flow and fails closed on missing sessions$',str(out/'diagnostic.test.mjs')]
    log=out/f'baseline-{index:02}.log'
    start=datetime.datetime.now(datetime.timezone.utc).isoformat()
    with log.open('wb') as f:
        result=subprocess.run(argv,cwd=root/'core',stdout=f,stderr=subprocess.STDOUT)
    item={'index':index,'started':start,'exitCode':result.returncode,'sha256':hashlib.sha256(log.read_bytes()).hexdigest(),'log':log.name}
    records.append(item)
    (out/'baseline-results.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(item),flush=True)
print(json.dumps({'runs':len(records),'failures':sum(r['exitCode']!=0 for r in records)}),flush=True)
