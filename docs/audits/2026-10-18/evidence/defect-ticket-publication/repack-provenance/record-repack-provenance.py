"""Publish the preserved CRLF failure and exact collector correction provenance."""
from pathlib import Path
import datetime, hashlib, json

here = Path(__file__).resolve().parent
root = here.parents[3]
failed = here / 'failed-publication-crlf-20261017T2119Z'
public = root / 'docs/audits/2026-10-18/evidence/defect-tickets'
out = root / 'docs/audits/2026-10-18/evidence/defect-ticket-publication/repack-provenance'
assert failed.is_dir() and public.is_dir() and not out.exists()
old = (failed / 'collect.py').read_bytes()
new = (here / 'collect.py').read_bytes()
assert old.replace(b"write_text('* -text\\n', encoding='ascii')", b"write_bytes(b'* -text\\n')") == new
assert (failed / '.gitattributes').read_bytes() == b'* -text\r\n'
assert (public / '.gitattributes').read_bytes() == b'* -text\n'
out.mkdir()
(out / '.gitattributes').write_bytes(b'* -text\n')
copies = []
for name, source in [
    ('failed-publication-relocation.json', here / 'failed-publication-relocation-20261017T2119Z.json'),
    ('original-attributes.bin', failed / '.gitattributes'),
    ('original-archive-index.json', failed / 'archive-index.json'),
    ('original-collect.py', failed / 'collect.py'),
    ('fixed-collect.py', here / 'collect.py'),
    ('retain-failed-publication.py', here / 'retain-failed-publication.py'),
    ('record-repack-provenance.py', Path(__file__).resolve()),
]:
    raw = source.read_bytes()
    target = out / name
    with target.open('xb') as handle:
        handle.write(raw)
    assert target.read_bytes() == raw
    copies.append({'file': name, 'source': str(source), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
result = {'status': 'exact-collector-line-ending-correction',
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'oldCollectorSha256': hashlib.sha256(old).hexdigest(), 'newCollectorSha256': hashlib.sha256(new).hexdigest(),
    'onlyExpectedReplacement': True, 'oldAttributeHex': '2a202d746578740d0a', 'newAttributeHex': '2a202d746578740a',
    'failedIndexSha256': hashlib.sha256((failed / 'archive-index.json').read_bytes()).hexdigest(),
    'currentIndexSha256': hashlib.sha256((public / 'archive-index.json').read_bytes()).hexdigest(),
    'copies': copies,
    'scope': 'The entire original 88-file failed bundle remains at the retained local path. These public copies document the failure, exact correction and full relocation inventory; they do not duplicate all previous compressed archives. Product inputs and the completed 17-gate batch are unchanged.'}
with (out / 'collector-change.json').open('xb') as handle:
    handle.write((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode())
print(json.dumps({'output': str(out), 'files': len(copies), 'onlyExpectedReplacement': True, 'currentIndexSha256': result['currentIndexSha256']}))
