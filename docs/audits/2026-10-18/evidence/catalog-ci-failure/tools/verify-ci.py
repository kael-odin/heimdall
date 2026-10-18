"""Independently verify D5 captured originals for required head/run parameters."""
from pathlib import Path, PurePosixPath
from collections import defaultdict
import argparse
import base64
import datetime
import hashlib
import json
import re
import sys
import zipfile
import zlib

REPO = "kael-odin/heimdall"
ATTEMPT = 1
CORE = "core (lint + test)"
SMOKE = "core (e2e smoke, local fixture)"
CONSOLE = "console (build)"
DIAGNOSTIC = "Preserve acceptance smoke failure diagnostics"
SMOKE_COMMANDS = ["acceptance:smoke", "acceptance:spec:smoke", "acceptance:comparison:smoke",
    "acceptance:catalog:smoke", "acceptance:catalog:migration:smoke", "acceptance:baseline:smoke",
    "acceptance:managed:prepare:smoke", "acceptance:managed:read:smoke", "acceptance:owned:recovery:smoke",
    "acceptance:managed:execute:smoke", "acceptance:execution:ui:smoke", "acceptance:browser:source:smoke",
    "acceptance:browser:read:smoke", "acceptance:browser:bindings:smoke", "acceptance:browser:bindings:ui:smoke",
    "acceptance:browser:bindings:v4:smoke", "acceptance:browser:candidates:ui:smoke",
    "acceptance:browser:execute:smoke", "acceptance:browser:resolution:smoke",
    "acceptance:defect:tickets:smoke"]
D5_CHECKS = {
    "realSourceAndRegisteredVisualBehaviorFailures",
    "fixedMembersAndLostCreateReconcileAfterReloadWithoutPost",
    "partialRepairCannotCloseFixedMemberSet",
    "allMembersRequireExplicitCloseAndLostCloseUsesOnlyGet",
    "reliableFailureReopensAndLaterPassDoesNotAutoClose",
    "definiteStalePostRetainsDraftAndRequiresFreshExplicitPreview",
    "markdownAndJsonDownloadsPreserveHistoryAndOmitRecognizedSecrets",
    "restartReadsExactTicketWithoutStartingOrRegisteringBrowserWork",
    "renderedDesktopMobileAndOriginalSourceIntegrity",
    "consoleErrorsAreOnlyTheExplicitControlledHttpFailures",
}
D5_CAPTURES = ["defect-ticket-open-desktop.png", "defect-ticket-open-mobile.png",
    "defect-ticket-reopened-desktop.png", "defect-ticket-reopened-mobile.png"]
SKIPS = ["real Windows reader holding a non-delete-sharing file handle releases after 180ms and replacement succeeds",
    "real Windows non-share-delete reader releases and replacement retries successfully",
    "Docker network-none delivery serves SSR, SPA and data-driven SPA bundles without a source workspace",
    "Docker network-none delivery persists adapter writes in a volume after container recreation"]
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
PRINTED_ANSI = re.compile(r"\^\[\[[0-?]*[ -/]*[@-~]")
TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?")


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


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def normalized(lines):
    return [TIME.sub("", PRINTED_ANSI.sub("", ANSI.sub("", line)).replace("\ufeff", "")) for line in lines]


def workflow_runs(text, job_id):
    match = re.search(r"^  " + re.escape(job_id) + r":\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)", text, re.M | re.S)
    if not match:
        return []
    output = []
    for item in re.finditer(r"^      - (?:name: (.+)\n        run: (.+)|run: (.+))$", match.group(1), re.M):
        command = item.group(2) or item.group(3)
        output.append({"name": item.group(1) or "Run " + command, "command": command})
    return output


def main(args):
    HEAD, RUN = args.head, args.run
    if args.attempt != ATTEMPT:
        raise ValueError("Only kael-odin/heimdall attempt 1 is allowed")
    root = Path(__file__).resolve().parent
    source = Path(args.source).resolve()
    source.relative_to(root)
    if source.parent != root or not source.name.startswith("final-"):
        raise ValueError("Use one dedicated D5 final capture directory")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    output = root / ("verification-" + stamp)
    output.mkdir(exist_ok=False)
    checks, data = [], {}

    def check(category, name, condition, detail=None):
        checks.append({"category": category, "name": name, "passed": bool(condition), "detail": detail})
        return bool(condition)

    def guarded(category, name, function, fallback=None):
        try:
            return function()
        except Exception as error:
            check(category, name, False, {"error": type(error).__name__, "message": str(error)})
            return fallback

    def command(folder, name, expected, expected_output):
        meta = read(folder / (name + ".command.json"))
        (folder / meta["stdoutFile"]).resolve().relative_to(folder.resolve())
        (folder / meta["stderrFile"]).resolve().relative_to(folder.resolve())
        actual_out = (folder / meta["stdoutFile"]).read_bytes()
        actual_err = (folder / meta["stderrFile"]).read_bytes()
        check("capture", name + " command and raw bytes", meta["command"] == expected and meta["exitCode"] == 0 and
            meta["stdoutFile"] == expected_output and meta["stderrFile"] == name + ".stderr.log" and
            not meta["timedOut"] and not meta.get("launchError") and
            len(actual_out) == meta["stdoutBytes"] and sha(actual_out) == meta["stdoutSha256"] and
            len(actual_err) == meta["stderrBytes"] and sha(actual_err) == meta["stderrSha256"], meta)

    prefix = f"repos/{REPO}/actions/runs/{RUN}"
    downloads = source / "downloads"
    commands = [(source, "run", ["gh", "api", prefix + f"/attempts/{ATTEMPT}"], "run.json"),
        (source, "jobs", ["gh", "api", prefix + f"/attempts/{ATTEMPT}/jobs?per_page=100"], "jobs.json"),
        (downloads, "full-log", ["gh", "run", "view", str(RUN), "--repo", REPO, "--attempt", str(ATTEMPT), "--log"], "complete-stdout.log"),
        (downloads, "logs-zip", ["gh", "api", prefix + f"/attempts/{ATTEMPT}/logs"], "run-logs.zip"),
        (downloads, "workflow-api", ["gh", "api", f"repos/{REPO}/contents/.github/workflows/ci.yml?ref={HEAD}"], "workflow-content-api.json"),
        (downloads, "workflow-git", ["git", "show", HEAD + ":.github/workflows/ci.yml"], "workflow-at-head.yml")]
    for folder, name, expected, expected_output in commands:
        guarded("capture", name + " command metadata", lambda f=folder, n=name, e=expected, o=expected_output: command(f, n, e, o))
    capture = guarded("capture", "capture summary readable", lambda: read(source / "capture-summary.json"), {})
    run = guarded("identity", "run API readable", lambda: read(source / "run.json"), {})
    jobs_api = guarded("identity", "jobs API readable", lambda: read(source / "jobs.json"), {})
    check("identity", "exact D5 run/repo/workflow/attempt/head/event/branch", run.get("id") == RUN and
        run.get("run_attempt") == ATTEMPT and run.get("head_sha") == HEAD and run.get("head_branch") == "main" and
        run.get("event") == "push" and run.get("name") == "CI" and run.get("workflow_id") == 378229882 and
        run.get("path") == ".github/workflows/ci.yml" and run.get("repository", {}).get("full_name") == REPO)
    check("execution", "run completed successfully", run.get("status") == "completed" and run.get("conclusion") == "success",
        {"status": run.get("status"), "conclusion": run.get("conclusion")})
    jobs = jobs_api.get("jobs", [])
    check("capture", "capture summary matches exact completed API and ZIP marker", capture.get("captured") is True and
        capture.get("runId") == RUN and capture.get("runAttempt") == ATTEMPT and capture.get("headSha") == HEAD and
        capture.get("status") == run.get("status") == "completed" and capture.get("conclusion") == run.get("conclusion") and
        capture.get("zipCRC") is True and capture.get("jobs") == [{"id": job["id"], "name": job["name"], "status": job["status"],
            "conclusion": job["conclusion"], "currentSteps": [s["name"] for s in job["steps"] if s["status"] == "in_progress"]} for job in jobs])
    def runtime_binding():
        runtime = read(source / "capture-runtime.json")
        script = root / "capture-v2.py"
        expected_args = ["final", "--repo", REPO, "--run", str(RUN), "--attempt", str(ATTEMPT), "--head", HEAD,
            "--out", "core/workspace/_runs/d5-ci-20261018"]
        runtime_args = list(runtime["argv"][1:])
        if len(runtime_args) == len(expected_args) and isinstance(runtime_args[8], str):
            runtime_args[8] = runtime_args[8].lower()
        check("capture", "reviewed capture-v2 runtime identity", Path(runtime["scriptPath"]).resolve() == script and
            runtime["scriptSha256"] == sha(script.read_bytes()) and runtime_args == expected_args and
            runtime["argv"][0].replace("\\", "/").endswith("/d5-ci-20261018/capture-v2.py") and
            runtime.get("requestedIdentity") == {"repo": REPO, "runId": RUN, "attempt": ATTEMPT, "headSha": HEAD,
                "workflow": "CI", "branch": "main", "event": "push"}, runtime)
        for folder in (source, downloads):
            result = read(folder / "command-results.json")
            expected = [{"name": name, "exitCode": 0, "timedOut": False, "launchError": None, "output": filename}
                for f, name, _, filename in commands if f == folder]
            check("capture", "batch results exact " + folder.name, result == expected)
    guarded("capture", "capture runtime and batch records", runtime_binding)
    check("identity", "exactly three distinct expected jobs", jobs_api.get("total_count") == len(jobs) == 3 and
        {job["name"] for job in jobs} == {CORE, SMOKE, CONSOLE} and len({job["id"] for job in jobs}) == 3)
    for job in jobs:
        check("identity", job["name"] + " run/head/attempt", job.get("run_id") == RUN and job.get("run_attempt") == ATTEMPT and job.get("head_sha") == HEAD)
        check("execution", job["name"] + " completed successfully", job.get("status") == "completed" and job.get("conclusion") == "success")
        numbers = [step["number"] for step in job["steps"]]
        names = [step["name"] for step in job["steps"]]
        check("identity", job["name"] + " unique step identifiers", len(numbers) == len(set(numbers)) and len(names) == len(set(names)))
        for step in job["steps"]:
            expected = "skipped" if step["name"] == DIAGNOSTIC else "success"
            check("execution", job["name"] + " / " + step["name"], step["status"] == "completed" and step["conclusion"] == expected,
                {"number": step["number"], "status": step["status"], "conclusion": step["conclusion"]})

    def verify_workflow():
        api = read(downloads / "workflow-content-api.json")
        contents = base64.b64decode(api["content"])
        git = (downloads / "workflow-at-head.yml").read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(contents)).encode("ascii") + b"\0" + contents).hexdigest()
        identity = read(source / "workflow-identity.json")
        check("identity", "workflow API and exact git bytes/blob", api["path"] == ".github/workflows/ci.yml" and
            api["encoding"] == "base64" and contents == git and api["size"] == len(contents) and api["sha"] == blob and
            identity["headSha"] == HEAD and identity["gitBlobSha"] == blob and identity["sha256"] == sha(contents) and identity["bytes"] == len(contents))
        data["workflow"] = {"gitBlobSha": blob, "sha256": sha(contents), "bytes": len(contents)}
        return contents.decode("utf-8")

    workflow = guarded("identity", "workflow originals", verify_workflow, "")
    contracts = {CORE: workflow_runs(workflow, "core"), SMOKE: workflow_runs(workflow, "smoke"), CONSOLE: workflow_runs(workflow, "console")}
    core_smokes = [item for item in contracts[CORE] if item["command"].startswith("pnpm acceptance:")]
    check("identity", "exact twenty maintained Core smoke commands", [item["command"] for item in core_smokes] == ["pnpm " + c for c in SMOKE_COMMANDS])
    check("identity", "Core 45 minute timeout and explicit Docker env", "timeout-minutes: 45" in workflow and 'HEIMDALL_DOCKER_TEST: "1"' in workflow)
    check("identity", "independent smoke job four checks", [item["command"] for item in contracts[SMOKE]][-4:] ==
        ["pnpm smoke", "pnpm acceptance:benchmark", "pnpm acceptance:spec:benchmark", "pnpm acceptance:comparison:benchmark"])

    def verify_zip():
        raw = (downloads / "run-logs.zip").read_bytes()
        entries = capture["logFiles"]
        manifest = {item["path"]: item for item in entries}
        check("capture", "ZIP digest and manifest unique", capture["zipBytes"] == len(raw) and capture["zipSha256"] == sha(raw) and len(manifest) == len(entries) > 0)
        with zipfile.ZipFile(downloads / "run-logs.zip") as archive:
            check("capture", "ZIP complete CRC", archive.testzip() is None)
            files = [item for item in archive.infolist() if not item.is_dir()]
            check("capture", "ZIP and manifest exact member set", len(files) == len(manifest) and {i.filename for i in files} == set(manifest))
            actual_paths = {file.relative_to(source / "logs").as_posix() for file in (source / "logs").rglob("*") if file.is_file()}
            check("capture", "expanded files exact manifest set", actual_paths == set(manifest))
            for item in files:
                archive_data = archive.read(item)
                disk = (source / "logs" / item.filename).read_bytes()
                meta = manifest[item.filename]
                check("capture", "ZIP member bytes/CRC/SHA " + item.filename, archive_data == disk and
                    len(disk) == meta["bytes"] and sha(disk) == meta["sha256"] and
                    f"{zlib.crc32(disk) & 0xffffffff:08x}" == meta["crc32"] == f"{item.CRC:08x}")
        return manifest

    manifest = guarded("capture", "original ZIP and disk members", verify_zip, {})
    stdout_groups = defaultdict(list)
    def group_stdout():
        unparsed = []
        for line in (downloads / "complete-stdout.log").read_text(encoding="utf-8-sig").splitlines():
            pieces = line.split("\t", 2)
            if len(pieces) == 3 and pieces[0] in {CORE, SMOKE, CONSOLE}:
                stdout_groups[(pieces[0], pieces[1])].append(pieces[2])
            elif line:
                unparsed.append(line)
        check("capture", "gh stdout job prefixes completely parsed", not unparsed, {"unparsedCount": len(unparsed), "samples": unparsed[:3]})
    guarded("capture", "gh raw stdout grouping", group_stdout)
    step_logs = {}
    for job_name, items in contracts.items():
        matching_jobs = [job for job in jobs if job["name"] == job_name]
        if len(matching_jobs) != 1:
            check("execution", "required job missing for log coverage " + job_name, False)
            continue
        job = matching_jobs[0]
        for item in items:
            name = item["name"]
            steps = [step for step in job["steps"] if step["name"] == name]
            if not check("execution", "workflow step API coverage " + job_name + " / " + name, len(steps) == 1):
                continue
            step = steps[0]
            paths = [path for path in manifest if PurePosixPath(path).parent.as_posix() == job_name and
                PurePosixPath(path).name.startswith(str(step["number"]) + "_") and path.endswith(".txt")]
            if not check("capture", "unique step log " + job_name + " / " + name, len(paths) == 1, paths):
                continue
            lines = normalized((source / "logs" / paths[0]).read_text(encoding="utf-8-sig").splitlines())
            gh_lines = normalized(stdout_groups.get((job_name, name), []))
            check("capture", "gh and ZIP step content equal " + job_name + " / " + name, bool(lines) and lines == gh_lines,
                {"zipPath": paths[0], "zipLines": len(lines), "ghLines": len(gh_lines)})
            check("execution", "logged workflow command " + job_name + " / " + name,
                any(line == "##[group]Run " + item["command"] for line in lines), item["command"])
            step_logs[(job_name, name)] = {"path": paths[0], "lines": lines, "step": step}

    def stats(log, name):
        results = defaultdict(list)
        for line in log["lines"]:
            match = re.fullmatch(r"# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)", line)
            if match:
                results[match.group(1)].append(float(match.group(2)) if match.group(1) == "duration_ms" else int(match.group(2)))
        keys = {"tests", "suites", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"}
        check("execution", name + " one terminal stats block", set(results) == keys and all(len(values) == 1 for values in results.values()), dict(results))
        values = {key: result[-1] for key, result in results.items()}
        check("execution", name + " zero failure/cancelled/todo", all(values.get(key) == 0 for key in ("fail", "cancelled", "todo")), values)
        check("execution", name + " no not-ok TAP result", not any(re.match(r"^\s*not ok \d+", line) for line in log["lines"]))
        return values

    main_log = step_logs.get((CORE, "Run pnpm test"))
    if main_log:
        main_stats = stats(main_log, "main Core")
        skips = [match.group(1) for line in main_log["lines"] if (match := re.fullmatch(r"\s*ok \d+ - (.+) # SKIP(?: .*)?", line))]
        check("execution", "main Core four expected Linux skips", sorted(skips) == sorted(SKIPS) and main_stats.get("skipped") == 4, skips)
        check("execution", "main Core totals reconcile", main_stats.get("tests", 0) > 0 and
            main_stats.get("tests") == main_stats.get("pass", -10) + 4, main_stats)
        data["coreTest"] = {"path": main_log["path"], "stats": main_stats, "skippedTests": skips}
    else:
        check("execution", "main Core stats available", False)
    data["coreSmokes"] = []
    for item in core_smokes:
        log = step_logs.get((CORE, item["name"]))
        record = {"command": item["command"], "name": item["name"], "path": log["path"] if log else None,
            "apiConclusion": log["step"]["conclusion"] if log else None}
        if log and item["command"] in ("pnpm acceptance:browser:execute:smoke", "pnpm acceptance:browser:resolution:smoke"):
            events = []
            for line in log["lines"]:
                if line.startswith("{"):
                    try:
                        event = json.loads(line)
                        if isinstance(event, dict) and "status" in event and "checks" in event:
                            events.append(event)
                    except json.JSONDecodeError:
                        pass
            expected_checks = 16 if item["command"] == "pnpm acceptance:browser:execute:smoke" else 9
            check("execution", item["command"] + " unique passed checks event", len(events) == 1 and
                events[0].get("status") == "passed" and events[0].get("checks") == expected_checks, events)
            record["events"] = events
        if item["command"] == "pnpm acceptance:defect:tickets:smoke":
            events = []
            for line in log["lines"] if log else []:
                if line.startswith("{"):
                    try:
                        event = json.loads(line)
                        if isinstance(event, dict) and {"checkCount", "checks", "captures", "pageErrors",
                                "consoleMessageCount", "controlledReplyCount"}.issubset(event):
                            events.append(event)
                    except json.JSONDecodeError:
                        pass
            check("execution", "D5 unique terminal summary event", len(events) == 1, events)
            event = events[0] if len(events) == 1 else {}
            d5_checks = event.get("checks")
            check("execution", "D5 passed with exact ten true keys", event.get("passed") is True and
                "failure" not in event and event.get("checkCount") == 10 and isinstance(d5_checks, dict) and
                set(d5_checks) == D5_CHECKS and all(value is True for value in d5_checks.values()), event)
            check("execution", "D5 exact four desktop/mobile captures", event.get("captures") == D5_CAPTURES,
                event.get("captures"))
            check("execution", "D5 zero page errors", event.get("pageErrors") == [], event.get("pageErrors"))
            check("execution", "D5 three explicitly controlled HTTP console errors", event.get("consoleMessageCount") == 3 and
                event.get("controlledReplyCount") == 3 and isinstance(d5_checks, dict) and
                d5_checks.get("consoleErrorsAreOnlyTheExplicitControlledHttpFailures") is True,
                {"consoleMessageCount": event.get("consoleMessageCount"), "controlledReplyCount": event.get("controlledReplyCount")})
            record["events"] = events
            data["defectTicketSmoke"] = {"path": record["path"], "summary": event,
                "consoleExpectation": "Three explicitly controlled HTTP errors; zero page errors does not mean zero console errors."}
        data["coreSmokes"].append(record)
    docker_items = [item for item in contracts[CORE] if item["command"].startswith("node --test --test-name-pattern=")]
    check("identity", "one explicit Docker step", len(docker_items) == 1)
    docker = step_logs.get((CORE, docker_items[0]["name"])) if docker_items else None
    if docker:
        docker_stats = stats(docker, "explicit Docker")
        passed_tests = [match.group(1) for line in docker["lines"] if (match := re.fullmatch(r"ok \d+ - (.+)", line))]
        check("execution", "Docker two actual passed tests with zero skip", docker_stats.get("tests") == 2 and docker_stats.get("pass") == 2 and
            docker_stats.get("skipped") == 0 and sorted(passed_tests) == sorted(SKIPS[-2:]) and "  HEIMDALL_DOCKER_TEST: 1" in docker["lines"], passed_tests)
        data["docker"] = {"path": docker["path"], "stats": docker_stats, "passedTests": passed_tests}
    else:
        check("execution", "Docker stats available", False)
    data["independentSmokeSteps"] = [{"name": item["name"], "command": item["command"],
        "path": step_logs.get((SMOKE, item["name"]), {}).get("path")} for item in contracts[SMOKE]][-4:]
    capture_complete = all(item["passed"] for item in checks if item["category"] == "capture")
    identity_matches = all(item["passed"] for item in checks if item["category"] == "identity")
    execution_checks_passed = all(item["passed"] for item in checks if item["category"] == "execution")
    summary = {"recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "sourceDirectory": str(source),
        "repo": REPO, "workflow": "CI", "runId": RUN, "attempt": ATTEMPT, "headSha": HEAD, "event": "push", "branch": "main",
        "runStatus": run.get("status"), "runConclusion": run.get("conclusion"),
        "captureComplete": capture_complete, "identityMatches": identity_matches,
        "executionChecksPassed": execution_checks_passed,
        "executionAccepted": capture_complete and identity_matches and execution_checks_passed,
        "passed": all(item["passed"] for item in checks), "checks": len(checks),
        "failedChecks": [item for item in checks if not item["passed"]], "jobs": [{"id": j["id"], "name": j["name"],
            "status": j["status"], "conclusion": j["conclusion"]} for j in jobs], **data,
        "logComparisonNormalization": "strip timestamps, BOM, real ANSI and gh printable ^[ ANSI; raw originals and SHA retained",
        "verifierSha256": sha(Path(__file__).read_bytes()), "argv": sys.argv}
    (output / "verified-summary.json").write_bytes(encoded(summary))
    (output / "verification-checks.json").write_bytes(encoded(checks))
    digest_files = [file for file in source.rglob("*") if file.is_file()]
    (output / "source-file-digests.json").write_bytes(encoded([{"path": file.relative_to(source).as_posix(),
        "bytes": file.stat().st_size, "sha256": sha(file.read_bytes())} for file in sorted(digest_files)]))
    report = ["# D5 精确提交 CI 独立核验", "", f"- Run: `{RUN}` / attempt `{ATTEMPT}` / head `{HEAD}`",
        f"- API结论: `{run.get('status')}` / `{run.get('conclusion')}`",
        f"- 原件完整: `{summary['captureComplete']}`；身份匹配: `{summary['identityMatches']}`；执行验收: `{summary['executionAccepted']}`",
        f"- 核验项: {len(checks)}；失败: {len(summary['failedChecks'])}", "", "原件与派生解析分开保存，所有数字均来自本次精确提交日志。",
        "", "|Job|状态|结论|", "|---|---|---|"]
    report += [f"|{j['name']}|{j['status']}|{j['conclusion']}|" for j in jobs]
    report += ["", "主Core测试统计：", "", "```json", json.dumps(data.get("coreTest", {}), ensure_ascii=False, indent=2), "```",
        "", "D3/D4及D5事件：", "", "```json", json.dumps([item for item in data["coreSmokes"] if "events" in item], ensure_ascii=False, indent=2), "```",
        "", "D5核验：10个true key、4张截图、0个page error、3条受控HTTP控制台错误；不声称控制台零错误。", "",
        "```json", json.dumps(data.get("defectTicketSmoke", {}), ensure_ascii=False, indent=2), "```",
        "", "Docker统计：", "", "```json", json.dumps(data.get("docker", {}), ensure_ascii=False, indent=2), "```", "", "20项后续smoke：", ""]
    report += [f"- `{item['command']}`：`{item['apiConclusion']}`；`{item['path']}`" for item in data["coreSmokes"]]
    if summary["failedChecks"]:
        report += ["", "未通过核验项：", "", "```json", json.dumps(summary["failedChecks"], ensure_ascii=False, indent=2), "```"]
    (output / "REPORT.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print(json.dumps({"directory": str(output), "passed": summary["passed"], "captureComplete": summary["captureComplete"],
        "identityMatches": summary["identityMatches"], "executionAccepted": summary["executionAccepted"], "checks": len(checks),
        "failedChecks": summary["failedChecks"], "coreTest": data.get("coreTest"), "docker": data.get("docker")}, ensure_ascii=False), flush=True)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--head", type=full_head, required=True)
    parser.add_argument("--run", type=positive_run, required=True)
    parser.add_argument("--attempt", type=int, default=1)
    raise SystemExit(main(parser.parse_args()))
