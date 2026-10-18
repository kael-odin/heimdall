"""Copy a frozen, previously verified CI failure without normalizing its bytes."""
import datetime
import hashlib
import json
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
old = Path(r'C:\Users\44548\.codex\worktrees\defect-ticket-closure-d5\heimdall\core\workspace\_runs')
inventory_path = old / 'ci-catalog-failure-20261018' / 'evidence-inventory.json'
inventory_bytes = inventory_path.read_bytes()
assert hashlib.sha256(inventory_bytes).hexdigest() == '929ba5429dd8d7ff99b2eabaf0b2470477553d71cb648926e2e680b2a46db0ab'
inventory = json.loads(inventory_bytes)
destination = repo / 'docs/audits/2026-10-18/evidence/catalog-ci-failure'
destination.mkdir(exist_ok=False)
mapping = {
    'ci-final': 'final-20261018T005401.151239Z',
    'original-verification': 'verification-20261018T005440.596276Z',
    'original-tools': 'tools',
    'new-diagnostic-excluding-this-inventory': 'diagnosis',
}
entries = []

def copy(source, relative, expected_bytes=None, expected_sha=None):
    assert not source.is_symlink() and source.is_file(), str(source)
    assert '..' not in relative.parts and not relative.is_absolute()
    raw = source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    assert expected_bytes is None or len(raw) == expected_bytes, str(source)
    assert expected_sha is None or digest == expected_sha, str(source)
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as output:
        output.write(raw)
    assert target.read_bytes() == raw
    entries.append({'path': relative.as_posix(), 'bytes': len(raw), 'sha256': digest, 'source': str(source)})

for group in inventory['groups']:
    assert len(group['files']) == group['fileCount']
    assert sum(entry['bytes'] for entry in group['files']) == group['bytes']
    source_root = Path(group['sourceRoot'])
    for entry in group['files']:
        relative = Path(entry['path'])
        copy(source_root / relative, Path(mapping[group['label']]) / relative, entry['bytes'], entry['sha256'])
copy(inventory_path, Path('diagnosis/evidence-inventory.json'))
assert len(entries) == 99
assert sum(entry['bytes'] for entry in entries) == 5361160
manifest = {'schemaVersion': 1, 'runId': 39082419484, 'attempt': 1,
    'headSha': '41c359a62ecbb67ac15f38c51c95fa983a7492d3',
    'frozenAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'originalFileCount': len(entries), 'originalBytes': sum(entry['bytes'] for entry in entries),
    'allCopiedBytesVerified': True, 'files': entries}
(destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(destination / '.gitattributes').write_text('# Preserve every frozen original byte, including CRLF.\n* -text\n', encoding='utf-8')
print(json.dumps({key: value for key, value in manifest.items() if key != 'files'}, ensure_ascii=False, indent=2))
