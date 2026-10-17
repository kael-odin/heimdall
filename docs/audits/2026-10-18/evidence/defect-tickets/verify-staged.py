"""Bind every non-dist maintained Git index blob to an explicit completed Core.

Read-only verification. No Core, engine, Browser or other tests are started.
Each invocation writes a new exclusive report and preserves earlier reviews.
"""
from pathlib import Path, PurePosixPath
import argparse
import datetime
import hashlib
import json
import os
import re
import stat
import subprocess

here = Path(__file__).resolve().parent
root = here.parents[3]
directories = ['core/src', 'core/scripts', 'core/test', 'console/src',
               'console/public', 'config', 'console/dist']
fixed_files = ['package.json', 'pnpm-lock.yaml', 'core/package.json',
               'core/pnpm-lock.yaml', 'console/package.json',
               'console/pnpm-lock.yaml', 'console/index.html',
               'console/vite.config.js', '.github/workflows/ci.yml',
               'docs/audits/2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json']


def need(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def ordinary(path, directory=False):
    info = path.lstat()
    need(not stat.S_ISLNK(info.st_mode)
         and not (getattr(info, 'st_file_attributes', 0) & 0x400),
         'Special filesystem entry: ' + str(path))
    need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
         'Unexpected filesystem entry type: ' + str(path))


def canonical_name(value):
    need(isinstance(value, str) and value and not re.search(r'[\\\r\n\x00:]', value),
         'Unsafe source path')
    path = PurePosixPath(value)
    need(not path.is_absolute() and path.as_posix() == value
         and all(part not in ('', '.', '..') for part in path.parts), 'Noncanonical source path')
    return value


def inventory(base):
    ordinary(base, directory=True)
    result = []
    for directory, dirs, files in os.walk(base, followlinks=False):
        parent = Path(directory)
        for name in dirs:
            ordinary(parent / name, directory=True)
        for name in files:
            path = parent / name
            ordinary(path)
            result.append(path.relative_to(base).as_posix())
    return sorted(result)


def ordinary_project_file(name):
    cursor = root
    ordinary(cursor, directory=True)
    for part in PurePosixPath(name).parts[:-1]:
        cursor = cursor / part
        ordinary(cursor, directory=True)
    ordinary(root / name)


def maintained_names():
    names = set()
    for directory in directories:
        path = root / directory
        if path.exists():
            names.update(directory + '/' + name for name in inventory(path))
    for name in fixed_files:
        if (root / name).exists():
            ordinary_project_file(name)
            names.add(name)
    return sorted(names)


def maintained_non_dist(name):
    return name in fixed_files or any(name == directory or name.startswith(directory + '/')
                                     for directory in directories if directory != 'console/dist')


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-summary', type=Path, required=True)
args = parser.parse_args()
raw_source = args.source_summary
need(raw_source.is_absolute(), 'Use an explicit absolute --source-summary path')
ordinary(raw_source)
ordinary(raw_source.parent, directory=True)
source = raw_source.resolve(strict=True)
need(source == raw_source and source.name == 'summary.json' and source.parent.parent == here
     and re.fullmatch(r'core-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', source.parent.name),
     'Source must be exactly HERE/core-<UUID>/summary.json without link traversal')
source_raw = source.read_bytes()
summary = json.loads(source_raw)
need(summary['gate'] == 'core' and type(summary['exitCode']) is int and summary['exitCode'] == 0
     and summary['signal'] is None and summary['error'] is None
     and summary['unchanged'] is True and summary['before'] == summary['after'],
     'Source Core is incomplete, failed or changed its maintained inputs')
need(summary['args'] == ['core/scripts/test-core.mjs'], 'Source must run the complete Core command')
need(Path(summary['outputDirectory']) == source.parent, 'Source output directory differs')
need(isinstance(summary['startedAt'], str) and isinstance(summary['endedAt'], str)
     and summary['startedAt'].endswith('Z') and summary['endedAt'].endswith('Z')
     and datetime.datetime.fromisoformat(summary['startedAt'].replace('Z', '+00:00'))
     <= datetime.datetime.fromisoformat(summary['endedAt'].replace('Z', '+00:00')),
     'Source Core has no valid completed time range')
rows = summary['before']
need(isinstance(rows, list) and rows, 'Core before manifest must be complete and nonempty')
names = []
for row in rows:
    need(set(row) == {'file', 'bytes', 'sha256'}, 'Unexpected manifest row fields')
    names.append(canonical_name(row['file']))
    need(type(row['bytes']) is int and row['bytes'] >= 0
         and isinstance(row['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', row['sha256']),
         'Invalid source length/SHA')
need(names == sorted(set(names)), 'Core before manifest contains duplicates or is not sorted')
need(sha(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode())
     == summary['maintainedSourceSha256'], 'Core manifest digest differs')
need(names == maintained_names(), 'Core before manifest is not the complete current maintained input set')
frozen = source.parent / 'source'
need(inventory(frozen) == names, 'Frozen source file set differs from complete before manifest')
for row in rows:
    raw = (frozen / row['file']).read_bytes()
    need(len(raw) == row['bytes'] and sha(raw) == row['sha256'], 'Frozen source bytes differ: ' + row['file'])
selected = [row for row in rows if not row['file'].startswith('console/dist/')]
need(selected, 'No non-dist maintained inputs selected')

# Enumerate the whole maintained index set, including index-only paths.
# Stage-zero ordinary files only; the batch protocol preserves raw blob bytes.
index_raw = subprocess.run(['git', 'ls-files', '--stage', '-z'], cwd=root,
                           capture_output=True, check=True).stdout
index = {}
for record in index_raw.split(b'\0'):
    if not record:
        continue
    metadata, path_bytes = record.split(b'\t', 1)
    name = path_bytes.decode('utf-8')
    if not maintained_non_dist(name):
        continue
    canonical_name(name)
    mode, object_id, stage = metadata.split()
    need(stage == b'0' and mode in (b'100644', b'100755') and name not in index,
         'Unmerged/special/duplicate maintained index path: ' + name)
    index[name] = object_id
need(set(index) == {row['file'] for row in selected}, 'Maintained Git index path set differs from frozen non-dist inputs')
data = subprocess.run(['git', 'cat-file', '--batch'], cwd=root,
                      input=''.join(':' + row['file'] + '\n' for row in selected).encode(),
                      capture_output=True, check=True).stdout
offset, checks = 0, []
for row in selected:
    end = data.index(b'\n', offset)
    header = data[offset:end].split()
    need(len(header) == 3 and header[1] == b'blob' and header[0] == index[row['file']],
         'Missing/nonblob/changed index object: ' + row['file'])
    size = int(header[2])
    need(size >= 0 and end + size + 2 <= len(data)
         and data[end + size + 1:end + size + 2] == b'\n', 'Invalid Git batch framing')
    content = data[end + 1:end + 1 + size]
    offset = end + size + 2
    ordinary_project_file(row['file'])
    workspace = (root / row['file']).read_bytes()
    checks.append({'file': row['file'], 'bytes': size, 'sha256': sha(content),
                   'matchesFrozenSource': len(content) == row['bytes'] and sha(content) == row['sha256'],
                   'workspaceMatchesFrozenSource': len(workspace) == row['bytes'] and sha(workspace) == row['sha256']})
need(offset == len(data), 'Unparsed Git batch bytes')
need(source.read_bytes() == source_raw, 'Source summary changed during verification')
passed = all(row['matchesFrozenSource'] and row['workspaceMatchesFrozenSource'] for row in checks)
report = {'passed': passed, 'sourceSummary': {'path': str(source), 'bytes': len(source_raw), 'sha256': sha(source_raw)},
          'sourceMaintainedSha256': summary['maintainedSourceSha256'], 'sourceFileCount': len(rows),
          'selectedNonDistCount': len(selected), 'files': checks,
          'excluded': 'console/dist index blobs are excluded; their complete frozen runtime bytes were verified against the Core manifest.',
          'verifierSha256': sha(Path(__file__).read_bytes())}
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
out = here / ('staged-source-review-' + stamp + '.json')
with out.open('x', encoding='utf-8', newline='\n') as stream:
    stream.write(json.dumps(report, indent=2) + '\n')
print(json.dumps({'report': str(out), 'checks': len(checks), 'passed': passed,
                  'sourceSummary': report['sourceSummary']}))
raise SystemExit(0 if passed else 1)
