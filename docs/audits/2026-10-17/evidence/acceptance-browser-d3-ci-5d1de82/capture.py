from pathlib import Path, PurePosixPath
from concurrent.futures import ThreadPoolExecutor
import datetime, hashlib, json, subprocess, zipfile

OUT=Path(__file__).resolve().parent
REPO='kael-odin/heimdall'
RUN='39044519602'
HEAD='5d1de82ac31fa48ef45ed0746591fbd0c710d264'

def new(name,data):
    file=OUT/name;file.parent.mkdir(parents=True,exist_ok=True)
    with file.open('xb') as stream:stream.write(data)

def record(name,args,output):
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    run=subprocess.run(args,capture_output=True)
    new(output,run.stdout);new(name+'.stderr.log',run.stderr)
    new(name+'.command.json',(json.dumps({'command':args,'startedAt':started,'endedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':run.returncode},indent=2)+'\n').encode())
    assert run.returncode==0,(name,run.returncode,run.stderr.decode('utf-8','replace'))
    return output

jobs=[
 ('run',['gh','api',f'repos/{REPO}/actions/runs/{RUN}'],'run.json'),
 ('jobs',['gh','api',f'repos/{REPO}/actions/runs/{RUN}/jobs?per_page=100'],'jobs.json'),
 ('full-log',['gh','run','view',RUN,'--repo',REPO,'--log'],'complete-stdout.log'),
 ('logs-zip',['gh','api',f'repos/{REPO}/actions/runs/{RUN}/logs'],'run-logs.zip'),
]
with ThreadPoolExecutor(max_workers=4) as executor:
    for result in executor.map(lambda values:record(*values),jobs):print(result,flush=True)
run=json.loads((OUT/'run.json').read_bytes());job_data=json.loads((OUT/'jobs.json').read_bytes())
assert run['head_sha']==HEAD and run['status']=='completed' and run['conclusion']=='success'
assert job_data['total_count']==len(job_data['jobs'])==3
assert all(job['status']=='completed' and job['conclusion']=='success' for job in job_data['jobs'])
zip_rows=[]
with zipfile.ZipFile(OUT/'run-logs.zip') as archive:
    assert archive.testzip() is None
    names=set()
    for entry in archive.infolist():
        name=entry.filename
        if entry.is_dir():continue
        assert not PurePosixPath(name).is_absolute() and '\\' not in name and ':' not in name and all(part not in ('','.','..') for part in name.split('/'))
        assert name.casefold() not in names;names.add(name.casefold())
        data=archive.read(entry);new('logs/'+name,data)
        zip_rows.append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
new('capture-summary.json',(json.dumps({'passed':True,'runId':int(RUN),'headSha':HEAD,'status':run['status'],'conclusion':run['conclusion'],'jobs':[{'id':job['id'],'name':job['name'],'conclusion':job['conclusion']} for job in job_data['jobs']],'zipCRC':True,'logFiles':zip_rows},ensure_ascii=False,indent=2)+'\n').encode())
print(json.dumps({'captured':True,'directory':str(OUT),'logEntries':len(zip_rows),'headSha':HEAD,'conclusion':run['conclusion']}),flush=True)
