import datetime, hashlib, json, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[4]
OUT = pathlib.Path(__file__).resolve().parent
REL = 'docs/audits/2026-10-18/evidence/defect-ticket-ci-timeout'
def sha(data): return hashlib.sha256(data).hexdigest()
def blob(ref): return subprocess.check_output(['git', 'cat-file', 'blob', ref], cwd=ROOT)
manifest = json.loads((ROOT / REL / 'manifest.json').read_text(encoding='utf-8'))
checks = []
for item in manifest['files']:
    path = REL + '/' + item['path']
    values = [pathlib.Path(item['source']).read_bytes(), (ROOT / path).read_bytes(), blob(':' + path)]
    checks.append({'path':path,'bytes':item['bytes'],'sha256':item['sha256'],
        'passed':all(len(data) == item['bytes'] and sha(data) == item['sha256'] for data in values)})
protected = ['core/src/acceptance/' + p + '.mjs' for p in ['browser-operation-schema','browser-operation-store','browser-fixed-contract','browser-fixed-runner','runner','identity','report']] + ['core/src/verify/compare.mjs']
for path in protected:
    original = blob('a0f834ebe727d6d00e2d692a008d3d0512a56536:' + path)
    checks.append({'path':path,'sha256':sha(original),'passed':blob('HEAD:' + path) == blob(':' + path) == (ROOT / path).read_bytes() == original})
report = {'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archiveFiles':len(manifest['files']),
    'archiveBytes':sum(item['bytes'] for item in manifest['files']),'checks':checks,'passed':all(c['passed'] for c in checks)}
(OUT / 'archive-index.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'passed':report['passed'],'checks':len(checks),'archiveFiles':report['archiveFiles'],'archiveBytes':report['archiveBytes']}))
raise SystemExit(0 if report['passed'] else 1)
