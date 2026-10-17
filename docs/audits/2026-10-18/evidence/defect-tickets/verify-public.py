"""Independent, read-only D5 public evidence verification. Never imports collect.py.

Run only after collection and all final gates have completed. No tests, Browser,
engine, repair or extraction is started. The report directory must be absent.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
GATES = ['build', 'browser', 'core', 'original', 'managed', 'd3', 'd4', 'candidates',
         'bindings', 'recovery', 'cdp', 'forge', 'benchmark',
         'specbenchmark', 'comparisonbenchmark', 'lint', 'docs']
CHECKS = [
    'realSourceAndRegisteredVisualBehaviorFailures',
    'fixedMembersAndLostCreateReconcileAfterReloadWithoutPost',
    'partialRepairCannotCloseFixedMemberSet',
    'allMembersRequireExplicitCloseAndLostCloseUsesOnlyGet',
    'reliableFailureReopensAndLaterPassDoesNotAutoClose',
    'definiteStalePostRetainsDraftAndRequiresFreshExplicitPreview',
    'markdownAndJsonDownloadsPreserveHistoryAndOmitRecognizedSecrets',
    'restartReadsExactTicketWithoutStartingOrRegisteringBrowserWork',
    'renderedDesktopMobileAndOriginalSourceIntegrity',
    'consoleErrorsAreOnlyTheExplicitControlledHttpFailures',
]
CAPTURES = ['defect-ticket-open-desktop.png', 'defect-ticket-open-mobile.png',
            'defect-ticket-reopened-desktop.png', 'defect-ticket-reopened-mobile.png']
VERIFIERS = ['core/src/acceptance/' + name for name in [
    'browser-operation-schema.mjs', 'browser-operation-store.mjs',
    'browser-fixed-contract.mjs', 'browser-fixed-runner.mjs', 'runner.mjs',
    'identity.mjs', 'report.mjs']] + ['core/src/verify/compare.mjs']
BASELINE = '5006e16bf73e47f36877da24df4ac4a5c8207965'
INPUT_DIRS = ['core/src', 'core/scripts', 'core/test', 'console/src',
              'console/public', 'config', 'console/dist']
INPUT_FILES = ['package.json', 'pnpm-lock.yaml', 'core/package.json',
               'core/pnpm-lock.yaml', 'console/package.json',
               'console/pnpm-lock.yaml', 'console/index.html',
               'console/vite.config.js', '.github/workflows/ci.yml',
               'docs/audits/2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json']
SUPPLEMENTAL = ['d5-backend-freeze-20261018', 'd5-engine-20261018',
                'd5-console-helper-20261018', 'd5-console-state-build-20261018']


def need(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def hash_file(path):
    need(link_metadata(path, path.name) is None and stat.S_ISREG(path.lstat().st_mode),
         'Refuse hashing a special/nonregular file: ' + str(path))
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def compact(value):
    # Manifests contain only ASCII path strings, safe integer sizes and hashes.
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def read_json(path):
    need(link_metadata(path, path.name) is None and stat.S_ISREG(path.lstat().st_mode),
         'Refuse reading a special/nonregular JSON file: ' + str(path))
    return json.loads(path.read_bytes().decode('utf-8'))


def stamp(value):
    need(isinstance(value, str) and value.endswith('Z'), 'Invalid UTC timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def relative_name(value):
    need(isinstance(value, str) and value and '\\' not in value,
         'Invalid relative archive/copy name')
    path = PurePosixPath(value)
    need(not path.is_absolute() and all(p not in ('', '.', '..') and ':' not in p
                                      for p in path.parts), 'Unsafe archive/copy name: ' + value)
    need(path.as_posix() == value, 'Noncanonical archive/copy name: ' + value)
    return value


def link_metadata(path, name):
    info = path.lstat()
    tag = getattr(info, 'st_reparse_tag', None)
    if not (stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400):
        return None
    if tag == 0xA0000003:
        kind = 'junction'
    elif tag == 0xA000000C or stat.S_ISLNK(info.st_mode):
        kind = 'symlink'
    else:
        raise AssertionError('Unsupported reparse point: ' + str(path))
    return {'file': name, 'kind': kind, 'target': os.readlink(path),
            'mode': info.st_mode, 'reparseTag': tag}


def inventory(root, gate=False, special_entries=None):
    """Independent inventory; public/source roots have no profile exclusions.

    Only a gate's top-level frozen source is shared. A nested directory called
    source is evidence and is retained. Completed duplicate partial logs are
    omitted only after proving their byte identity with the complete logs.
    """
    need(link_metadata(root, '.') is None and stat.S_ISDIR(root.lstat().st_mode),
         'Unsafe/missing origin: ' + str(root))
    result, specials = [], []
    for directory, dirs, names in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in list(dirs):
            item = parent / name
            rel = item.relative_to(root).as_posix()
            info = item.lstat()
            if gate and (rel == 'source' or
                         (name == 'chromium-profile' and stat.S_ISDIR(info.st_mode))):
                dirs.remove(name)
                continue
            descriptor = link_metadata(item, rel)
            if descriptor is not None:
                dirs.remove(name)
                specials.append(descriptor)
            else:
                need(stat.S_ISDIR(info.st_mode), 'Non-directory traversal entry: ' + str(item))
        for name in names:
            item = parent / name
            rel = item.relative_to(root).as_posix()
            descriptor = link_metadata(item, rel)
            if descriptor is not None:
                specials.append(descriptor)
                continue
            need(stat.S_ISREG(item.lstat().st_mode), 'Nonregular original: ' + str(item))
            if gate and rel in ('stdout.partial.log', 'stderr.partial.log'):
                complete = root / rel.replace('.partial', '')
                need(link_metadata(complete, complete.name) is None
                     and stat.S_ISREG(complete.lstat().st_mode)
                     and item.stat().st_size == complete.stat().st_size
                     and hash_file(item) == hash_file(complete), 'Partial log is not a duplicate: ' + str(item))
                continue
            result.append(rel)
    specials.sort(key=lambda entry: entry['file'])
    if special_entries is None:
        need(not specials, 'Unexpected special entry in strict public/source inventory: ' + str(root))
    else:
        special_entries.extend(specials)
    return sorted(result)


def manifest(path):
    return [{'file': name, 'bytes': (path / name).stat().st_size,
             'sha256': hash_file(path / name)} for name in inventory(path)]


class Bundle:
    def __init__(self, public, record, stack):
        self.record = record
        self.name = relative_name(record['archive'])
        need('/' not in self.name and self.name.endswith('.tar.gz'), 'Invalid archive filename')
        self.path = public / self.name
        raw_origin = Path(record['origin'])
        need(raw_origin.is_absolute() and link_metadata(raw_origin, '.') is None, 'Unsafe archive origin root')
        self.origin = raw_origin.resolve()
        need(raw_origin == self.origin, 'Archive origin traverses a special/noncanonical ancestor')
        need(link_metadata(self.path, self.name) is None and stat.S_ISREG(self.path.lstat().st_mode),
             'Missing/unsafe archive ' + self.name)
        need(self.path.stat().st_size == record['bytes'] and hash_file(self.path) == record['sha256'],
             'Archive length/SHA mismatch: ' + self.name)
        self.tar = stack.enter_context(tarfile.open(self.path, 'r:gz'))
        members = self.tar.getmembers()
        rows = record['files']
        names = [relative_name(row['file']) for row in rows]
        need(len(names) == len(set(names)) == record['fileCount'], 'Duplicate/count mismatch: ' + self.name)
        need([m.name for m in members] == names, 'Tar complete ordered member set differs: ' + self.name)
        self.members = dict(zip(names, members))
        self.rows = {row['file']: row for row in rows}
        # Establish every allowed original path before opening any member.
        # This rejects rows that would otherwise read through an ancestor link.
        is_gate = self.origin.parent == HERE and (self.origin / 'runner.mjs').is_file()
        original_specials = []
        need(set(inventory(self.origin, gate=is_gate, special_entries=original_specials)) == set(names),
             'Archive omits or adds original files: ' + self.name)
        descriptors = record['specialEntries']
        need(descriptors == original_specials and record['specialEntryCount'] == len(descriptors)
             and record['specialEntriesOriginalMetadataVerified'] is True,
             'Special-entry metadata differs from frozen original: ' + self.name)
        special_names = [relative_name(row['file']) for row in descriptors]
        need(len(special_names) == len(set(special_names)) and not (set(special_names) & set(names)),
             'Duplicate/overlapping special-entry paths')
        for descriptor in descriptors:
            need(set(descriptor) == {'file', 'kind', 'target', 'mode', 'reparseTag'}
                 and descriptor['kind'] in ('symlink', 'junction')
                 and isinstance(descriptor['target'], str) and descriptor['target'],
                 'Unsupported/incomplete special-entry descriptor')
        for row, member in zip(rows, members):
            need(member.isfile() and not member.issym() and not member.islnk(), 'Special tar member')
            need(member.size == row['bytes'], 'Member header size mismatch')
            source = self.origin / row['file']
            need(link_metadata(source, row['file']) is None and stat.S_ISREG(source.lstat().st_mode),
                 'Missing/unsafe original: ' + str(source))
            hashed, count = hashlib.sha256(), 0
            with self.tar.extractfile(member) as stream, source.open('rb') as original:
                while True:
                    block = stream.read(1024 * 1024)
                    if not block:
                        need(not original.read(1), 'Original is longer: ' + str(source))
                        break
                    need(block == original.read(len(block)), 'Original bytes differ: ' + str(source))
                    count += len(block)
                    hashed.update(block)
            need(count == row['bytes'] and hashed.hexdigest() == row['sha256'], 'Member SHA mismatch')

    def data(self, name):
        need(name in self.members, self.name + ' missing ' + name)
        return self.tar.extractfile(self.members[name]).read()

    def json(self, name):
        return json.loads(self.data(name).decode('utf-8'))


def validate_gate(entry, bundles):
    bundle = bundles[entry['archive']]
    summary = bundle.json('summary.json')
    need(bundle.origin == (HERE / entry['directory']).resolve(), 'Gate origin mismatch')
    need(Path(summary['outputDirectory']).resolve() == bundle.origin, 'Gate output path mismatch')
    for key in ('gate', 'exitCode', 'signal', 'error', 'unchanged', 'totals', 'startedAt', 'endedAt'):
        need(entry[key] == summary[key], 'Gate index field differs: ' + key)
    need(entry['inputSha256'] == summary['maintainedSourceSha256'], 'Gate input SHA differs')
    before, after = summary['before'], summary['after']
    need(sha(compact(before)) == summary['maintainedSourceSha256'], 'Input manifest SHA mismatch')
    need(summary['unchanged'] == (before == after), 'Incorrect unchanged flag')
    source = bundles[entry['sourceArchive']]
    need(source.record['files'] == before, 'Shared source manifest differs from gate before')
    need(not source.record['specialEntries'], 'Shared frozen source contains special entries')
    need(manifest(bundle.origin / 'source') == before, 'Own frozen source differs')
    for kind in ('stdout', 'stderr'):
        value = bundle.data(kind + '.log')
        need(summary['output'][kind] == {'bytes': len(value), 'sha256': sha(value)}, 'Output SHA mismatch')
    return bundle, summary


def verify(public, batch_directory):
    index_path = public / 'archive-index.json'
    index = read_json(index_path)
    need(index['schemaVersion'] == 1, 'Unknown archive index schema')
    need(link_metadata(batch_directory, '.') is None, 'Unsafe batch directory')
    batch_directory = batch_directory.resolve()
    need(batch_directory.parent == HERE and batch_directory.name.startswith('batch-'), 'Use an explicit local batch directory')
    batch = read_json(batch_directory / 'summary.json')
    need(batch.get('passed') is True and batch['gates'] == GATES, 'Final batch incomplete or wrong gate set')
    need([r['gate'] for r in batch['results']] == GATES, 'Batch results incomplete or reordered')
    for result in batch['results']:
        need(result.get('exitCode') == 0 and not result.get('signal') and not result.get('error'), 'Unclean final batch gate')
    final_batch = index['finalBatch']
    need(Path(final_batch['directory']).resolve() == batch_directory, 'Index final batch is not explicit requested batch')
    # The index records the original summary SHA. Accept only an explicit hash field.
    recorded_batch_sha = final_batch.get('sha256', final_batch.get('summarySha256'))
    need(recorded_batch_sha == hash_file(batch_directory / 'summary.json'), 'Final batch summary SHA mismatch')
    archive_names = [row['archive'] for row in index['archives']]
    need(len(archive_names) == len(set(archive_names)), 'Duplicate archive names')
    with ExitStack() as stack:
        bundles = {row['archive']: Bundle(public, row, stack) for row in index['archives']}
        entries = index['gates']
        need(len({row['directory'] for row in entries}) == len(entries), 'Duplicate gate directory')
        completed_origins = {p.name for p in HERE.iterdir() if p.is_dir()
                             and (p / 'summary.json').is_file() and (p / 'runner.mjs').is_file()}
        need({row['directory'] for row in entries} == completed_origins, 'Completed/failed gate original omitted')
        checked = {entry['directory']: validate_gate(entry, bundles) for entry in entries}
        final = {}
        for result in batch['results']:
            candidates = [entry for entry in entries if entry['gate'] == result['gate']
                          and stamp(entry['startedAt']) >= stamp(result['startedAt'])
                          and stamp(entry['endedAt']) <= stamp(result['endedAt'])]
            need(len(candidates) == 1, 'Final result must bind exactly one gate: ' + result['gate'])
            entry = candidates[0]
            need(entry['exitCode'] == 0 and entry['signal'] is None and entry['error'] is None
                 and entry['unchanged'] is True, 'Final gate failed: ' + result['gate'])
            need(index['finalGates'][result['gate']] == entry['directory'], 'Final gate map differs')
            final[result['gate']] = checked[entry['directory']]
        need(set(index['finalGates']) == set(GATES), 'Final gate map key set differs')
        for entry in entries:
            need(entry['finalBatchMember'] is (entry['directory'] in index['finalGates'].values()),
                 'Incorrect final/history gate classification')
        need(index['chosenD5GateDirectory'] == final['browser'][0].origin.name, 'Wrong chosen D5 browser')
        core_manifest = final['core'][1]['before']
        for gate, (_, summary) in final.items():
            expected = ([row for row in core_manifest if not row['file'].startswith('console/dist/')]
                        if gate == 'build' else core_manifest)
            need(summary['before'] == expected and summary['after'] == expected, 'Final gates used different input: ' + gate)
        inventory_names = set()
        for directory in INPUT_DIRS:
            if (ROOT / directory).is_dir():
                inventory_names.update(directory + '/' + name for name in inventory(ROOT / directory))
        inventory_names.update(name for name in INPUT_FILES if (ROOT / name).is_file())
        need(sorted(inventory_names) == [row['file'] for row in core_manifest], 'Final/current input file set differs')
        for row in core_manifest:
            path = ROOT / row['file']
            need(path.stat().st_size == row['bytes'] and hash_file(path) == row['sha256'], 'Current final input differs: ' + row['file'])
        source_keys = {sha(compact(summary['before'])) for _, summary in checked.values()}
        need(set(index['sourceGroups']) == source_keys, 'Shared source group key set mismatch')
        for entry in entries:
            need(index['sourceGroups'][entry['inputSha256']] == entry['sourceArchive'], 'Source group binding mismatch')
        # Explicit whole supplemental roots preserve failed runs, scripts and INDEX.
        origins = {bundle.origin for bundle in bundles.values()}
        for name in SUPPLEMENTAL:
            need((HERE.parent / name).resolve() in origins, 'Supplemental whole-root missing: ' + name)
        supplemental_origins = {p.resolve() for p in HERE.parent.glob('d5-*')
                                if p.is_dir() and p.resolve() != HERE and not p.name.startswith('d5-ci-')}
        expected_origins = supplemental_origins | {(HERE / entry['directory']).resolve() for entry in entries}
        expected_origins.update(bundles[name].origin for name in index['sourceGroups'].values())
        need(origins == expected_origins, 'Archive origin set misses supplemental root or has unexplained archive')
        copies = index['copies']
        copy_names = [relative_name(row['file']) for row in copies]
        need(len(copy_names) == len(set(copy_names)), 'Duplicate direct-copy filenames')
        required_tools = {'run.mjs', 'all.mjs', 'collect.py', 'verifier-review.json',
                          'static-review.md', 'verify-public.py', 'verify-staged.py', 'verify-index.py'}
        need(required_tools <= set(copy_names), 'Independent review or tool copy missing')
        copied_names = {row['file']: row for row in copies}
        for name in required_tools:
            need(Path(copied_names[name]['origin']).resolve() == HERE / name, 'Review/tool copy source differs')
        for folder in HERE.glob('batch-*'):
            if (folder / 'summary.json').is_file():
                name = folder.name + '.json'
                need(name in copied_names and Path(copied_names[name]['origin']).resolve() == folder / 'summary.json',
                     'Historical/final batch summary missing')
        for report in list(HERE.glob('staged-source-review-*.json')) + list(HERE.glob('git-index-review-*.json')):
            need(report.name in copied_names
                 and Path(copied_names[report.name]['origin']).resolve() == report,
                 'Existing source/index review omitted from direct copies')
        for row in copies:
            raw_source, target = Path(row['origin']), public / row['file']
            need(link_metadata(raw_source, raw_source.name) is None
                 and stat.S_ISREG(raw_source.lstat().st_mode), 'Unsafe direct-copy original')
            source = raw_source.resolve()
            need(raw_source == source, 'Direct-copy origin traverses a special/noncanonical ancestor')
            need(link_metadata(target, target.name) is None and stat.S_ISREG(target.lstat().st_mode), 'Missing/unsafe direct copy')
            need(target.stat().st_size == row['bytes'] and hash_file(target) == row['sha256']
                 and source.stat().st_size == row['bytes'] and hash_file(source) == row['sha256'], 'Direct copy/origin SHA differs')
        expected_public = set(archive_names) | set(copy_names) | {'archive-index.json', '.gitattributes'}
        need(set(inventory(public)) == expected_public, 'Public complete file set mismatch')
        need((public / '.gitattributes').read_bytes() == b'* -text\n', 'Public binary preservation attributes differ')
        # Recompute the actual raw reporter totals; never relabel spec as TAP.
        core, core_summary = final['core']
        need(core_summary['args'] == ['core/scripts/test-core.mjs'],
             'Core argv must run the complete maintained suite without name/file filters')
        tap = core.data('stdout.log').decode('utf-8')
        totals, reporter = {}, None
        for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
            values = re.findall(r'^# ' + key + r' (\d+)\s*$', tap, flags=re.M)
            mode = 'tap'
            if not values:
                values = re.findall(r'^\u2139 ' + key + r' (\d+)\s*$', tap, flags=re.M)
                mode = 'node-spec'
            need(len(values) == 1, 'Core needs one actual final reporter total: ' + key)
            reporter = reporter or mode
            need(reporter == mode, 'Core mixes reporter totals')
            totals[key] = int(values[0])
        if reporter == 'tap':
            need(totals == core_summary['totals'], 'Core TAP/index counts mismatch')
        else:
            need(all(value is None for value in core_summary['totals'].values()),
                 'Spec reporter counts incorrectly presented as TAP')
        need(totals['tests'] > 0, 'Empty Core suite')
        need(totals['fail'] == totals['cancelled'] == totals['todo'] == 0, 'Core has failing/cancelled/todo tests')
        need(totals['tests'] == totals['pass'] + totals['skipped'], 'Core reporter accounting mismatch')
        need(not re.search(r'^not ok\b', tap, flags=re.M), 'Core TAP contains not-ok result')
        # Verify all eight raw blobs independently, including archived final source.
        review = read_json(public / 'verifier-review.json')
        need(review['baselineCommit'] == BASELINE and review['fileCount'] == 8 and review['allEqual'] is True, 'Verifier review header differs')
        need([row['file'] for row in review['files']] == VERIFIERS, 'Eight verifier set differs')
        source = bundles[next(entry['sourceArchive'] for entry in entries if entry['directory'] == core.origin.name)]
        for row in review['files']:
            file = row['file']
            command = subprocess.run(['git', 'show', BASELINE + ':' + file], cwd=ROOT, capture_output=True, check=True)
            raw = command.stdout
            need(source.data(file) == raw == (ROOT / file).read_bytes(), 'Verifier original bytes differ: ' + file)
            expected = {'bytes': len(raw), 'sha256': sha(raw)}
            need(row['d5'] == expected and row['d4FinalSnapshot'] == expected
                 and all(row['checks'].values()) and row['allEqual'] is True, 'Verifier review facts differ')
            need(row['headGitBlob']['sha256'] == sha(raw) and row['baselineGitBlob']['sha256'] == sha(raw), 'Raw git blob SHA differs')
        browser, outer = final['browser']
        smoke = browser.json('browser/summary.json')
        need(smoke.get('passed') is True and smoke['checkCount'] == len(CHECKS), 'Final D5 incomplete')
        checks = browser.json('browser/checks.json')
        need(set(checks) == set(CHECKS) and all(v is True for v in checks.values())
             and smoke['checks'] == checks, 'D5 exact check key/value set differs')
        need(Path(smoke['outputDirectory']).resolve() == browser.origin / 'browser', 'D5 output root differs')
        need(stamp(outer['startedAt']) <= stamp(smoke['startedAt']) <= stamp(smoke['endedAt']) <= stamp(outer['endedAt']), 'D5 time binding differs')
        stdout_records = []
        for line in browser.data('stdout.log').decode('utf-8').splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and value.get('passed') is True and value.get('outputDirectory') == smoke['outputDirectory']:
                stdout_records.append(value)
        need(stdout_records == [smoke], 'Final D5 stdout completion not exact/unique')
        layouts = browser.json('browser/layouts.json')
        need(smoke['captures'] == CAPTURES and len(layouts) == 4, 'Final captures/layout count differs')
        pngs = []
        copy_by_name = {row['file']: row for row in copies}
        for i, name in enumerate(CAPTURES):
            data = browser.data('browser/' + name)
            width, height = [(1440, 1000), (390, 844), (1440, 1000), (390, 844)][i]
            need(data[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', data[16:24]) == (width, height), 'Invalid/wrong-size final PNG')
            layout = layouts[i]
            need(layout['name'] + '.png' == name and layout['width'] == width and layout['height'] == height
                 and layout['theme'] == ['light', 'dark', 'dark', 'light'][i]
                 and layout['documentWidth'] <= width + 1 and 0 < layout['clientWidth']
                 and layout['scrollWidth'] <= layout['clientWidth'] + 1, 'Layout contract differs')
            need(browser.data('browser/' + name.replace('.png', '-dom.txt')).decode('utf-8') == layout['text'], 'DOM/layout text differs')
            need((public / name).read_bytes() == data and Path(copy_by_name[name]['origin']).resolve() == browser.origin / 'browser' / name, 'Final PNG copy not bound to final D5')
            pngs.append({'file': name, 'bytes': len(data), 'sha256': sha(data), 'viewport': [width, height]})
        for name in ('summary.json', 'checks.json', 'layouts.json', 'browser-errors.json', 'ticket-export.md', 'ticket-export.json'):
            need((public / ('d5-browser-' + name)).read_bytes() == browser.data('browser/' + name), 'Final readable artifact copy differs')
        errors = browser.json('browser/browser-errors.json')
        need(errors['pageErrors'] == smoke['pageErrors'] == [], 'Unexpected page error')
        replies = errors['controlledReplies']
        need(len(replies) == 3 and {r['kind'] for r in replies} == {'lost-create', 'lost-close', 'stale-facts'}, 'Controlled reply set differs')
        need({r['kind']: r['status'] for r in replies} == {'lost-create': 502, 'lost-close': 502, 'stale-facts': 409}, 'Controlled status set differs')
        messages = errors['consoleMessages']
        need(smoke['consoleMessageCount'] == len(messages) == 3 and smoke['controlledReplyCount'] == 3, 'Unexpected console/reply count')
        observed = Counter()
        from urllib.parse import urlparse
        for message in messages:
            match = re.fullmatch(r'Failed to load resource: the server responded with a status of (\d+) \([^\r\n]+\)', message['text'])
            need(message['type'] == 'error' and match is not None, 'Unexpected console message')
            observed[(urlparse(message['location']['url']).path, int(match.group(1)))] += 1
        need(observed == Counter((r['path'], r['status']) for r in replies), 'Console/control multiplicity differs')
        requests = browser.json('browser/browser-requests.json')
        posts = [r for r in requests if r['method'] == 'POST']
        need(len(posts) == 4 and all('/defect-tickets' in r['path'] for r in posts), 'Unexpected/automatic Browser POST')
        create = posts[0]['body']
        collection = posts[0]['path']
        close_path = collection + '/' + create['ticketId'] + '/close'
        need([p['path'] for p in posts] == [collection, close_path, close_path, close_path], 'Wrong manual POST sequence')
        actions = [p['body']['actionId'] for p in posts]
        need(len(set(actions)) == 4 and len(create['memberCheckIds']) == len(set(create['memberCheckIds'])) == 2, 'Action replay/member set differs')
        need(all(p['body']['confirmed'] is True for p in posts[1:]), 'Close without confirmation')
        expected_gets = Counter([collection + '/actions/' + actions[0], collection + '/actions/' + actions[1]])
        need(Counter(r['path'] for r in requests if r['method'] == 'GET' and '/actions/' in r['path']) == expected_gets, 'Lost action GET reconciliation differs')
        need(all(r['method'] in ('GET', 'POST') for r in requests), 'Unexpected acceptance request method')
        http = [json.loads(line) for line in browser.data('browser/http.jsonl').decode('utf-8').splitlines() if line]
        executions = [r for r in http if r['method'] == 'POST' and re.search(r'/browser-executions$', r['path'])]
        registrations = [r for r in http if r['method'] == 'POST' and r['path'].endswith('/register-result')]
        source_runs = [r for r in http if r['method'] == 'POST' and r['path'] == 'runs']
        need(len(executions) == len(registrations) == 6 and len(source_runs) == 1, 'Unexpected extra runner or registration')
        operation_ids = {r['body']['operationId'] for r in executions}
        need(len(operation_ids) == 6 and {r['path'].split('/')[-2] for r in registrations} == operation_ids, 'Execution/registration identity differs')
        source_report = [r['payload'] for r in http if r['method'] == 'GET' and r['path'] == 'runs/' + source_runs[0]['payload']['runId'] + '/report']
        need(len(source_report) == 1 and source_report[0]['gate'] == 'failed' and len(source_report[0]['checks']) == 14, 'Source report coverage differs')
        ticket = browser.json('browser/final-ticket.json')['ticket']
        need(ticket['processingStatus'] == 'closed' and ticket['verificationStatus'] == 'verified_passed'
             and ticket['revision'] == 2 and len(ticket['members']) == 2 and len(ticket['history']) == 3, 'Final ticket lifecycle differs')
        need(ticket['counts'] == {'total': 2, 'passed': 2, 'failed': 0, 'incomparable': 0, 'unverified': 0}
             and ticket['closeEligible'] is False, 'Final fixed-member verification counts differ')
        need({member['checkId'] for member in ticket['members']} == set(create['memberCheckIds'])
             and {member['identity']['facet'] for member in ticket['members']} == {'visual', 'behavior'},
             'Fixed manual members do not match the two approved failure facets')
        need([r['actionId'] for r in ticket['history']] == [actions[0], actions[1], actions[3]], 'Stale action persisted or history differs')
        events = browser.json('browser/ticket-events.json')
        need(set(events) == {'v1/events/' + action + '.json' for action in (actions[0], actions[1], actions[3])},
             'Unexpected extra or missing durable ticket action')
        for event in ticket['history']:
            name = 'v1/events/' + event['actionId'] + '.json'
            raw = browser.data('browser/runtime/acceptance/defect-tickets/' + name)
            need(events[name] == {'bytes': len(raw), 'sha256': sha(raw)}
                 and json.loads(raw) == event, 'Final projected history differs from durable original')
        exported = browser.json('browser/ticket-export.json')
        need(exported['handling']['status'] == 'closed' and len(exported['history']) == 3
             and exported['verification']['status'] == 'verified_passed'
             and exported['verification']['counts'] == ticket['counts']
             and exported['verification']['repairVerified'] is True, 'JSON export lifecycle/verification differs')
        for name in ('ticket-export.md', 'ticket-export.json'):
            need(not re.search(rb'EXPORT_SENTINEL|OTHER_SENTINEL|user:password', browser.data('browser/' + name)), 'Recognized export secret present')
        source_digests = browser.json('browser/source-file-digests.json')
        source_id = source_runs[0]['payload']['runId']
        for name, fact in source_digests.items():
            raw = browser.data('browser/runtime/acceptance/' + source_id + '/' + relative_name(name))
            need(len(raw) == fact['bytes'] and sha(raw) == fact['sha256'], 'Captured source original changed')
        target_requests = browser.json('browser/target-requests.json')
        need(sum(r['path'].startswith('/source') for r in target_requests) == 4, 'Source re-fetched after capture')
        storage = browser.json('browser/browser-storage.json')
        need(not re.search(r'd5-source-url-sentinel|d5-fill-sentinel|d5-captured-source-sentinel', json.dumps(storage)), 'Source sentinel leaked to storage/link')
        return {'status': 'passed', 'archiveIndexSha256': hash_file(index_path),
                'publicDirectory': str(public), 'finalBatchDirectory': str(batch_directory),
                'archives': len(bundles), 'archiveFiles': sum(b.record['fileCount'] for b in bundles.values()),
                'specialEntries': sum(b.record['specialEntryCount'] for b in bundles.values()),
                'directCopies': len(copies), 'finalGates': index['finalGates'], 'sourceFiles': len(core_manifest),
                'fullCoreReporter': reporter, 'fullCoreCounts': totals, 'baselineCommit': BASELINE, 'verifierFiles': 8,
                'd5Checks': len(CHECKS), 'screenshots': pngs, 'pageErrors': 0,
                'controlledConsoleMessages': 3, 'explicitTicketPosts': 4,
                'lostActionGetReconciliations': 2, 'explicitBrowserExecutions': 6,
                'explicitRegistrations': 6, 'originalSourceChecks': 14,
                'limitations': ['Read-only artifact verification; no Browser, tests or engine were started.',
                    'PNG signature/dimensions/SHA and DOM were verified; this is not a visual human review.',
                    'Lost-response Browser evidence is route.fetch/502 simulation, not a TCP or power-loss test.',
                    'The Browser request log covers /api/acceptance; unrelated Browser network is outside that log.',
                    'The input freeze covers the enumerated maintained source/build inputs, not every Markdown file.',
                    'Existing Symlink/Junction metadata and Python readlink substitution-target strings are preserved without following or extracting links; raw reparse buffers and arbitrary reparse types are outside this contract.',
                    'Original files are frozen by workflow and checked again; Windows lstat/read is not an atomic defense against concurrent malicious replacement.',
                    'This does not certify atomic multi-file snapshots or detect a self-consistent external backup rollback.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-directory', type=Path,
                        default=ROOT / 'docs/audits/2026-10-18/evidence/defect-tickets')
    parser.add_argument('--batch-directory', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    args = parser.parse_args()
    output = args.output_directory.resolve()
    need(link_metadata(args.public_directory, '.') is None, 'Unsafe public root')
    public = args.public_directory.resolve()
    need(output != public and public not in output.parents,
         'Write the independent report outside the sealed public evidence directory')
    need(not output.exists(), 'Use an absent report directory; never replace verification evidence')
    started = datetime.now(timezone.utc).isoformat()
    try:
        result = verify(public, args.batch_directory)
    except Exception as cause:
        result = {'status': 'failed', 'errorType': type(cause).__name__, 'error': str(cause)}
    result.update(startedAt=started, endedAt=datetime.now(timezone.utc).isoformat(),
                  verifierSha256=hash_file(Path(__file__).resolve()))
    # Do not create a new d5-* root until the original/archive inventory is done.
    # A report under core/workspace/_runs must not become its own missing input.
    output.mkdir(parents=True)
    (output / 'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    text = '# D5 independent public evidence verification\n\nStatus: ' + result['status'] + '\n\n```json\n' + json.dumps(result, ensure_ascii=False, indent=2) + '\n```\n'
    (output / 'review.md').write_text(text, encoding='utf-8', newline='\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
