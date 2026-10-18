"""Read archived evidence; never execute a test, repro, Browser or engine."""
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

def verify(root, git_repository=None):
    manifest_bytes = (root / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    seen = set()
    count_bytes = 0
    for row in manifest['files']:
        rel = PurePosixPath(row['path'])
        require(not rel.is_absolute() and '..' not in rel.parts and rel.parts[0] == 'original', 'unsafe manifest path')
        require(row['path'] not in seen, 'duplicate manifest path')
        seen.add(row['path'])
        path = root / Path(*rel.parts)
        require(not path.is_symlink(), 'symlink original')
        data = path.read_bytes()
        require(len(data) == row['bytes'] and sha(data) == row['sha256'], 'original bytes differ: ' + row['path'])
        count_bytes += len(data)
    require(seen == {p.relative_to(root).as_posix() for p in (root / 'original').rglob('*') if p.is_file()}, 'original file set differs')
    require(len(seen) == manifest['fileCount'] == 33 and count_bytes == manifest['totalBytes'] == 138651, 'original inventory differs')
    original = root / 'original'
    raw = lambda name: (original / name).read_bytes()
    read = lambda name: json.loads(raw(name))
    for prefix in ['before', 'after']:
        require(raw(prefix + '-results.json') == raw(prefix + '.stdout.log'), 'repro JSON and raw stdout differ')
        require(read(prefix + '.result.json')['exitCode'] == 0, 'historical repro exit differs')
        require(raw(prefix + '.stderr.log') == b'', 'historical repro stderr differs')
    before, after = read('before-results.json'), read('after-results.json')
    for name, expected in before['inputs'].items():
        require(sha(raw(name)) == expected, 'before source identity differs')
    aliases = {'console/src/acceptance-catalog.js': 'acceptance-catalog.after.js', 'console/src/AcceptanceCatalog.vue': 'AcceptanceCatalog.after.vue'}
    final_sources = {}
    for line in raw('frontend-final-sha256.txt').decode('utf-8').splitlines():
        digest, path = line.split(maxsplit=1)
        require(re.fullmatch(r'[0-9a-f]{64}', digest) is not None, 'invalid historical final digest')
        require(path not in final_sources, 'duplicate final source')
        final_sources[path] = digest
    require(len(final_sources) == 4, 'final source inventory differs')
    for path, name in aliases.items():
        require(sha(raw(name)) == after['inputs'][path] == final_sources[path], 'after source identity differs')
    fault = next(row for row in before['results'] if row['case'] == 'acknowledged-POST-then-never-settling-list-fetch')
    require(fault['checkpoint'] == fault['unchangedAfter80ms'], 'historical stalled state differs')
    require(fault['checkpoint']['writing'] == 'release' and fault['checkpoint']['listLoading'] and not fault['checkpoint']['ready'], 'historical stalled state boundary differs')
    require(after['productionRequestTimeoutMs'] == 60000, 'historical production request budget differs')
    require([row['stage'] for row in after['results']] == ['fetch', 'body'], 'historical after cases differ')
    for row in after['results']:
        require(row['timeoutMs'] == 35 and row['posted'] == 1 and row['recoveryMethods'] == ['GET', 'GET'], 'historical bounded replay boundary differs')
        require(row['whileRefreshing']['writing'] == 'release' and '写入已确认' in row['whileRefreshing']['notice'], 'historical ACK notice differs')
        bounded = row['boundedFailure']
        require(bounded['writing'] == '' and not bounded['listLoading'] and not bounded['detailLoading'] and bounded['requiresReconcile'], 'historical bounded state differs')
        require(row['afterReadOnlyRecovery']['ready'], 'historical read-only recovery differs')
    stats = {}
    for prefix, expected in [('helper-final', 24), ('state-final', 16)]:
        text = raw(prefix + '.stdout.log').decode('utf-8')
        values = {key: int(re.search(r'^\S+ ' + key + r' (\d+)\s*$', text, re.M).group(1)) for key in ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}
        require(values == {'tests': expected, 'suites': 0, 'pass': expected, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, 'historical test statistics differ')
        require(read(prefix + '.result.json')['exitCode'] == 0 and raw(prefix + '.stderr.log') == b'', 'historical test exit/stderr differs')
        stats[prefix] = values
    detector = read('ui-detector-final.stdout.log')
    require(read('ui-detector-final.result.json')['exitCode'] == 2 and len(detector) == 1 and detector[0]['severity'] == 'warning', 'historical UI detector result differs')
    declaration = detector[0]['snippet'].encode('utf-8')
    require(declaration in raw('AcceptanceCatalog.before.vue') and declaration in raw('AcceptanceCatalog.after.vue'), 'historical warning declaration differs')
    smoke = read('unchanged-smoke.result.json')
    require(smoke['exitCode'] == 0 and smoke['baseline'] == '41c359a62ecbb67ac15f38c51c95fa983a7492d3', 'historical unchanged-smoke boundary differs')
    require(read('diff-check-final.result.json')['exitCode'] == 0, 'historical diff check differs')
    baseline = {'checked': False, 'filesVerified': 0}
    if git_repository:
        files = {'console/src/acceptance-catalog.js': 'acceptance-catalog.before.js', 'console/src/AcceptanceCatalog.vue': 'AcceptanceCatalog.before.vue'}
        for path, name in files.items():
            data = subprocess.run(['git', 'show', smoke['baseline'] + ':' + path], cwd=git_repository, capture_output=True, check=True).stdout
            require(data == raw(name), 'historical baseline Git bytes differ: ' + path)
        baseline = {'checked': True, 'head': smoke['baseline'], 'filesVerified': 2, 'allBlobsMatch': True}
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'evidenceLevel': 'offline archive integrity verification only; no tests or archived repro executed',
        'allChecksPassed': True, 'originalFilesVerified': len(seen), 'originalBytesVerified': count_bytes, 'manifestSha256': sha(manifest_bytes),
        'historicalFinalTestStats': stats, 'historicalDetector': {'exitCode': 2, 'warnings': 1, 'declarationPresentBeforeAndAfter': True},
        'beforeAndAfterSourceIdentitiesVerified': 4, 'historicalFinalSourceSha256': final_sources, 'historicalBaselineGitObjects': baseline,
        'scope': 'Independent offline actual-Vue/helper recovery evidence; does not establish old CI stall cause, original Browser smoke success or full CI success.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--git-repository', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(Path(__file__).resolve().parent, args.git_repository), ensure_ascii=False, indent=2))
