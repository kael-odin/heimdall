import pathlib, subprocess, json, hashlib, datetime, ctypes, sys
root=pathlib.Path.cwd()
out=root/'core/workspace/_runs/source-capture-diagnosis-20261018'
mask=3
set_affinity=ctypes.windll.kernel32.SetProcessAffinityMask
set_affinity.argtypes=[ctypes.c_void_p,ctypes.c_size_t]
set_affinity.restype=ctypes.c_int
assert set_affinity(ctypes.c_void_p(-1), mask), ctypes.GetLastError()
loads=[subprocess.Popen([sys.executable,'-c','import time\nend=time.monotonic()+180\nx=0\nwhile time.monotonic()<end: x=(x+1)%100003']) for _ in range(1)]
records=[]
try:
    for index in range(1,11):
        argv=['node','--test','--test-reporter=tap','--test-name-pattern=^source capture separates named sessions per flow and fails closed on missing sessions$',str(out/'diagnostic-state.test.mjs')]
        log=out/f'two-core-observation-{index:02}.log'
        start=datetime.datetime.now(datetime.timezone.utc).isoformat()
        with log.open('wb') as f: result=subprocess.run(argv,cwd=root/'core',stdout=f,stderr=subprocess.STDOUT)
        item={'index':index,'started':start,'exitCode':result.returncode,'affinityMask':mask,'loadProcesses':len(loads),'log':log.name,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()}
        records.append(item)
        (out/'two-core-observation-results.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(item),flush=True)
        if result.returncode:
            print(log.read_text(encoding='utf-8'),flush=True)
            break
finally:
    for process in loads:
        if process.poll() is None: process.terminate()
    for process in loads: process.wait()
print(json.dumps({'runs':len(records),'failures':sum(r['exitCode']!=0 for r in records)}),flush=True)
