"""Run maintained gates sequentially, retaining raw output and input identities."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('group', choices=['static', 'core', 'browser', 'docs'])
args = parser.parse_args()
repo = Path(__file__).resolve().parents[4]
out = Path(__file__).resolve().parent / ('final-' + args.group + '-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ'))
out.mkdir()

def encode(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def inputs():
    paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--',
        'core/src', 'core/test', 'core/scripts', 'console/src', 'config', '.github/workflows',
        'package.json', 'core/package.json', 'console/package.json', 'console/vite.config.js',
        'pnpm-lock.yaml', 'core/pnpm-lock.yaml', 'console/pnpm-lock.yaml'], cwd=repo).decode().splitlines()
    return {path: hashlib.sha256((repo / path).read_bytes()).hexdigest()
        for path in sorted(set(paths)) if (repo / path).is_file()}

smokes = ['acceptance:smoke', 'acceptance:spec:smoke', 'acceptance:comparison:smoke',
    'acceptance:catalog:smoke', 'acceptance:catalog:migration:smoke', 'acceptance:baseline:smoke',
    'acceptance:managed:prepare:smoke', 'acceptance:managed:read:smoke', 'acceptance:owned:recovery:smoke',
    'acceptance:managed:execute:smoke', 'acceptance:execution:ui:smoke', 'acceptance:browser:source:smoke',
    'acceptance:browser:read:smoke', 'acceptance:browser:bindings:smoke', 'acceptance:browser:bindings:ui:smoke',
    'acceptance:browser:bindings:v4:smoke', 'acceptance:browser:candidates:ui:smoke',
    'acceptance:browser:execute:smoke', 'acceptance:browser:resolution:smoke', 'acceptance:defect:tickets:smoke']
scripts = json.loads((repo / 'core/package.json').read_text(encoding='utf-8'))['scripts']
stages = []

def add(name, argv, cwd=repo, env=None):
    stages.append({'name': name, 'argv': [str(value) for value in argv], 'cwd': str(cwd), 'environment': env or {}})

if args.group == 'static':
    add('lint', ['node', 'core/scripts/check-syntax.mjs'])
    add('build', ['node', 'node_modules/vite/bin/vite.js', 'build'], repo / 'console')
elif args.group == 'core':
    add('core', ['node', 'core/scripts/test-core.mjs'])
elif args.group == 'docs':
    add('docs', ['node', 'core/scripts/check-markdown-links.mjs'])
else:
    for index, name in enumerate(smokes, start=1):
        argv = shlex.split(scripts[name])
        assert argv[0] == 'node' and argv[1].startswith('scripts/')
        argv[1] = 'core/' + argv[1]
        add(f'{index:02d}-' + name.replace(':', '-'), argv + [out / f'{index:02d}-artifacts'])
    decision_out = out / '21-decision-artifacts'
    add('21-manual-decisions', ['node', 'core/scripts/smoke-acceptance-defect-ticket-decisions-console.mjs', decision_out])
    add('22-verify-manual-decisions', ['node', 'core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs', decision_out])
    add('23-forge', ['node', 'core/scripts/smoke-forge.mjs'])
    for index, script in enumerate(['benchmark-acceptance.mjs', 'benchmark-acceptance-spec.mjs', 'benchmark-acceptance-comparison.mjs'], start=24):
        add(str(index) + '-' + script.removesuffix('.mjs'), ['node', 'core/scripts/' + script, out / (str(index) + '-artifacts')])
    add('27-real-cdp', ['node', 'core/scripts/smoke-console-cdp.mjs', out / '27-cdp-artifacts'], env={'HEIMDALL_E2E_CDP_SELF': '1'})

before = inputs()
encode(out / 'inputs-before.json', before)
batch = {'schemaVersion': 1, 'group': args.group, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'endedAt': None, 'passed': False, 'status': 'running', 'plannedStages': stages, 'stages': []}
encode(out / 'batch.json', batch)
print(str(out), flush=True)
exit_code = 0
for stage in stages:
    folder = out / stage['name']
    folder.mkdir()
    initial = inputs()
    encode(folder / 'inputs-before.json', initial)
    run = {**stage, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exitCode': None}
    encode(folder / 'run.json', run)
    print(json.dumps({'event': 'stage-start', 'name': stage['name'], 'at': run['startedAt']}, ensure_ascii=False), flush=True)
    env = os.environ.copy()
    env.update(stage['environment'])
    started = time.monotonic()
    with (folder / 'stdout.log').open('wb') as stdout, (folder / 'stderr.log').open('wb') as stderr:
        process = subprocess.Popen(stage['argv'], cwd=stage['cwd'], env=env, stdout=stdout, stderr=stderr)
        run['pid'] = process.pid
        encode(folder / 'run.json', run)
        code = process.wait()
    final = inputs()
    encode(folder / 'inputs-after.json', final)
    changed = [path for path in sorted(set(initial) | set(final)) if initial.get(path) != final.get(path)]
    run.update(exitCode=code, endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        durationSeconds=time.monotonic() - started, changedInputs=changed,
        stdoutSha256=hashlib.sha256((folder / 'stdout.log').read_bytes()).hexdigest(),
        stderrSha256=hashlib.sha256((folder / 'stderr.log').read_bytes()).hexdigest())
    encode(folder / 'run.json', run)
    batch['stages'].append(run)
    encode(out / 'batch.json', batch)
    print(json.dumps({'event': 'stage-end', 'name': stage['name'], 'exitCode': code, 'changedInputs': changed,
        'durationSeconds': run['durationSeconds']}, ensure_ascii=False), flush=True)
    if code or changed:
        exit_code = code or 1
        break
after = inputs()
encode(out / 'inputs-after.json', after)
batch.update(endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), status='completed',
    changedInputs=[path for path in sorted(set(before) | set(after)) if before.get(path) != after.get(path)],
    passed=exit_code == 0 and before == after and len(batch['stages']) == len(stages))
encode(out / 'batch.json', batch)
print(json.dumps({key: value for key, value in batch.items() if key not in ['stages', 'plannedStages']}, ensure_ascii=False), flush=True)
sys.exit(0 if batch['passed'] else exit_code or 1)
