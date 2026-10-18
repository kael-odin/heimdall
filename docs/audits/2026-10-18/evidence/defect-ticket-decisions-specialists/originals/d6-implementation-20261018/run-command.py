import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--name', required=True)
parser.add_argument('--env', action='append', default=[])
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command:
    parser.error('a command is required')
repo = Path(__file__).resolve().parents[4]
out = Path(__file__).resolve().parent / (args.name + '-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ'))
out.mkdir()
def encode(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
def inputs():
    paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--',
        'core/src', 'core/test', 'core/scripts', 'console/src', '.github/workflows', 'package.json',
        'core/package.json', 'console/package.json', 'core/pnpm-lock.yaml', 'console/pnpm-lock.yaml'], cwd=repo).decode().splitlines()
    return {path: hashlib.sha256((repo / path).read_bytes()).hexdigest() for path in sorted(set(paths)) if (repo / path).is_file()}
before = inputs()
encode(out / 'inputs-before.json', before)
env = os.environ.copy()
explicit_env = {}
for assignment in args.env:
    key, value = assignment.split('=', 1)
    explicit_env[key] = value
    env[key] = value
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
metadata = {'schemaVersion': 1, 'argv': command, 'cwd': str(repo), 'explicitEnvironment': explicit_env,
    'platform': platform.platform(), 'startedAt': started, 'exitCode': None}
encode(out / 'run.json', metadata)
print(str(out), flush=True)
monotonic_start = time.monotonic()
with (out / 'stdout.log').open('wb') as stdout, (out / 'stderr.log').open('wb') as stderr:
    result = subprocess.run(command, cwd=repo, env=env, stdout=stdout, stderr=stderr)
after = inputs()
encode(out / 'inputs-after.json', after)
metadata.update(endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    durationSeconds=time.monotonic() - monotonic_start, exitCode=result.returncode,
    changedInputs=[path for path in sorted(set(before) | set(after)) if before.get(path) != after.get(path)],
    stdoutSha256=hashlib.sha256((out / 'stdout.log').read_bytes()).hexdigest(),
    stderrSha256=hashlib.sha256((out / 'stderr.log').read_bytes()).hexdigest())
encode(out / 'run.json', metadata)
print(json.dumps(metadata, ensure_ascii=False), flush=True)
print((out / 'stdout.log').read_text(encoding='utf-8', errors='replace')[-8000:], flush=True)
print((out / 'stderr.log').read_text(encoding='utf-8', errors='replace')[-4000:], flush=True)
sys.exit(result.returncode)
