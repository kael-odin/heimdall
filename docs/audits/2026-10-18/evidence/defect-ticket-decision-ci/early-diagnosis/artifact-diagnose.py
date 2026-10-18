from pathlib import Path, PurePosixPath
import datetime, hashlib, json, re, stat, subprocess, sys, zipfile

OUT = Path(__file__).resolve().parent
REPO = OUT.parents[4]
HEAD = '06e4303871d485a14b66d24318db80595a3db774'
RUN, ATTEMPT, JOB, ARTIFACT = 39096514869, 1, 117583999059, 12124333500
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(data): return hashlib.sha256(data).hexdigest()
def put(name, data):
    with (OUT / name).open('xb') as handle: handle.write(data)
    if (OUT / name).read_bytes() != data: raise ValueError('Written bytes differ: ' + name)
def save(name, value): put(name, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
def command(label, argv, stdout_name):
    started = now(); timed_out, launch_error = False, None
    try:
        result = subprocess.run(argv, cwd=REPO, capture_output=True, timeout=55)
        stdout, stderr, code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        timed_out = True; stdout, stderr, code = error.stdout or b'', error.stderr or b'', None
    except OSError as error:
        stdout, stderr, code = b'', b'', None; launch_error = {'type': type(error).__name__, 'message': str(error)}
    put(stdout_name, stdout); put(label + '.stderr.log', stderr)
    save(label + '.command.json', {'argv': argv, 'cwd': str(REPO), 'startedAt': started, 'endedAt': now(),
         'exitCode': code, 'timedOut': timed_out, 'launchError': launch_error, 'stdoutFile': stdout_name,
         'stdoutBytes': len(stdout), 'stdoutSha256': sha(stdout), 'stderrFile': label + '.stderr.log',
         'stderrBytes': len(stderr), 'stderrSha256': sha(stderr)})
    if code != 0: raise ValueError(label + ' failed: ' + str(code))
    return stdout

save('artifact-diagnosis-runtime.json', {'argv': sys.argv, 'scriptSha256': sha(Path(__file__).read_bytes()),
     'kind': 'early-failed-artifact-diagnosis-not-ci-acceptance', 'headSha': HEAD, 'runId': RUN, 'attempt': ATTEMPT,
     'jobId': JOB, 'artifactId': ARTIFACT})
try:
    listed = json.loads(command('artifact-list', ['gh', 'api', f'repos/kael-odin/heimdall/actions/runs/{RUN}/artifacts?per_page=100'], 'artifact-list.raw.json'))
    if listed['total_count'] != len(listed['artifacts']): raise ValueError('Artifact list requires pagination')
    matches = [item for item in listed['artifacts'] if item['id'] == ARTIFACT]
    artifact = json.loads(command('artifact-api', ['gh', 'api', f'repos/kael-odin/heimdall/actions/artifacts/{ARTIFACT}'], 'artifact-api.raw.json'))
    run = json.loads((OUT / 'run-attempt.raw.json').read_bytes())
    binding = artifact['workflow_run']
    if not (len(matches) == 1 and matches[0] == artifact and artifact['name'] == 'manual-defect-ticket-decisions-1'
            and artifact['expired'] is False and binding['id'] == RUN and binding['head_sha'] == HEAD
            and binding['repository_id'] == run['repository']['id'] and 0 < artifact['size_in_bytes'] < 128 * 1024 * 1024):
        raise ValueError('Artifact identity mismatch')
    raw = command('artifact-zip', ['gh', 'api', f'repos/kael-odin/heimdall/actions/artifacts/{ARTIFACT}/zip'], 'artifact-original.zip')
    if len(raw) != artifact['size_in_bytes']: raise ValueError('Artifact ZIP size mismatch')
    if artifact.get('digest') is not None and artifact['digest'] != 'sha256:' + sha(raw): raise ValueError('Artifact ZIP digest mismatch')
    selected = {}
    with zipfile.ZipFile(OUT / 'artifact-original.zip') as archive:
        infos = archive.infolist()
        if not (0 < len(infos) <= 20000 and sum(item.file_size for item in infos) <= 1024 * 1024 * 1024): raise ValueError('ZIP limits')
        seen = set()
        for item in infos:
            name = item.filename
            if PurePosixPath(name).is_absolute() or '\\' in name or any(part in ('', '.', '..') for part in name.rstrip('/').split('/')):
                raise ValueError('Unsafe ZIP member')
            if name.casefold() in seen or item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16): raise ValueError('Unsafe/duplicate ZIP member')
            seen.add(name.casefold())
        if archive.testzip() is not None: raise ValueError('ZIP CRC failed')
        for name in ('core/workspace/_runs/defect-ticket-decisions-ci/failure.json', 'core/workspace/_runs/defect-ticket-decisions-ci/summary.json'):
            if name not in archive.namelist():
                selected[name] = {'exists': False}; continue
            item = archive.getinfo(name)
            if item.is_dir() or item.file_size > 16 * 1024 * 1024: raise ValueError('Selected member limit')
            data = archive.read(item)
            destination = 'artifact-' + PurePosixPath(name).name
            put(destination, data)
            selected[name] = {'exists': True, 'file': destination, 'bytes': len(data), 'sha256': sha(data), 'value': json.loads(data)}
    result = {'kind': 'early-failed-artifact-diagnosis-not-ci-acceptance', 'headSha': HEAD, 'runId': RUN,
              'attempt': ATTEMPT, 'artifactId': ARTIFACT, 'identityMatches': True, 'zipBytes': len(raw),
              'zipSha256': sha(raw), 'zipCRC': True, 'selected': selected, 'directory': str(OUT)}
    save('artifact-diagnosis-result.json', result)
    print(json.dumps(result, ensure_ascii=False))
except Exception as error:
    save('artifact-diagnosis-failure.json', {'at': now(), 'type': type(error).__name__, 'message': str(error)})
    raise
