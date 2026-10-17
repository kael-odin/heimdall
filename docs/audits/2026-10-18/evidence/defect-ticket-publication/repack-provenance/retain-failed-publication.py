"""Relocate one failed public bundle without changing any contained bytes."""
from pathlib import Path
import datetime, hashlib, json, os, stat

here = Path(__file__).resolve().parent
root = here.parents[3]
source = root / 'docs/audits/2026-10-18/evidence/defect-tickets'
destination = here / 'failed-publication-crlf-20261017T2119Z'
report = here / 'failed-publication-relocation-20261017T2119Z.json'
assert source.resolve(strict=True) == source
assert source.parent == root / 'docs/audits/2026-10-18/evidence'
assert destination.parent.resolve(strict=True) == here
assert not destination.exists() and not report.exists()

def inventory(base):
    rows = []
    for directory, folders, files in os.walk(base, followlinks=False):
        for name in folders:
            info = (Path(directory) / name).lstat()
            assert stat.S_ISDIR(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400)
        for name in files:
            path = Path(directory) / name
            info = path.lstat()
            assert stat.S_ISREG(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400)
            raw = path.read_bytes()
            rows.append({'file': path.relative_to(base).as_posix(), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    return sorted(rows, key=lambda row: row['file'])

before = inventory(source)
assert (source / '.gitattributes').read_bytes() == b'* -text\r\n'
index_sha = hashlib.sha256((source / 'archive-index.json').read_bytes()).hexdigest()
assert index_sha == 'd9abae28dbafad19ea80950989e2d70b5c21727fd99ff0b174e706b0e8342ef4'
source.rename(destination)
assert inventory(destination) == before and not source.exists()
value = {'status': 'retained-failed-publication', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'previousPath': str(source), 'retainedPath': str(destination), 'filesUnchanged': True,
    'archiveIndexSha256': index_sha, 'attributeHex': '2a202d746578740d0a', 'files': before,
    'independentFailure': str(here / 'independent-public-review-59df8ca2-ae60-4a6a-b0d3-5098a6603293'),
    'reason': 'Windows text-mode translation produced CRLF; verifier requires exact LF. Product inputs and gates unchanged.'}
with report.open('xb') as handle:
    handle.write((json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())
print(json.dumps({'retained': str(destination), 'report': str(report), 'files': len(before), 'filesUnchanged': True}))
