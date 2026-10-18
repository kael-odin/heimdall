"""D5 exact-head immutable Actions capture with required caller-supplied identity.

Explicit checks also work with Python optimization enabled. Every invocation adds
a fresh directory beneath this script's own ignored evidence root.
"""
from pathlib import Path, PurePosixPath
from concurrent.futures import ThreadPoolExecutor
import argparse
import base64
import datetime
import hashlib
import json
import platform
import re
import stat
import subprocess
import sys
import zipfile

REPO = "kael-odin/heimdall"
ATTEMPT = 1
JOBS = {"console (build)", "core (e2e smoke, local fixture)", "core (lint + test)"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def full_head(value):
    if not re.fullmatch(r"[0-9a-fA-F]{40}", value):
        raise argparse.ArgumentTypeError("--head must contain exactly 40 hexadecimal characters")
    return value.lower()


def positive_run(value):
    try:
        result = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("--run must be a positive integer") from error
    if result <= 0:
        raise argparse.ArgumentTypeError("--run must be a positive integer")
    return result


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def new(folder, name, data):
    file = folder / name
    file.resolve().relative_to(folder.resolve())
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("xb") as stream:
        stream.write(data)
    require(file.read_bytes() == data, "Written bytes differ: " + name)


def read(folder, name):
    return json.loads((folder / name).read_bytes())


def record(folder, name, command, output, cwd):
    started = now()
    timed_out, launch_error = False, None
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=55)
        stdout, stderr, code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        timed_out = True
        stdout, stderr, code = error.stdout or b"", error.stderr or b"", None
    except OSError as error:
        stdout, stderr, code = b"", b"", None
        launch_error = {"type": type(error).__name__, "message": str(error)}
    new(folder, output, stdout)
    new(folder, name + ".stderr.log", stderr)
    meta = {"command": command, "cwd": str(cwd), "startedAt": started, "endedAt": now(),
            "exitCode": code, "timedOut": timed_out, "launchError": launch_error,
            "stdoutFile": output, "stdoutBytes": len(stdout), "stdoutSha256": sha(stdout),
            "stderrFile": name + ".stderr.log", "stderrBytes": len(stderr), "stderrSha256": sha(stderr)}
    new(folder, name + ".command.json", encoded(meta))
    return {"name": name, "exitCode": code, "timedOut": timed_out, "launchError": launch_error, "output": output}


def batch(folder, commands, cwd):
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda item: record(folder, *item, cwd), commands))
    new(folder, "command-results.json", encoded(results))
    require(all(item["exitCode"] == 0 and not item["timedOut"] and not item["launchError"] for item in results),
            "One or more capture commands failed: " + json.dumps(results))


def binding(run, jobs, head, run_id):
    require(run["id"] == run_id and run["head_sha"] == head and run["run_attempt"] == ATTEMPT,
            "Run/head/attempt mismatch")
    require(run["head_branch"] == "main" and run["event"] == "push", "Branch/event mismatch")
    require(run["path"] == ".github/workflows/ci.yml" and run["name"] == "CI" and
            run["workflow_id"] == 378229882 and run["repository"]["full_name"] == REPO, "Workflow/repo mismatch")
    require(jobs["total_count"] == len(jobs["jobs"]) == 3, "Incomplete jobs API")
    require({job["name"] for job in jobs["jobs"]} == JOBS, "Unexpected job names")
    require(len({job["id"] for job in jobs["jobs"]}) == 3, "Duplicate job IDs")
    require(all(job["run_id"] == run_id and job["head_sha"] == head and job["run_attempt"] == ATTEMPT
                for job in jobs["jobs"]), "Job run/head/attempt mismatch")


def safe_member(item):
    name = item.filename
    require(not PurePosixPath(name).is_absolute() and "\\" not in name, "Unsafe ZIP path")
    pieces = name.rstrip("/").split("/") if item.is_dir() else name.split("/")
    require(all(part not in ("", ".", "..") for part in pieces), "Unsafe ZIP component")
    for part in pieces:
        require(not re.search(r'[<>:"|?*\x00-\x1f]', part) and not part.endswith((" ", ".")), "Unsafe Windows name")
        require(not re.fullmatch(r"(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])", part.split(".")[0]),
                "Reserved Windows name")
    require(not stat.S_ISLNK(item.external_attr >> 16) and not item.flag_bits & 1, "Symlink/encrypted ZIP member")
    return name


def main(args):
    HEAD, RUN = args.head, args.run
    cwd = Path.cwd().resolve()
    out = Path(args.out).resolve()
    require(out == Path(__file__).resolve().parent, "Output must remain inside the dedicated D5 CI root")
    require((args.repo, args.attempt) == (REPO, ATTEMPT), "Only kael-odin/heimdall attempt 1 is allowed")
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    folder = out / ("observations/" + timestamp if args.mode == "observe" else "final-" + timestamp)
    folder.mkdir(parents=True, exist_ok=False)
    new(folder, "capture-runtime.json", encoded({"recordedAt": now(), "python": platform.python_version(),
        "executable": sys.executable, "optimization": sys.flags.optimize, "argv": sys.argv,
        "scriptPath": str(Path(__file__).resolve()), "scriptSha256": sha(Path(__file__).read_bytes()),
        "requestedIdentity": {"repo": REPO, "runId": RUN, "attempt": ATTEMPT, "headSha": HEAD,
            "workflow": "CI", "branch": "main", "event": "push"}}))
    prefix = f"repos/{REPO}/actions/runs/{RUN}"
    commands = [("run", ["gh", "api", prefix + f"/attempts/{ATTEMPT}"], "run.json"),
                ("jobs", ["gh", "api", prefix + f"/attempts/{ATTEMPT}/jobs?per_page=100"], "jobs.json")]
    if args.mode == "observe":
        commands.append(("head-runs", ["gh", "api", f"repos/{REPO}/actions/runs", "--method", "GET",
            "-f", "head_sha=" + HEAD, "-f", "branch=main", "-f", "per_page=100"], "head-runs.json"))
    try:
        batch(folder, commands, cwd)
        run, jobs = read(folder, "run.json"), read(folder, "jobs.json")
        binding(run, jobs, HEAD, RUN)
        state = {"recordedAt": now(), "runId": RUN, "runAttempt": ATTEMPT, "headSha": HEAD,
            "status": run["status"], "conclusion": run["conclusion"], "runUrl": run["html_url"],
            "jobs": [{"id": job["id"], "name": job["name"], "status": job["status"], "conclusion": job["conclusion"],
                "currentSteps": [step["name"] for step in job["steps"] if step["status"] == "in_progress"]} for job in jobs["jobs"]]}
        new(folder, "observation-summary.json", encoded(state))
        if args.mode == "observe":
            require(any(item["id"] == RUN and item["head_sha"] == HEAD for item in read(folder, "head-runs.json")["workflow_runs"]),
                    "Head-filtered run list does not contain this run")
            print(json.dumps({"directory": str(folder), **state}, ensure_ascii=False), flush=True)
            return
        require(run["status"] == "completed" and all(job["status"] == "completed" for job in jobs["jobs"]),
                "Final capture requires this exact attempt and every job to be completed")
        download = folder / "downloads"
        batch(download, [
            ("full-log", ["gh", "run", "view", str(RUN), "--repo", REPO, "--attempt", str(ATTEMPT), "--log"], "complete-stdout.log"),
            ("logs-zip", ["gh", "api", prefix + f"/attempts/{ATTEMPT}/logs"], "run-logs.zip"),
            ("workflow-api", ["gh", "api", f"repos/{REPO}/contents/.github/workflows/ci.yml?ref={HEAD}"], "workflow-content-api.json"),
            ("workflow-git", ["git", "show", HEAD + ":.github/workflows/ci.yml"], "workflow-at-head.yml")], cwd)
        workflow = read(download, "workflow-content-api.json")
        require(workflow["path"] == ".github/workflows/ci.yml" and workflow["encoding"] == "base64", "Workflow API identity mismatch")
        workflow_bytes = base64.b64decode(workflow["content"], validate=False)
        blob = hashlib.sha1(b"blob " + str(len(workflow_bytes)).encode("ascii") + b"\0" + workflow_bytes).hexdigest()
        require(workflow_bytes == (download / "workflow-at-head.yml").read_bytes(), "Workflow API differs from git show")
        require(workflow["size"] == len(workflow_bytes) and workflow["sha"] == blob, "Workflow size/blob mismatch")
        new(folder, "workflow-identity.json", encoded({"headSha": HEAD, "path": workflow["path"], "gitBlobSha": blob,
            "bytes": len(workflow_bytes), "sha256": sha(workflow_bytes), "apiMatchesGitShow": True, "computedBlobMatchesApi": True}))
        entries, seen = [], set()
        zip_bytes = (download / "run-logs.zip").read_bytes()
        require(len(zip_bytes) <= 128 * 1024 * 1024, "ZIP exceeds capture byte limit")
        with zipfile.ZipFile(download / "run-logs.zip") as archive:
            members = archive.infolist()
            require(0 < len(members) <= 500 and sum(item.file_size for item in members) <= 256 * 1024 * 1024,
                    "ZIP member/count size limit")
            require(archive.testzip() is None, "ZIP CRC failed")
            for item in members:
                name = safe_member(item)
                require(name.casefold() not in seen, "Duplicate ZIP name")
                seen.add(name.casefold())
                require(item.file_size <= 64 * 1024 * 1024, "Oversized ZIP member")
                if item.is_dir():
                    continue
                data = archive.read(item)
                new(folder, "logs/" + name, data)
                actual = (folder / "logs" / name).read_bytes()
                require(actual == data, "Expanded ZIP differs from archive")
                entries.append({"path": name, "bytes": len(actual), "sha256": sha(actual), "crc32": f"{item.CRC:08x}"})
        require(entries, "Empty logs ZIP")
        new(folder, "capture-summary.json", encoded({"captured": True, "runId": RUN, "runAttempt": ATTEMPT, "headSha": HEAD,
            "status": run["status"], "conclusion": run["conclusion"], "jobs": state["jobs"], "zipCRC": True,
            "zipBytes": len(zip_bytes), "zipSha256": sha(zip_bytes), "logFiles": entries}))
        print(json.dumps({"captured": True, "directory": str(folder), "runId": RUN, "headSha": HEAD,
            "conclusion": run["conclusion"], "jobs": len(jobs["jobs"]), "logEntries": len(entries)}, ensure_ascii=False), flush=True)
    except Exception as error:
        new(folder, "capture-failure.json", encoded({"recordedAt": now(), "type": type(error).__name__, "message": str(error),
            "runId": RUN, "headSha": HEAD}))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("observe", "final"))
    parser.add_argument("--repo", required=True)
    parser.add_argument("--run", type=positive_run, required=True)
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--head", type=full_head, required=True)
    parser.add_argument("--out", required=True)
    main(parser.parse_args())
