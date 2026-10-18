from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
NODE = Path('C:/Program Files/nodejs/node.exe')
SCRIPT = HERE / 'http-keepalive-loopback.mjs'
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
OUT = HERE / ('http-keepalive-loopback-' + stamp)
OUT.mkdir()
argv = [str(NODE), str(SCRIPT), str(OUT / 'experiment')]
def identity(path):
    raw = path.read_bytes()
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
def write(metadata):
    (OUT / 'command.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
metadata = {'schemaVersion': 1, 'argv': argv, 'cwd': str(ROOT), 'startedAt': datetime.now(timezone.utc).isoformat(),
    'node': identity(NODE), 'scriptBefore': identity(SCRIPT), 'retryCount': 0, 'maintainedFilesModified': [],
    'engineBrowserOrMaintainedTestStarted': False, 'exitCode': None}
write(metadata)
print(str(OUT), flush=True)
started = time.monotonic()
with (OUT / 'stdout.log').open('wb') as stdout, (OUT / 'stderr.log').open('wb') as stderr:
    process = subprocess.run(argv, cwd=ROOT, stdout=stdout, stderr=stderr)
metadata.update({'endedAt': datetime.now(timezone.utc).isoformat(), 'durationSeconds': time.monotonic() - started,
    'exitCode': process.returncode, 'stdout': identity(OUT / 'stdout.log'), 'stderr': identity(OUT / 'stderr.log'),
    'scriptAfter': identity(SCRIPT)})
metadata['scriptUnchanged'] = metadata['scriptBefore'] == metadata['scriptAfter']
write(metadata)
print(json.dumps(metadata, ensure_ascii=False), flush=True)
result = OUT / 'experiment/result.json'
if result.exists():
    value = json.loads(result.read_text(encoding='utf-8'))
    print(json.dumps({'fetchLateFailureReproduced': value['fetchLateFailureReproduced'],
        'freshAgentLateSucceeded': value['freshAgentLateSucceeded'],
        'modes': [{key: mode[key] for key in ['mode', 'timeouts', 'actualBlockMs', 'connectionsOpened', 'first', 'late', 'requests']} for mode in value['modes']]}, ensure_ascii=False), flush=True)
raise SystemExit(process.returncode)
