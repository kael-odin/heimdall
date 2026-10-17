"""Lossless, independently readable public D5 evidence bundles."""
from pathlib import Path
import argparse, hashlib, io, json, os, stat, tarfile, sys, uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
FINAL_OUT = ROOT / 'docs/audits/2026-10-18/evidence/defect-tickets'
parser = argparse.ArgumentParser()
parser.add_argument('--batch-directory', required=True)
args = parser.parse_args()
batch_directory = Path(args.batch_directory).resolve()
assert batch_directory.parent == HERE and batch_directory.name.startswith('batch-')
batch_path = batch_directory / 'summary.json'
batch = json.loads(batch_path.read_bytes())
expected_gates = ['build','browser','core','original','managed','d3','d4','candidates','bindings','recovery','cdp','forge','benchmark','specbenchmark','comparisonbenchmark','lint','docs']
assert batch['passed'] is True and batch['gates'] == expected_gates
assert [row['gate'] for row in batch['results']] == expected_gates
assert all(row['exitCode'] == 0 and not row.get('signal') and not row.get('error') for row in batch['results'])
final_gates = {}
for result in batch['results']:
    matches = []
    for path in HERE.glob('*/summary.json'):
        if not (path.parent / 'runner.mjs').is_file(): continue
        value = json.loads(path.read_bytes())
        if value['gate'] == result['gate'] and result['startedAt'] <= value['startedAt'] <= value['endedAt'] <= result['endedAt']:
            matches.append(path.parent)
    assert len(matches) == 1, (result['gate'], matches)
    summary = json.loads((matches[0] / 'summary.json').read_bytes())
    assert summary['exitCode'] == 0 and not summary['signal'] and not summary['error'] and summary['unchanged'] is True
    final_gates[result['gate']] = matches[0].name
core_before = json.loads((HERE / final_gates['core'] / 'summary.json').read_bytes())['before']
for gate, directory in final_gates.items():
    before = json.loads((HERE / directory / 'summary.json').read_bytes())['before']
    assert before == ([row for row in core_before if not row['file'].startswith('console/dist/')] if gate == 'build' else core_before), gate
chosen = HERE / final_gates['browser'] / 'browser'
chosen_summary = json.loads((chosen / 'summary.json').read_bytes())
assert chosen_summary['passed'] is True and chosen_summary['checkCount'] == 10 and len(chosen_summary['checks']) == 10
assert all(value is True for value in chosen_summary['checks'].values())
if FINAL_OUT.exists():
    raise SystemExit('Use an absent output directory; never replace evidence.')
OUT = HERE / ('publication-' + str(uuid.uuid4()))
OUT.mkdir(parents=True)
def digest(data):
    return hashlib.sha256(data).hexdigest()
def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
def special_entry(path, name):
    info = path.lstat()
    tag = getattr(info, 'st_reparse_tag', None)
    if not (stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400):
        return None
    kind = ('junction' if tag == 0xA0000003 else
            'symlink' if stat.S_ISLNK(info.st_mode) or tag == 0xA000000C else 'reparse')
    assert kind in ('junction', 'symlink'), ('unsupported reparse point', path, tag)
    # Preserve Python's raw substitution-target string, not a reparse buffer.
    # Never normalize this string or open the target.
    return {'file': name, 'kind': kind, 'target': os.readlink(path),
            'mode': info.st_mode, 'reparseTag': tag}
def scan(root, gate=False):
    assert special_entry(root, '.') is None and stat.S_ISDIR(root.lstat().st_mode), str(root)
    selected, specials = [], []
    def visit(directory):
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda entry: entry.name)
        for entry in children:
            path = Path(entry.path)
            name = path.relative_to(root).as_posix()
            info = path.lstat()
            # A frozen source is shared only at a gate's top level. Cache
            # exclusion applies only to named directories in gate results.
            if gate and (name == 'source' or
                         (path.name == 'chromium-profile' and stat.S_ISDIR(info.st_mode))):
                continue
            descriptor = special_entry(path, name)
            if descriptor is not None:
                specials.append(descriptor)
            elif stat.S_ISDIR(info.st_mode):
                visit(path)
            else:
                assert stat.S_ISREG(info.st_mode), ('unsupported filesystem entry', path)
                selected.append(path)
    visit(root)
    if gate:
        names = {path.relative_to(root).as_posix(): path for path in selected}
        for name in ('stdout.partial.log', 'stderr.partial.log'):
            if name in names:
                complete = names.get(name.replace('.partial', ''))
                assert complete is not None and names[name].read_bytes() == complete.read_bytes(), ('nonduplicate partial', root, name)
                selected.remove(names[name])
    return (sorted(selected, key=lambda path: path.relative_to(root).as_posix()),
            sorted(specials, key=lambda row: row['file']))
archives, source_groups, copies = [], {}, []
def copy(name, origin):
    assert special_entry(origin, name) is None and stat.S_ISREG(origin.lstat().st_mode)
    data = origin.read_bytes()
    (OUT / name).write_bytes(data)
    copies.append({'file': name, 'origin': str(origin), 'bytes': len(data), 'sha256': digest(data)})
def archive(label, root, gate=False, source=False):
    selected, specials = scan(root, gate=gate)
    assert not source or not specials, ('special entry in frozen source', root)
    target = OUT / (label + '.tar.gz')
    assert not target.exists(), ('archive name collision', target)
    rows = []
    with tarfile.open(target, 'w:gz', compresslevel=9) as handle:
        for path in selected:
            name = path.relative_to(root).as_posix()
            assert special_entry(path, name) is None and stat.S_ISREG(path.lstat().st_mode)
            data = path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            handle.addfile(info, io.BytesIO(data))
            rows.append({'file': name, 'bytes': len(data), 'sha256': digest(data)})
    with tarfile.open(target, 'r:gz') as handle:
        members = handle.getmembers()
        assert [member.name for member in members] == [row['file'] for row in rows]
        for member, row in zip(members, rows):
            data = handle.extractfile(member).read()
            assert len(data) == row['bytes'] and digest(data) == row['sha256']
            assert special_entry(root / row['file'], row['file']) is None
            assert data == (root / row['file']).read_bytes()
    after, after_specials = scan(root, gate=gate)
    assert [p.relative_to(root).as_posix() for p in selected] == [p.relative_to(root).as_posix() for p in after]
    assert specials == after_specials, ('special entry metadata changed', root)
    record = {'archive': target.name, 'origin': str(root), 'bytes': target.stat().st_size,
              'sha256': digest(target.read_bytes()), 'fileCount': len(rows), 'files': rows,
              'roundTripAndOriginalBytesVerified': True, 'specialEntries': specials,
              'specialEntryCount': len(specials), 'specialEntriesOriginalMetadataVerified': True}
    archives.append(record)
    return record

gates = []
for folder in sorted(HERE.iterdir()):
    path = folder / 'summary.json'
    if not folder.is_dir() or not path.exists() or not (folder / 'runner.mjs').exists():
        continue
    summary = json.loads(path.read_text(encoding='utf-8'))
    before = summary['before']
    source_key = digest(json.dumps(before, ensure_ascii=False, separators=(',', ':')).encode())
    source_root = folder / 'source'
    source_files, source_specials = scan(source_root)
    assert not source_specials, ('special entry in frozen source', source_root)
    actual = [{'file': p.relative_to(source_root).as_posix(), 'bytes': p.stat().st_size,
               'sha256': digest(p.read_bytes())} for p in source_files]
    assert actual == before, (folder.name, 'frozen source mismatch')
    if source_key not in source_groups:
        item = archive('source-' + source_key[:16], source_root, source=True)
        source_groups[source_key] = item['archive']
    item = archive(folder.name, folder, gate=True)
    gates.append({'gate': summary['gate'], 'directory': folder.name, 'archive': item['archive'],
                  'sourceArchive': source_groups[source_key], 'exitCode': summary['exitCode'],
                  'signal': summary['signal'], 'error': summary['error'], 'unchanged': summary['unchanged'],
                  'totals': summary['totals'], 'startedAt': summary['startedAt'], 'endedAt': summary['endedAt'],
                  'inputSha256': summary['maintainedSourceSha256'], 'finalBatchMember': folder.name in final_gates.values()})

supplemental = [(folder.name, folder) for folder in sorted(HERE.parent.glob('d5-*'))
                if folder.is_dir() and folder != HERE and not folder.name.startswith('d5-ci-')]
for label, folder in supplemental:
    assert folder.is_dir(), str(folder)
    archive(label, folder)
for name in ('run.mjs', 'all.mjs', 'collect.py', 'verify-public.py', 'verify-staged.py', 'verify-index.py', 'diagnostic-loader.mjs', 'diagnostic-provenance.json', 'verifier-review.json', 'static-review.md'):
    copy(name, HERE / name)
copy('README.md', HERE / 'public-readme.md')
for path in sorted(list(HERE.glob('staged-source-review-*.json')) + list(HERE.glob('git-index-review-*.json'))):
    copy(path.name, path)
batch_folders = [p for p in HERE.glob('batch-*') if (p / 'summary.json').exists()]
for folder in batch_folders:
    copy(folder.name + '.json', folder / 'summary.json')
for kind in ('open-desktop', 'open-mobile', 'reopened-desktop', 'reopened-mobile'):
    copy('defect-ticket-' + kind + '.png', chosen / ('defect-ticket-' + kind + '.png'))
for name in ('summary.json', 'checks.json', 'layouts.json', 'browser-errors.json', 'ticket-export.md', 'ticket-export.json'):
    copy('d5-browser-' + name, chosen / name)
write_json(OUT / 'archive-index.json', {'schemaVersion': 1, 'gates': gates, 'archives': archives,
    'sourceGroups': source_groups, 'finalBatch': {'directory': str(batch_directory), 'summarySha256': digest(batch_path.read_bytes())},
    'finalGates': final_gates, 'chosenD5GateDirectory': final_gates['browser'], 'copies': copies,
    'excluded': ['byte-identical top-level partial stdout/stderr logs in gate results', 'named chromium-profile cache directories in gate results'],
    'preserved': 'Regular file bytes and no-follow special-entry metadata; no executable tar links. Gate top-level frozen source shared by exact manifest. Supplemental roots have no cache exclusions.'})
(OUT / '.gitattributes').write_text('* -text\n', encoding='ascii')
FINAL_OUT.parent.mkdir(parents=True, exist_ok=True)
assert not FINAL_OUT.exists()
OUT.rename(FINAL_OUT)
print(json.dumps({'output': str(FINAL_OUT), 'archives': len(archives), 'gates': len(gates),
                  'archiveBytes': sum(row['bytes'] for row in archives)}, ensure_ascii=False))
