import pathlib,json,hashlib,shutil,datetime,subprocess
root=pathlib.Path.cwd()
source=root/'core/workspace/_runs/source-capture-diagnosis-20261018'
target=root/'docs/audits/2026-10-18/evidence/source-session-local'
target.mkdir(parents=True,exist_ok=False)
files=[]
for path in sorted(source.iterdir()):
    if path.is_file():
        dst=target/path.name
        shutil.copyfile(path,dst)
        assert path.read_bytes()==dst.read_bytes()
        files.append({'path':path.name,'source':str(path),'bytes':dst.stat().st_size,'sha256':hashlib.sha256(dst.read_bytes()).hexdigest()})
extra=[(root/'core/workspace/_runs/ci-small-runner-20261018/run-source-diagnosis.py','run-source-diagnosis.py'),(root/'core/test/source-operations.test.mjs','source-test-at-validation.mjs')]
for path,name in extra:
    dst=target/name
    shutil.copyfile(path,dst)
    assert path.read_bytes()==dst.read_bytes()
    files.append({'path':name,'source':str(path),'bytes':dst.stat().st_size,'sha256':hashlib.sha256(dst.read_bytes()).hexdigest()})
runtime={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'node':subprocess.check_output(['node','--version']).decode().strip(),'python':subprocess.check_output(['python','--version']).decode().strip(),'platform':'Windows','baselineHead':'209cf405656628156952bb43f1188092b4089344','behaviorChange':False,'localFullCoreRepeated':False,'targetedNativeStats':{'tests':17,'pass':17,'fail':0,'cancelled':0,'skipped':0,'todo':0,'durationMs':14153.0037},'controlledLoad':{'affinityMask':3,'loadProcessLifetimeLimitSeconds':180,'baseline':{'runs':20,'failed':0},'oneLoadWithPostFailureObservation':{'runs':10,'failed':0},'twoLoadsWithoutPostFailureObservation':{'runs':1,'failed':1},'twoLoadsWithPostFailureObservation':{'runs':1,'failed':1}},'boundary':'Synthetic CPU saturation is not an observation of the old Linux CI load or internal flow report. Expected failures remain failures.'}
(target/'runtime.json').write_text(json.dumps(runtime,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(target/'manifest.json').write_text(json.dumps({'copiedFiles':len(files),'copiedBytes':sum(x['bytes'] for x in files),'files':files},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(target/'.gitattributes').write_text('* -text\n*.log -diff\n*.json whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol\n',encoding='utf-8')
print(json.dumps({'files':len(files),'bytes':sum(x['bytes'] for x in files),'path':str(target)}))
