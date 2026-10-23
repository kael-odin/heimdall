#!/usr/bin/env python3
"""Independent, offline D2 evidence publication verifier; standard library only.

Reads public files from the working tree or, with --mode staged, from Git's
index via `git show :path`. Never modifies source, index, or published evidence.
Original ignored run files are compared with their published archive bytes.
"""
from __future__ import annotations

import argparse
import binascii
import collections
import datetime as dt
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import traceback
import uuid
import zipfile

EXPECTED_HEAD = "c170f503964601b7d125c2f902760c1235cc2e39"
SOURCE_ROOTS = ("core/src", "core/scripts", "core/test", "console/src", ".github/workflows")
SOURCE_FILES = ("package.json", "core/package.json", "console/package.json")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode_json(data):
    return json.loads(data.decode("utf-8-sig"))


def norm(path):
    path = str(path).replace("\\", "/")
    p = PurePosixPath(path)
    if p.is_absolute() or ".." in p.parts or "\x00" in path or ":" in path:
        raise ValueError("unsafe relative path")
    return str(p)


class Verifier:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.root).resolve()
        self.index_path = norm(args.index)
        self.base = str(PurePosixPath(self.index_path).parent)
        self.out = Path(args.out).resolve() if args.out else self.root / "core/workspace/_runs" / ("d2-evidence-independent-" + args.mode + "-" + str(uuid.uuid4()))
        allowed = self.root / "core/workspace/_runs"
        if not self.out.is_relative_to(allowed):
            raise ValueError("output must be inside this worktree's ignored core/workspace/_runs")
        self.out.mkdir(parents=True, exist_ok=False)
        self.checks = []
        self.failures = []
        self.archived = {}
        self.scanned = 0
        self.scanned_bytes = 0
        self.scan_findings = []
        self.nested = []
        self.inventory = []
        self.read_cache = {}
        self.log = open(self.out / "verification.log", "x", encoding="utf-8")

    def note(self, value):
        line = json.dumps(value, ensure_ascii=False)
        self.log.write(line + "\n")
        self.log.flush()
        print(line, flush=True)

    def check(self, condition, label, details=None):
        item = {"check": label, "passed": bool(condition)}
        if details is not None:
            item["details"] = details
        self.checks.append(item)
        if not condition:
            self.failures.append(item)
        return bool(condition)

    def git(self, *args):
        result = subprocess.run(["git", *args], cwd=self.root, capture_output=True)
        if result.returncode:
            # Never print stderr containing arbitrary repository content.
            raise RuntimeError("git command failed: " + " ".join(args[:1]))
        return result.stdout

    def public(self, relative):
        relative = norm(relative)
        if relative not in self.read_cache:
            self.read_cache[relative] = self.git("show", ":" + relative) if self.args.mode == "staged" else (self.root / relative).read_bytes()
        return self.read_cache[relative]

    def published(self, child):
        return self.public(self.base + "/" + norm(child))

    def entry(self, path):
        return self.archived[norm(path)]

    def json_entry(self, path):
        return decode_json(self.entry(path))

    def file_tree(self, source):
        p = Path(source)
        if not p.is_absolute():
            p = self.root / p
        p = p.resolve()
        if not p.is_relative_to(self.root):
            raise ValueError("original group source is outside worktree")
        files = []
        if p.is_file():
            return [p]
        for current, dirs, names in os.walk(p):
            for name in dirs + names:
                if (Path(current) / name).is_symlink():
                    raise ValueError("symlink in original evidence source")
            files.extend(Path(current) / name for name in names)
        return files

    def credential_scan(self, label, data, depth=0):
        self.scanned += 1
        self.scanned_bytes += len(data)
        # High-confidence provider formats and complete private-key headers.
        patterns = {
            "private-key": rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----",
            "github-pat": rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b",
            "aws-access-key": rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
            "slack-token": rb"\bxox[baprs]-[0-9A-Za-z-]{24,}\b",
            "stripe-live-key": rb"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b",
            "openai-key": rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b",
            "google-api-key": rb"\bAIza[A-Za-z0-9_-]{35}\b",
            "jwt-auth-header": rb"(?i)\bbearer[ \t]+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}",
        }
        for family, pattern in patterns.items():
            for match in re.finditer(pattern, data):
                value = match.group()
                # Exempt only unmistakable literal fixtures; actual matches remain
                # private and are reported only by family/location/hash.
                low = value.lower()
                fixture = any(word in low for word in (b"example", b"placeholder", b"not-a-real", b"fake-key", b"dummy"))
                suffix = value.split(b"-", 1)[-1]
                counts = collections.Counter(suffix)
                entropy = -sum((n / len(suffix)) * math.log2(n / len(suffix)) for n in counts.values()) if suffix else 0
                fixture = fixture or (family != "private-key" and entropy < 2.0)
                if not fixture:
                    self.scan_findings.append({"path": label, "family": family, "offset": match.start(), "matchSha256": sha(value)})
        if depth > 8:
            raise ValueError("nested archive depth exceeds independent verifier limit")
        if data.startswith(b"PK\x03\x04") or data.startswith(b"PK\x05\x06"):
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                seen = set()
                for info in z.infolist():
                    name = norm(info.filename.rstrip("/"))
                    if name in seen:
                        raise ValueError("duplicate nested ZIP member")
                    seen.add(name)
                    if info.is_dir():
                        continue
                    member = z.read(info)
                    if binascii.crc32(member) & 0xffffffff != info.CRC:
                        raise ValueError("nested ZIP CRC mismatch")
                    self.credential_scan(label + "!" + name, member, depth + 1)
                self.nested.append({"path": label, "kind": "zip", "entries": len(z.infolist()), "crcPassed": True})
        elif data.startswith(b"\x1f\x8b") or (len(data) >= 262 and data[257:262] == b"ustar"):
            try:
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as t:
                    count = 0
                    for item in t:
                        norm(item.name.rstrip("/"))
                        if item.isfile():
                            self.credential_scan(label + "!" + item.name, t.extractfile(item).read(), depth + 1)
                            count += 1
                        elif not item.isdir():
                            raise ValueError("non-file nested tar member")
                    self.nested.append({"path": label, "kind": "tar", "files": count})
            except tarfile.ReadError:
                # A raw gzip payload still gets decompressed and scanned.
                import gzip
                self.credential_scan(label + "!gzip", gzip.decompress(data), depth + 1)

    def source_records(self, records, label):
        self.check(isinstance(records, list) and len(records) == 557, label + ":557-records", {"actual": len(records) if isinstance(records, list) else None})
        parsed = {}
        for record in records:
            key = norm(record["path"])
            self.check(key not in parsed, label + ":unique-source:" + key)
            parsed[key] = (record["bytes"], record["sha256"])
        return parsed

    def sources_now(self):
        if self.args.mode == "staged":
            keys = self.git("ls-files", "--cached", "-z", "--", *SOURCE_ROOTS, *SOURCE_FILES).decode("utf-8").split("\x00")
            keys = [norm(k) for k in keys if k]
            return {key: (len(self.public(key)), sha(self.public(key))) for key in keys}
        keys = []
        for root in SOURCE_ROOTS:
            keys.extend(str(p.relative_to(self.root)).replace("\\", "/") for p in self.file_tree(root))
        keys.extend(SOURCE_FILES)
        return {key: (len((self.root / key).read_bytes()), sha((self.root / key).read_bytes())) for key in keys}

    def verify(self):
        self.note({"event": "start", "mode": self.args.mode, "publicReadMethod": "git show :path" if self.args.mode == "staged" else "working-tree exact bytes", "index": self.index_path, "out": str(self.out)})
        index_bytes = self.public(self.index_path)
        index = decode_json(index_bytes)
        self.check(index["schemaVersion"] == 1, "index-schema")
        self.check(index["baselineHead"] == EXPECTED_HEAD, "index-baseline-head")
        self.check(self.git("rev-parse", "HEAD").decode().strip() == EXPECTED_HEAD, "current-head-is-D1-baseline")
        self.credential_scan(self.index_path, index_bytes)
        archive_meta = index["archive"]
        archive_bytes = self.published(archive_meta["file"])
        self.check(len(archive_bytes) == archive_meta["bytes"], "public-zip-bytes")
        self.check(sha(archive_bytes) == archive_meta["sha256"], "public-zip-sha256")
        originals = index["originals"]
        original_by_entry = {norm(record["path"]): record for record in originals}
        self.check(len(original_by_entry) == len(originals), "index-originals-unique")
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as z:
            infos = z.infolist()
            names = [norm(info.filename.rstrip("/")) for info in infos]
            self.check(len(set(names)) == len(names), "zip-entries-unique")
            self.check(not any(info.is_dir() for info in infos), "zip-only-original-files")
            self.check(set(names) == set(original_by_entry), "zip-complete-entry-set", {"zip": len(names), "originals": len(originals), "missingCount": len(set(original_by_entry) - set(names)), "extraCount": len(set(names) - set(original_by_entry))})
            self.check(len(infos) == archive_meta["entries"], "zip-entry-count")
            total = 0
            for info, name in zip(infos, names):
                self.check(not info.flag_bits & 1, "zip-not-encrypted:" + name)
                self.check(not stat.S_ISLNK(info.external_attr >> 16), "zip-not-symlink:" + name)
                content = z.read(info)  # zipfile independently checks stored CRC.
                self.check((binascii.crc32(content) & 0xffffffff) == info.CRC, "zip-crc32:" + name)
                self.check(len(content) == info.file_size, "zip-header-bytes:" + name)
                record = original_by_entry.get(name)
                if record:
                    self.check(len(content) == record["bytes"], "zip-manifest-bytes:" + name)
                    self.check(sha(content) == record["sha256"], "zip-manifest-sha256:" + name)
                    source = self.root / norm(record["sourcePath"])
                    self.check(source.is_file(), "original-exists:" + name)
                    if source.is_file():
                        self.check(content == source.read_bytes(), "zip-original-byte-roundtrip:" + name)
                self.archived[name] = content
                total += len(content)
                self.inventory.append({"path": name, "bytes": len(content), "sha256": sha(content), "crc32": format(info.CRC, "08x")})
                self.credential_scan("ZIP/" + name, content)
            self.check(total == archive_meta["inflatedBytes"], "zip-inflated-bytes", {"actual": total})
        self.note({"event": "archive-read", "entries": len(self.archived), "inflatedBytes": total})
        group_keys = [group["key"] for group in index["groups"]]
        self.check(len(set(group_keys)) == len(group_keys), "unique-group-keys")
        self.check(set(group_keys) == {record["group"] for record in originals}, "groups-cover-originals")
        for group in index["groups"]:
            records = [r for r in originals if r["group"] == group["key"]]
            self.check(len(records) == group["fileCount"], "group-file-count:" + group["key"])
            self.check(sum(r["bytes"] for r in records) == group["bytes"], "group-byte-count:" + group["key"])
            actual_paths = {str(p.relative_to(self.root)).replace("\\", "/") for p in self.file_tree(group["source"])}
            self.check(actual_paths == {norm(r["sourcePath"]) for r in records}, "group-complete-original-file-set:" + group["key"], {"actual": len(actual_paths), "manifest": len(records)})
        for readable in index["readableCopies"]:
            data = self.published(readable["file"])
            self.check(len(data) == readable["bytes"], "readable-bytes:" + readable["file"])
            self.check(sha(data) == readable["sha256"], "readable-sha256:" + readable["file"])
            self.check(data == self.entry(readable["originalPath"]), "readable-original-exact:" + readable["file"])
            self.credential_scan("public/" + readable["file"], data)
        guard_meta = index["sourceGuard"]
        public_guard_bytes = self.published(guard_meta["file"])
        guard = self.source_records(decode_json(public_guard_bytes), "public-source-guard")
        self.check(guard_meta["sourceFileCount"] == 557, "source-guard-count-metadata")
        now = self.sources_now()
        self.check(set(now) == set(guard), "current-source-complete-set", {"mode": self.args.mode, "actual": len(now), "guard": len(guard)})
        mismatches = [path for path in sorted(set(now) | set(guard)) if now.get(path) != guard.get(path)]
        self.check(not mismatches, "current-source-exact-bytes-and-sha256", {"mode": self.args.mode, "mismatchPaths": mismatches})
        for gate in index["finalGates"]:
            summary = self.json_entry(gate["summary"])
            before = self.source_records(self.json_entry(gate["before"]), gate["label"] + ":before")
            after = self.source_records(self.json_entry(gate["after"]), gate["label"] + ":after")
            self.check(summary.get("code") == 0 and summary.get("sourcesUnchanged") is True and summary.get("sourceFileCount") == 557, "final-gate-success-guard:" + gate["label"])
            self.check(before == after == guard == now, "final-gate-exact-current-557:" + gate["label"])
            self.check(len(self.entry(gate["stdout"])) > 0, "final-gate-original-stdout:" + gate["label"])
        anchors = index["anchors"]
        core = anchors["core"]
        core_log = self.entry(core["stdout"]).decode("utf-8-sig", errors="replace")
        for key, log_name, expected in (("tests", "tests", 2379), ("pass", "pass", 2367), ("fail", "fail", 0), ("skip", "skipped", 12)):
            matches = re.findall(r"(?:^|\n)[^\r\n]*\b" + log_name + r"[ \t]+(\d+)[ \t]*(?:\r?\n|$)", core_log)
            self.check(bool(matches) and int(matches[-1]) == expected and core[key] == expected, "core-raw-log-" + key, {"actual": int(matches[-1]) if matches else None, "expected": expected})
        self.check(self.json_entry(core["summary"])["code"] == 0, "core-summary-exit-zero")
        ui = anchors["ui"]
        ui_result = self.json_entry(ui["checks"])
        self.check(ui_result.get("status") == "passed" and ui_result.get("checkCount") == 13 and len(ui_result.get("checks", {})) == 13 and all(v is True for v in ui_result.get("checks", {}).values()), "ui-13-original-checks")
        self.check(self.json_entry(ui["wrapperSummary"])["code"] == 0, "ui-wrapper-exit-zero")
        self.check(ui_result.get("pageErrors") == [] and ui_result.get("candidateAndReadTargetRequests") == 0 and ui_result.get("executionReady") is False, "ui-original-boundaries")
        self.check(len(ui_result.get("httpErrors", [])) == 1 and ui_result["httpErrors"][0].get("method") == "POST" and ui_result["httpErrors"][0].get("status") == 502 and ui_result["httpErrors"][0].get("path", "").endswith("/browser-baseline-candidates"), "ui-single-exact-injected-http-error")
        d1 = anchors["d1ci"]
        metadata = self.json_entry(d1["metadata"])
        artifact_metadata = self.json_entry(d1["artifactMetadata"])
        self.check(metadata.get("headSha") == EXPECTED_HEAD and metadata.get("conclusion") == "failure" and metadata.get("status") == "completed" and metadata.get("url", "").endswith("/39020282414"), "d1-exact-head-failed-run")
        self.check(len(self.entry(d1["log"])) == 1667632, "d1-original-full-log-bytes")
        d1_log = self.entry(d1["log"]).decode("utf-8-sig", errors="replace")
        for name, expected in (("tests", 2325), ("pass", 2321), ("fail", 0), ("skipped", 4)):
            found = re.findall(r"Run pnpm test[^\r\n]*# " + name + r" (\d+)(?:\r?\n|$)", d1_log)
            self.check(bool(found) and int(found[-1]) == expected, "d1-core-raw-log-" + name, {"actual": int(found[-1]) if found else None, "expected": expected})
        self.check(bool(re.search(r"Run pnpm test[^\r\n]*ok \d+ - an actual Linux rename after open and before its first fstat retains the opened version(?:\r?\n|$)", d1_log)), "d1-linux-native-first-fstat-actually-passed")
        artifacts = artifact_metadata["artifacts"]
        self.check(len(artifacts) == 1, "d1-one-original-artifact")
        artifact = artifacts[0]
        d1_zip = self.entry(d1["originalArchive"])
        self.check(artifact["workflow_run"]["head_sha"] == EXPECTED_HEAD and artifact["workflow_run"]["id"] == 39020282414, "d1-artifact-head-run")
        self.check(len(d1_zip) == artifact["size_in_bytes"] == 1447004 and "sha256:" + sha(d1_zip) == artifact["digest"] == "sha256:54d1b9d708e9313d801ed3706257967f02dea32253feb83fcf8ef9267a71a6fc", "d1-original-zip-metadata-digest")
        with zipfile.ZipFile(io.BytesIO(d1_zip)) as z:
            self.check(len(z.infolist()) == 163 and z.testzip() is None, "d1-all-163-entries-crc")
        lint_jobs = [j for j in metadata["jobs"] if j["name"] == "core (lint + test)"]
        self.check(len(lint_jobs) == 1, "d1-core-job-unambiguous")
        if lint_jobs:
            steps = {step["name"]: step for step in lint_jobs[0]["steps"]}
            self.check(steps.get("Run pnpm test", {}).get("conclusion") == "success", "d1-core-step-passed")
            self.check(steps.get("Managed Spec preparation (immutable contract, replay and zero execution)", {}).get("conclusion") == "failure", "d1-preparation-step-failed")
            self.check(steps.get("Managed Spec result reading (captured evidence and zero execution)", {}).get("conclusion") == "skipped", "d1-later-step-skipped")
        failures = anchors["failures"]
        self.check(bool(failures), "failure-originals-explicitly-indexed")
        for path in failures:
            self.check(path in self.archived and len(self.archived.get(path, b"")) > 0, "failure-original-preserved:" + path)
        source_to_entry = {norm(record["sourcePath"]): norm(record["path"]) for record in originals}
        known_failure_prefix = "core/workspace/_runs/browser-candidates-console-smoke-97491a7b-ce6d-48d9-8187-4cd632a104e0/"
        for suffix in ("failure.json", "failure-dom.txt", "failure.png", "engine.log"):
            self.check(known_failure_prefix + suffix in source_to_entry, "known-ui-failure-original-included:" + suffix)
        known_api_result = "core/workspace/_runs/browser-candidate-api-d2-tests-5dc38ea5-2787-4038-bbaf-1a1f13f950d8/result.json"
        self.check(known_api_result in source_to_entry, "known-api-failure-original-included")
        if known_api_result in source_to_entry:
            self.check(self.json_entry(source_to_entry[known_api_result]).get("exitCode") == 1, "known-api-failure-keeps-original-failed-status")
        known_ui_result = known_failure_prefix + "failure.json"
        if known_ui_result in source_to_entry:
            self.check(self.json_entry(source_to_entry[known_ui_result]).get("status") == "failed", "known-ui-failure-keeps-original-failed-status")
        self.check(not self.scan_findings, "high-confidence-credential-scan", {"filesScannedIncludingNested": self.scanned, "bytesScannedIncludingNested": self.scanned_bytes, "redactedFindingCount": len(self.scan_findings)})
        self.facts = {"indexSha256": sha(index_bytes), "archive": {"bytes": len(archive_bytes), "sha256": sha(archive_bytes), "entries": len(self.archived), "inflatedBytes": total}, "sourceMode": self.args.mode, "sourceFileCount": len(now), "finalGateCount": len(index["finalGates"]), "readableCopyCount": len(index["readableCopies"]), "groupCount": len(index["groups"]), "core": {"tests": 2379, "pass": 2367, "fail": 0, "skip": 12}, "uiChecks": 13, "d1Head": metadata.get("headSha"), "d1Conclusion": metadata.get("conclusion")}

    def finish(self, exception=None):
        if exception:
            self.failures.append({"check": "verifier-completed", "passed": False, "exceptionType": type(exception).__name__, "message": str(exception)})
        result = {"schemaVersion": 1, "status": "passed" if not self.failures else "failed", "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "workspace": str(self.root), "index": self.index_path, "mode": self.args.mode, "publicReadMethod": "git show :path" if self.args.mode == "staged" else "working-tree exact bytes", "checkCount": len(self.checks), "failedCheckCount": len(self.failures), "facts": getattr(self, "facts", {}), "failures": self.failures, "checks": self.checks, "credentialScan": {"files": self.scanned, "bytes": self.scanned_bytes, "findings": self.scan_findings, "nestedArchives": self.nested}}
        (self.out / "verification.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (self.out / "zip-inventory.json").write_text(json.dumps(self.inventory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.note({"event": "finished", "status": result["status"], "checkCount": len(self.checks), "failedCheckCount": len(self.failures), "out": str(self.out)})
        self.log.close()
        return 0 if not self.failures else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(Path.cwd()))
    parser.add_argument("--index", default="docs/audits/2026-10-17/evidence/acceptance-browser-candidates/INDEX.json")
    parser.add_argument("--mode", choices=("working", "staged"), default="working")
    parser.add_argument("--out")
    args = parser.parse_args()
    verifier = Verifier(args)
    error = None
    try:
        verifier.verify()
    except Exception as exc:
        error = exc
        # A traceback contains code and locations only; avoid arbitrary data values.
        (verifier.out / "exception-type.txt").write_text(type(exc).__name__ + "\n", encoding="utf-8")
    return verifier.finish(error)


if __name__ == "__main__":
    sys.exit(main())
