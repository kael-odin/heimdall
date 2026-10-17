import datetime, hashlib, json, os, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
OUT = pathlib.Path(__file__).resolve().parent
CORE = ROOT / 'core'
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def write(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
def inputs():
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    return {p: sha(ROOT / p) for p in names if p and (p.startswith(('core/src/', 'core/scripts/', 'core/test/', 'console/src/', '.github/')) or p in ['package.json', 'core/package.json', 'core/pnpm-lock.yaml', 'console/package.json', 'console/pnpm-lock.yaml', 'console/vite.config.js'])}

if sys.argv[1] == 'policy':
    cases = []
    files = sorted('test/' + p.name for p in (CORE / 'test').iterdir() if p.is_file() and p.name.endswith('.test.mjs'))
    loader = (OUT / 'policy-loader.mjs').as_uri()
    specs = [(p, [], [f'--test-concurrency={c}'], '0', 0) for p, c in [(1, 1), (2, 2), (3, 2), (4, 3), (5, 4), (64, 4)]]
    specs += [(2, ['--test-concurrency=1'], ['--test-concurrency=1'], '0', 0), (2, ['--test-concurrency', '3'], ['--test-concurrency', '3'], '0', 0), (64, ['--test-concurrency=7', '--test-name-pattern=example'], ['--test-concurrency=7', '--test-name-pattern=example'], '0', 0), (2, [], ['--test-concurrency=2'], '17', 17), (2, [], ['--test-concurrency=2'], 'null', 1)]
    for cpus, args, expected, status, code in specs:
        env = dict(os.environ, HEIMDALL_POLICY_CPUS=str(cpus), HEIMDALL_POLICY_STATUS=status)
        result = subprocess.run(['node', '--loader', loader, 'scripts/test-core.mjs', *args], cwd=CORE, env=env, capture_output=True, text=True, encoding='utf-8')
        invocation = json.loads(result.stdout)
        checks = {'arguments': invocation['args'] == ['--test', *expected, *files], 'cwd': pathlib.Path(invocation['cwd']).resolve() == CORE, 'stdio': invocation['stdio'] == 'inherit', 'exitCode': result.returncode == code, 'files': len(files) == 229, 'oneSpawn': result.stdout.count('"executable"') == 1}
        cases.append({'cpus': cpus, 'cliArgs': args, 'childStatus': status, 'exitCode': result.returncode, 'checks': checks, 'invocation': invocation, 'passed': all(checks.values())})
    report = {'at': now(), 'method': 'Actual maintained driver with ESM loader replacing only os parallelism and child process invocation; actual top-level maintained test discovery', 'driverSha256': sha(CORE / 'scripts/test-core.mjs'), 'loaderSha256': sha(OUT / 'policy-loader.mjs'), 'testCount': len(files), 'cases': cases, 'passed': all(c['passed'] for c in cases)}
    write('policy.json', report)
    print(json.dumps({'passed': report['passed'], 'cases': len(cases), 'testFiles': len(files)}))
    sys.exit(0 if report['passed'] else 1)

if sys.argv[1] == 'gates':
    before = inputs()
    write('inputs-before.json', before)
    results = []
    for name, argv, cwd in [('core-concurrency2', ['node', 'scripts/test-core.mjs', '--test-concurrency=2'], CORE), ('lint', ['node', 'scripts/check-syntax.mjs'], CORE), ('docs', ['node', 'scripts/check-markdown-links.mjs'], CORE)]:
        started = now()
        print(json.dumps({'gate': name, 'started': started}), flush=True)
        with (OUT / (name + '.log')).open('wb') as output:
            result = subprocess.run(argv, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
        item = {'gate': name, 'argv': argv, 'cwd': str(cwd), 'started': started, 'ended': now(), 'exitCode': result.returncode, 'logSha256': sha(OUT / (name + '.log'))}
        results.append(item)
        write('gates.json', {'results': results, 'complete': False})
        print(json.dumps(item), flush=True)
        if result.returncode: break
    after = inputs()
    write('inputs-after.json', after)
    unchanged = before == after
    passed = len(results) == 3 and all(r['exitCode'] == 0 for r in results) and unchanged
    write('gates.json', {'results': results, 'complete': True, 'inputsUnchanged': unchanged, 'inputCount': len(before), 'passed': passed})
    print(json.dumps({'passed': passed, 'inputsUnchanged': unchanged, 'inputCount': len(before)}), flush=True)
    sys.exit(0 if passed else 1)
