"""Compare every changed staged Git blob with the actual workspace bytes."""
from pathlib import Path
import datetime, hashlib, json, subprocess
here=Path(__file__).resolve().parent
root=here.parents[3]
names=subprocess.run(['git','diff','--cached','--name-only','--diff-filter=ACMRT','-z'],cwd=root,capture_output=True,check=True).stdout.decode().split('\0')
names=[name for name in names if name]
payload=subprocess.run(['git','cat-file','--batch'],cwd=root,input=''.join(':'+name+'\n' for name in names).encode(),capture_output=True,check=True).stdout
checks=[]; offset=0
for name in names:
    end=payload.index(b'\n',offset); header=payload[offset:end].split()
    if len(header)!=3 or header[1]!=b'blob': raise ValueError((name,header))
    size=int(header[2]); blob=payload[end+1:end+1+size]; offset=end+size+2
    raw=(root/name).read_bytes()
    checks.append({'file':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
                   'gitBlobSha256':hashlib.sha256(blob).hexdigest(),'equal':blob==raw})
if offset!=len(payload): raise ValueError('Unparsed batch output')
passed=all(row['equal'] for row in checks)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
out=here/('git-index-review-'+stamp+'.json')
out.write_text(json.dumps({'passed':passed,'count':len(checks),'files':checks},indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':passed,'count':len(checks),'report':str(out)}))
raise SystemExit(0 if passed else 1)
