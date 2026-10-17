from pathlib import Path
import datetime, hashlib, json, re, zipfile

ROOT=Path.cwd()
OUT=Path(__file__).resolve().parent
PUBLIC=ROOT/'docs/audits/2026-10-17/evidence/acceptance-browser-d3-ci-5d1de82'
SHA='5d1de82ac31fa48ef45ed0746591fbd0c710d264'
RUN=39044519602

def encode(value):return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()
def digest(value):return hashlib.sha256(value).hexdigest()
def new(file,value):
    file.parent.mkdir(parents=True,exist_ok=True)
    with file.open('xb') as stream:stream.write(value)
def read(name):return (OUT/name).read_bytes()
def step_log(number):
    matches=list((OUT/'logs/core (lint + test)').glob(str(number)+'_*.txt'))
    assert len(matches)==1,(number,matches)
    return matches[0]
def stats(file):
    values=dict(re.findall(r'(?m)^.*?Z # (tests|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)\s*$',file.read_text(encoding='utf-8')))
    assert set(values)=={'tests','pass','fail','cancelled','skipped','todo','duration_ms'}
    return {key:float(value) if key=='duration_ms' else int(value) for key,value in values.items()}

run=json.loads(read('run.json'));jobs=json.loads(read('jobs.json'))
assert run['head_sha']==SHA and run['id']==RUN and run['run_attempt']==1 and run['status']=='completed' and run['conclusion']=='success'
assert jobs['total_count']==len(jobs['jobs'])==3 and all(job['conclusion']=='success' and job['status']=='completed' for job in jobs['jobs'])
core_job=next(job for job in jobs['jobs'] if job['name']=='core (lint + test)')
smokes=[step for step in core_job['steps'] if 12<=step['number']<=29]
assert len(smokes)==18 and all(step['conclusion']=='success' and step['status']=='completed' for step in smokes)
assert next(step for step in core_job['steps'] if step['number']==31)['conclusion']=='success'
core=stats(step_log(11));docker=stats(step_log(31))
assert core['tests']==core['pass']+core['skipped'] and core['fail']==core['cancelled']==core['todo']==0
assert docker['tests']==docker['pass']==2 and docker['fail']==docker['cancelled']==docker['skipped']==docker['todo']==0
skips=re.findall(r'(?m)^.*?Z ok \d+ - (.+) # SKIP\s*$',step_log(11).read_text(encoding='utf-8'))
assert len(skips)==core['skipped']
owner='owner loss actively closes pending navigation without waiting for its browser timeout'
assert re.search(r'(?m)^.*?Z ok \d+ - '+re.escape(owner)+r'\s*$',step_log(11).read_text(encoding='utf-8'))
events=[]
for line in step_log(29).read_text(encoding='utf-8').splitlines():
    match=re.match(r'^\S+Z (\{.*\})$',line)
    if match:
        event=json.loads(match.group(1))
        if event.get('status')=='passed':events.append(event)
assert len(events)==1 and events[0]['checks']==16
with zipfile.ZipFile(OUT/'run-logs.zip') as archive:
    assert archive.testzip() is None
    for entry in archive.infolist():
        if not entry.is_dir():assert archive.read(entry)==read('logs/'+entry.filename)
summary={'schemaVersion':1,'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'headSha':SHA,'runId':RUN,'runAttempt':run['run_attempt'],'status':run['status'],'conclusion':run['conclusion'],
 'createdAt':run['created_at'],'updatedAt':run['updated_at'],'url':run['html_url'],
 'jobs':[{'id':job['id'],'name':job['name'],'status':job['status'],'conclusion':job['conclusion']} for job in jobs['jobs']],
 'core':core,'coreSkippedCases':skips,'ownerLossPreviouslyCancelledCasePassed':True,
 'acceptanceSmokeSteps':[{'number':step['number'],'name':step['name'],'status':step['status'],'conclusion':step['conclusion'],'log':step_log(step['number']).relative_to(OUT).as_posix()} for step in smokes],
 'browserExecutionSmoke':events[0],'docker':docker,
 'scope':'Exact D3 hotfix commit hosted Linux CI; does not substitute uncommitted D4 or a later commit CI.'}
new(OUT/'verified-summary.json',encode(summary))
assert not PUBLIC.exists(),'New CI publication must not replace any existing directory.'
PUBLIC.mkdir(parents=True)
originals=[]
for file in sorted(OUT.rglob('*')):
    if not file.is_file():continue
    assert not file.is_symlink()
    name=file.relative_to(OUT).as_posix();data=file.read_bytes()
    new(PUBLIC/name,data)
    originals.append({'path':name,'bytes':len(data),'sha256':digest(data),'sourcePath':file.relative_to(ROOT).as_posix()})
copies=[]
for name,file in [('core-test.stdout.log',step_log(11)),('browser-execution.stdout.log',step_log(29)),('docker.stdout.log',step_log(31))]:
    data=file.read_bytes();new(PUBLIC/name,data)
    copies.append({'path':name,'originalPath':file.relative_to(OUT).as_posix(),'bytes':len(data),'sha256':digest(data)})
new(PUBLIC/'.gitattributes',b'* -text\n')
note=('# 5d1de82 hotfix 自身 CI 原件\n\n'
      +'精确提交 `'+SHA+'`，run `'+str(RUN)+'`，attempt 1；工作流及三个 job 均 success。\n\n'
      +f"完整 Core：{core['tests']} total / {core['pass']} pass / {core['fail']} fail / {core['cancelled']} cancelled / {core['skipped']} skipped；18 组 acceptance smokes 全部 success，D3 执行 smoke 原日志为 16 checks passed；显式 Docker 为 2/2、0 skipped。\n\n"
      +'`run.json`、`jobs.json` 为完整 API 响应；`complete-stdout.log` 为 gh 完整日志；`run-logs.zip` 为 GitHub 原始日志包，`logs/` 为逐成员原字节展开。`verified-summary.json` 从原日志和 API 交叉提取结果。`INDEX.json` 为每个原件、可读副本及辅助文件记录 bytes/SHA；索引自身不自引用。\n\n'
      +'两个 Windows 专用用例在 Linux 跳过；完整 Core 内两项 Docker 未启环境也跳过，后续显式 HEIMDALL_DOCKER_TEST=1 步骤两项实际通过。条件性失败诊断上传步骤因成功而 skipped，不属于测试跳过或上述18项smokes。\n\n'
      +'此目录只追加本次 hotfix CI；此前 e3cc0ee failure 和既有 D3 ZIP 保持原样，不嵌套旧69MB包。不代表 D4 尚未提交改动或将来提交的 hosted CI。\n').encode()
new(PUBLIC/'INDEX.md',note)
aux=[]
for name in ('.gitattributes','INDEX.md'):
    data=(PUBLIC/name).read_bytes();aux.append({'path':name,'bytes':len(data),'sha256':digest(data)})
index={'schemaVersion':1,'headSha':SHA,'runId':RUN,'originals':originals,'readableCopies':copies,'auxiliaryFiles':aux,
       'checks':{'rawLogZipCRC':True,'allExtractedLogBytesEqualZip':True,'apiAndTestSummaryCrossChecked':True,'originalSourceBytesEqualCopies':True}}
new(PUBLIC/'INDEX.json',encode(index))
expected={'INDEX.json',*[row['path'] for row in originals],*[row['path'] for row in copies],*[row['path'] for row in aux]}
assert {file.relative_to(PUBLIC).as_posix() for file in PUBLIC.rglob('*') if file.is_file()}==expected
for row in originals:
    data=(PUBLIC/row['path']).read_bytes()
    assert len(data)==row['bytes'] and digest(data)==row['sha256'] and data==(ROOT/row['sourcePath']).read_bytes()
for row in copies+aux:
    data=(PUBLIC/row['path']).read_bytes();assert len(data)==row['bytes'] and digest(data)==row['sha256']
result={'passed':True,'public':PUBLIC.relative_to(ROOT).as_posix(),'originalFiles':len(originals),'readableCopies':len(copies),'publicFiles':len(expected),'core':core,'docker':docker,'acceptanceSmokes':len(smokes)}
new(OUT/'publication-result.json',encode(result))
print(json.dumps(result,ensure_ascii=False))
