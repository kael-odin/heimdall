from pathlib import Path
import datetime, hashlib, json, sys, zipfile
BASE = Path(__file__).resolve().parent
ZIP = BASE / 'artifact-original.zip'
EXPECTED = '10947b600a60da1c800ebfcd5e344eaac434610024e56ebf675c9c5bc4d02894'
now = datetime.datetime.now(datetime.timezone.utc)
OUT = BASE / ('dom-relay-diagnosis-' + now.strftime('%Y%m%dT%H%M%S%fZ'))
OUT.mkdir(exist_ok=False)
def sha(data): return hashlib.sha256(data).hexdigest()
def put(name, data):
    with (OUT / name).open('xb') as handle: handle.write(data)
    if (OUT / name).read_bytes() != data: raise ValueError('Written bytes mismatch')
raw = ZIP.read_bytes()
if sha(raw) != EXPECTED: raise ValueError('Bound ZIP hash mismatch')
selected = {}
with zipfile.ZipFile(ZIP) as archive:
    for basename in ['failure-dom.txt', 'A-create-unknown-desktop-light-dom.txt', 'relay-state-events.json', 'relay.jsonl']:
        member = 'core/workspace/_runs/defect-ticket-decisions-ci/' + basename
        data = archive.read(member)
        put(basename, data)
        selected[member] = {'file': basename, 'bytes': len(data), 'sha256': sha(data)}
manifest = {'kind': 'raw-artifact-dom-relay-diagnosis-not-ci-acceptance', 'argv': sys.argv,
    'sourceScriptSha256': sha(Path(__file__).read_bytes()), 'runId': 39096514869, 'attempt': 1,
    'headSha': '06e4303871d485a14b66d24318db80595a3db774', 'artifactId': 12124333500,
    'sourceZIP': str(ZIP), 'sourceZIPBytes': len(raw), 'sourceZIPSha256': sha(raw),
    'createdAt': now.isoformat(), 'selected': selected, 'directory': str(OUT)}
put('dom-relay-diagnosis-manifest.json', (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
print(str(OUT))
for basename in ['failure-dom.txt', 'A-create-unknown-desktop-light-dom.txt', 'relay-state-events.json', 'relay.jsonl']:
    print('\nFILE ' + basename + '\n' + (OUT / basename).read_text(encoding='utf-8'))
