from pathlib import Path
import datetime, hashlib, json, subprocess, sys

OUT = Path(__file__).resolve().parent
REPO = OUT.parents[4]
HEAD = '06e4303871d485a14b66d24318db80595a3db774'
RUN, ATTEMPT, JOB = 39096514869, 1, 117583999059
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(data): return hashlib.sha256(data).hexdigest()
def put(name, data):
    with (OUT / name).open('xb') as handle: handle.write(data)
    if (OUT / name).read_bytes() != data: raise ValueError('Written bytes differ: ' + name)
def save(name, value): put(name, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
def command(label, argv, stdout_name):
    started = now()
    timed_out, launch_error = False, None
    try:
        result = subprocess.run(argv, cwd=REPO, capture_output=True, timeout=55)
        stdout, stderr, code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        timed_out = True
        stdout, stderr, code = error.stdout or b'', error.stderr or b'', None
    except OSError as error:
        stdout, stderr, code = b'', b'', None
        launch_error = {'type': type(error).__name__, 'message': str(error)}
    put(stdout_name, stdout); put(label + '.stderr.log', stderr)
    save(label + '.command.json', {'argv': argv, 'cwd': str(REPO), 'startedAt': started, 'endedAt': now(),
         'exitCode': code, 'timedOut': timed_out, 'launchError': launch_error, 'stdoutFile': stdout_name, 'stdoutBytes': len(stdout),
         'stdoutSha256': sha(stdout), 'stderrFile': label + '.stderr.log',
         'stderrBytes': len(stderr), 'stderrSha256': sha(stderr)})
    if code != 0: raise ValueError(label + ' failed: ' + str(code))
    return stdout

save('runtime.json', {'argv': sys.argv, 'python': sys.version, 'scriptSha256': sha(Path(__file__).read_bytes()),
     'kind': 'early-completed-job-diagnosis-not-full-ci-capture', 'headSha': HEAD, 'runId': RUN, 'attempt': ATTEMPT, 'jobId': JOB})
try:
    run = json.loads(command('run-attempt', ['gh', 'api', f'repos/kael-odin/heimdall/actions/runs/{RUN}/attempts/{ATTEMPT}'], 'run-attempt.raw.json'))
    job = json.loads(command('job', ['gh', 'api', f'repos/kael-odin/heimdall/actions/jobs/{JOB}'], 'job.raw.json'))
    if not (run['id'] == RUN and run['run_attempt'] == ATTEMPT and run['head_sha'] == HEAD and run['head_branch'] == 'main'
            and run['event'] == 'push' and run['name'] == 'CI' and run['path'] == '.github/workflows/ci.yml'
            and run['workflow_id'] == 378229882 and run['repository']['full_name'] == 'kael-odin/heimdall'):
        raise ValueError('Run identity mismatch')
    if not (job['id'] == JOB and job['run_id'] == RUN and job['run_attempt'] == ATTEMPT and job['head_sha'] == HEAD
            and job['name'] == 'core (e2e smoke, local fixture)' and job['status'] == 'completed' and job['conclusion'] == 'failure'):
        raise ValueError('Completed failed job identity mismatch')
    data = command('job-log', ['gh', 'api', f'repos/kael-odin/heimdall/actions/jobs/{JOB}/logs'], 'job.raw.log')
    result = {'kind': 'early-completed-job-diagnosis-not-full-ci-capture', 'headSha': HEAD, 'runId': RUN, 'attempt': ATTEMPT,
              'jobId': JOB, 'runStatusAtCapture': run['status'], 'jobConclusion': job['conclusion'], 'identityMatches': True,
              'failedSteps': [s for s in job['steps'] if s['conclusion'] == 'failure'],
              'logBytes': len(data), 'logSha256': sha(data), 'directory': str(OUT)}
    save('diagnosis-capture.json', result)
    print(json.dumps(result, ensure_ascii=False))
except Exception as error:
    save('diagnosis-failure.json', {'at': now(), 'type': type(error).__name__, 'message': str(error)})
    raise
