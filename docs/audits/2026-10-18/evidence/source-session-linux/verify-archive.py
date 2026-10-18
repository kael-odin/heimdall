"""Verify archived bytes and historical metadata; never execute archived tools."""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import argparse
import hashlib
import json
import re
import subprocess

def sha(data):
    return hashlib.sha256(data).hexdigest()

def require(condition, message):
    if not condition:
        raise ValueError(message)

def read_json(path):
    return json.loads(path.read_bytes())

def verify(root, git_repository=None):
    manifest_bytes = (root / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    records = manifest['files']
    seen = set()
    byte_count = 0
    for record in records:
        rel = PurePosixPath(record['path'])
        require(not rel.is_absolute() and '..' not in rel.parts and rel.parts[0] == 'original', 'unsafe manifest path')
        require(record['path'] not in seen, 'duplicate manifest path')
        seen.add(record['path'])
        path = root / Path(*rel.parts)
        require(not path.is_symlink(), 'symlink in original archive')
        data = path.read_bytes()
        require(len(data) == record['bytes'] and sha(data) == record['sha256'], 'original bytes differ: ' + record['path'])
        byte_count += len(data)
    actual = {p.relative_to(root).as_posix() for p in (root / 'original').rglob('*') if p.is_file()}
    require(actual == seen, 'original file set differs from manifest')
    require(len(records) == manifest['fileCount'] == 67, 'unexpected original count')
    require(byte_count == manifest['totalBytes'] == 391315, 'unexpected original byte count')
    original = root / 'original'
    focused = original / 'source-operations-20261018T002410.230450Z'
    old_manifest = read_json(focused / 'manifest.json')
    for record in old_manifest['files']:
        data = (focused / record['path']).read_bytes()
        require(len(data) == record['bytes'] and sha(data) == record['sha256'], 'historical focused manifest differs: ' + record['path'])
    old_preparation = read_json(original / 'preparation-deliverables.json')
    excluded_paths = {row['path'] for row in manifest['excludedFiles']}
    preparation_checked = 0
    for record in old_preparation['files']:
        if record['path'] in excluded_paths:
            excluded = next(row for row in manifest['excludedFiles'] if row['path'] == record['path'])
            require(record['bytes'] == excluded['bytes'] and record['sha256'] == excluded['sha256'], 'excluded-file metadata differs')
            continue
        data = (original / record['path']).read_bytes()
        require(len(data) == record['bytes'] and sha(data) == record['sha256'], 'historical preparation manifest differs: ' + record['path'])
        preparation_checked += 1
    require(old_preparation['fileCount'] == len(old_preparation['files']) == 68, 'preparation inventory count differs')
    require(preparation_checked == 66 and len(excluded_paths) == 2, 'preparation inventory archive boundary differs')
    before_bytes = (focused / 'inputs-before.json').read_bytes()
    after_bytes = (focused / 'inputs-after.json').read_bytes()
    require(before_bytes == after_bytes, 'before/after input bytes differ')
    before = json.loads(before_bytes)
    copied = read_json(original / 'linux-preparation-evidence/source-copy-manifest.json')
    published = read_json(original / 'published-source-match.json')
    require(len(before) == len(copied['files']) == published['fileCount'] == len(published['files']) == 199, 'snapshot input count differs')
    require(copied['sourceStableDuringCopy'] and copied['allCopiedBytesMatch'] and published['allMatch'], 'historical snapshot flags differ')
    inputs_by_path = {row['path']: row for row in before}
    copies_by_path = {row['path']: row for row in copied['files']}
    published_by_path = {row['path']: row for row in published['files']}
    require(len(inputs_by_path) == len(copies_by_path) == len(published_by_path) == 199, 'duplicate snapshot path')
    require({'core/' + path for path in inputs_by_path} == set(published_by_path), 'published input paths differ')
    require(set(inputs_by_path) == set(copies_by_path), 'prepared input paths differ')
    for path, row in inputs_by_path.items():
        copy = copies_by_path[path]
        pub = published_by_path['core/' + path]
        require(row['sourceSha256'] == row['copySha256'] == copy['sha256'] == copy['destinationSha256'] == pub['sha256'], 'snapshot hash differs: ' + path)
        require(row['sourceBytes'] == row['copyBytes'] == copy['bytes'] == copy['destinationBytes'] == pub['bytes'], 'snapshot size differs: ' + path)
        require(pub['matchesLinuxCopy'] and pub['matchesCurrentMaintenanceSource'], 'historical published flags differ: ' + path)
    summary = read_json(focused / 'summary.json')
    command_start = read_json(focused / 'command-start.json')
    command_result = read_json(focused / 'command-result.json')
    require(summary['command'] == command_result and all(command_result[key] == value for key, value in command_start.items()), 'historical command metadata differs')
    expected_argv = ['/root/heimdall-node22-diagnosis-20261018/runtime/bin/node', '--test', '--test-reporter=tap', 'test/source-operations.test.mjs']
    require(command_result['argv'] == expected_argv and command_result['exitCode'] == 0, 'historical argv or exit differs')
    require(command_result['automaticRetries'] == 0 and command_result['parallelBrowserTasksStarted'] == 0 and not command_result['cpuLoadAdded'], 'historical execution boundary differs')
    stdout = (focused / 'stdout.log').read_bytes()
    stderr = (focused / 'stderr.log').read_bytes()
    require(sha(stdout) == summary['stdoutSha256'] and sha(stderr) == summary['stderrSha256'], 'historical output hashes differ')
    stats = {key: summary['stats'][key]['value'] for key in ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}
    require(stats == {'tests': 17, 'suites': 0, 'pass': 17, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, 'historical result stats differ')
    text = stdout.decode('utf-8')
    require(len(re.findall(r'^ok \d+ - ', text, re.M)) == 17 and not re.search(r'^not ok ', text, re.M), 'historical TAP cases differ')
    for key, value in stats.items():
        require(re.search(r'^# ' + key + r' ' + str(value) + r'\s*$', text, re.M), 'historical TAP statistic differs: ' + key)
    require(summary['sourceFilesUnchanged'] and summary['sourceFileCount'] == 199 and not summary['notOk'], 'historical input/result flags differ')
    require(summary['testSha256'] == inputs_by_path['test/source-operations.test.mjs']['sourceSha256'], 'historical test hash differs')
    git_result = {'checked': False, 'reason': 'Supply --git-repository to verify the historical commit objects.'}
    if git_repository:
        head = published['head']
        require(head == '41c359a62ecbb67ac15f38c51c95fa983a7492d3', 'unexpected historical commit')
        tree = subprocess.run(['git', 'ls-tree', '-r', '--full-tree', head, 'core/src', 'core/test/source-operations.test.mjs'], cwd=git_repository, check=True, capture_output=True).stdout
        blobs = {}
        for line in tree.splitlines():
            header, path = line.split(b'\t', 1)
            mode, kind, object_id = header.decode('ascii').split()
            require(kind == 'blob', 'unexpected historical object type')
            blobs[path.decode('utf-8')] = object_id
        require(set(blobs) == set(published_by_path), 'historical Git tree paths differ')
        ordered = sorted(published_by_path)
        batch = ('\n'.join(blobs[path] for path in ordered) + '\n').encode('ascii')
        output = subprocess.run(['git', 'cat-file', '--batch'], input=batch, cwd=git_repository, check=True, capture_output=True).stdout
        offset = 0
        for path in ordered:
            line_end = output.index(b'\n', offset)
            object_id, kind, size = output[offset:line_end].decode('ascii').split()
            length = int(size)
            data_start = line_end + 1
            data_end = data_start + length
            data = output[data_start:data_end]
            require(output[data_end:data_end + 1] == b'\n', 'malformed Git batch output')
            offset = data_end + 1
            pub = published_by_path[path]
            require(object_id == blobs[path] == pub['gitBlob'] and kind == 'blob' and length == pub['bytes'] and sha(data) == pub['sha256'], 'historical Git object differs: ' + path)
        require(offset == len(output), 'extra Git batch output')
        git_result = {'checked': True, 'head': head, 'filesVerified': len(ordered), 'allBlobsMatch': True, 'currentWorkingTreeCompared': False}
    return {
        'verifiedAt': datetime.now(timezone.utc).isoformat(),
        'label': 'offline archive integrity verification only; no test, Browser, engine or preparation script executed',
        'allChecksPassed': True,
        'originalFilesVerified': len(records),
        'originalBytesVerified': byte_count,
        'manifestSha256': sha(manifest_bytes),
        'historicalFocusedManifestFilesVerified': len(old_manifest['files']),
        'historicalPreparationManifestFilesVerified': preparation_checked,
        'historicalPreparationManifestExcludedFiles': len(excluded_paths),
        'inputSnapshotsEqualBytes': True,
        'inputSnapshotRowsVerified': len(before),
        'publishedSourceMatchRowsVerified': len(published['files']),
        'historicalGitObjects': git_result,
        'historicalTestStats': stats,
        'historicalStdoutSha256': sha(stdout),
        'historicalStderrSha256': sha(stderr),
        'scope': 'One historical WSL Linux source-operations single-file run; does not establish full CI, the 20 smokes, D5 or Docker success.'
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--git-repository', type=Path)
    args = parser.parse_args()
    result = verify(Path(__file__).resolve().parent, args.git_repository)
    print(json.dumps(result, ensure_ascii=False, indent=2))
