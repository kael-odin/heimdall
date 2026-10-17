"""Read-only independent package verifier; all output stays in ignored _runs.

Does not execute evidence, extract archive paths, change the index or alter a
package. Run only after the root agent announces the package is ready.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import tempfile
import time

CHUNK = 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_ARCHIVE = 1024 * 1024 * 1024
MAX_TOTAL = 2 * 1024 * 1024 * 1024
MAX_ENTRIES = 20000
HEX = re.compile(r"[0-9a-f]{64}\Z")
PATTERNS = {
    "private-key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"),
    "github-token": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b"),
    "openai-style-key": re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255}\b"),
    "aws-access-key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "slack-token": re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{32,255}\b"),
    "google-api-key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    "npm-token": re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b"),
}


def need(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def relname(value, allow_root=False):
    need(isinstance(value, str) and value, "Missing path")
    need("\\" not in value and ":" not in value and not any(ord(c) < 32 for c in value), "Unsafe path spelling")
    p = PurePosixPath(value.rstrip("/"))
    need(not p.is_absolute() and ".." not in p.parts, "Absolute or traversing path")
    normalized = p.as_posix()
    need(normalized == value.rstrip("/"), "Non-canonical path")
    need(allow_root or normalized != ".", "Unexpected root path")
    return normalized


def safe_file(path):
    s = path.lstat()
    need(not path.is_symlink() and not (getattr(s, "st_file_attributes", 0) & 0x400), "Link or reparse point")
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, "Nonregular or multiply linked file")
    need(s.st_size <= MAX_FILE, "File exceeds verifier bound")
    return s


def identity(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)


def stable_digest(path, scanner=None, label=None):
    before = safe_file(path)
    h = hashlib.sha256()
    count = 0
    with path.open("rb") as f:
        need(identity(os.fstat(f.fileno())) == identity(before), "File identity changed before read")
        while block := f.read(CHUNK):
            h.update(block)
            if scanner:
                scanner.feed(label or str(path), block, count)
            count += len(block)
        need(identity(os.fstat(f.fileno())) == identity(before), "File changed during read")
    need(identity(path.lstat()) == identity(before) and count == before.st_size, "File changed after read")
    return {"bytes": count, "sha256": h.hexdigest()}


def read_json(path):
    safe_file(path)
    return json.loads(path.read_bytes().decode("utf-8"))


def tree(root):
    s = root.lstat()
    need(stat.S_ISDIR(s.st_mode) and not root.is_symlink() and not (getattr(s, "st_file_attributes", 0) & 0x400), "Tree root is not an ordinary directory")
    records = {".": {"path": ".", "kind": "directory"}}
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            p = Path(parent) / name
            s = p.lstat()
            need(not p.is_symlink() and not (getattr(s, "st_file_attributes", 0) & 0x400), "Source tree contains link/reparse point")
            name = relname(p.relative_to(root).as_posix())
            if stat.S_ISDIR(s.st_mode):
                records[name] = {"path": name, "kind": "directory"}
            else:
                records[name] = {"path": name, "kind": "file", **stable_digest(p)}
            need(len(records) <= MAX_ENTRIES, "Tree exceeds entry bound")
    return records


def normalized_entries(entries):
    need(isinstance(entries, list) and len(entries) <= MAX_ENTRIES, "Bad manifest entries")
    output = {}
    for item in entries:
        name = relname(item["path"], True)
        need(name not in output and item.get("kind") in ("file", "directory"), "Duplicate path or special manifest entry")
        row = {"path": name, "kind": item["kind"]}
        if row["kind"] == "file":
            need(isinstance(item.get("bytes"), int) and 0 <= item["bytes"] <= MAX_FILE and HEX.fullmatch(item.get("sha256", "")), "Bad file digest record")
            row.update(bytes=item["bytes"], sha256=item["sha256"])
        output[name] = row
    need(output.get(".") == {"path": ".", "kind": "directory"}, "Manifest omits root directory")
    return output


class Scanner:
    def __init__(self):
        self.bytes = 0
        self.tails = {}
        self.hits = set()

    def feed(self, label, block, offset):
        self.bytes += len(block)
        need(self.bytes <= MAX_TOTAL, "Credential scan total bound exceeded; scan incomplete")
        tail = self.tails.pop(label, b"")
        data = tail + block
        for kind, pattern in PATTERNS.items():
            for match in pattern.finditer(data):
                value = match.group()
                # Never report secret text, only its kind, location and digest.
                self.hits.add((label, kind, max(0, offset - len(tail) + match.start()), sha(value)))
        self.tails[label] = data[-512:]

    def finish(self, label):
        self.tails.pop(label, None)


def archive_tree(archive, group_id, scanner, scratch):
    # Fully inflate gzip (including CRC/trailer validation) into ignored scratch,
    # then parse tar independently. No archive member is extracted to disk.
    total = 0
    label = "inflated:" + archive.name
    with tempfile.TemporaryFile(dir=scratch) as raw:
        with gzip.open(archive, "rb") as stream:
            while block := stream.read(CHUNK):
                scanner.feed(label, block, total)
                total += len(block)
                need(total <= MAX_ARCHIVE, "Inflated archive exceeds bound")
                raw.write(block)
        scanner.finish(label)
        need(total % 512 == 0, "Tar does not end on a block boundary")
        raw.seek(0)
        found, last_end = {}, 0
        with tarfile.open(fileobj=raw, mode="r:") as tar:
            for member in tar:
                full = relname(member.name, True)
                prefix = group_id + "/"
                need(full == group_id or full.startswith(prefix), "Tar member outside its group prefix")
                name = "." if full == group_id else relname(full[len(prefix):])
                need(name not in found, "Duplicate tar member")
                need(member.isdir() or member.isfile(), "Tar contains link or special member")
                need(not member.issparse(), "Sparse tar entry is not accepted")
                item = {"path": name, "kind": "directory" if member.isdir() else "file"}
                if member.isfile():
                    need(0 <= member.size <= MAX_FILE, "Tar member exceeds bound")
                    h, count = hashlib.sha256(), 0
                    f = tar.extractfile(member)
                    need(f is not None, "Cannot read tar member")
                    with f:
                        while block := f.read(CHUNK):
                            h.update(block)
                            count += len(block)
                    need(count == member.size, "Truncated tar member")
                    item.update(bytes=count, sha256=h.hexdigest())
                else:
                    need(member.size == 0, "Directory has unexpected payload")
                found[name] = item
                need(len(found) <= MAX_ENTRIES, "Archive exceeds entry bound")
                last_end = member.offset_data + ((member.size + 511) // 512) * 512
        raw.seek(last_end)
        padding = 0
        while block := raw.read(CHUNK):
            need(not block.strip(b"\0"), "Nonzero trailing tar payload")
            padding += len(block)
        need(padding >= 1024, "Tar lacks complete end marker")
    return found, total


def referenced_records(value):
    if isinstance(value, dict):
        if {"path", "bytes", "sha256"} <= value.keys():
            yield value
        for child in value.values():
            yield from referenced_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from referenced_records(child)


def staged_bytes(repo, package, expected):
    relative = package.relative_to(repo).as_posix()
    listing = subprocess.run(["git", "ls-files", "--stage", "-z", "--", relative], cwd=repo, check=True, stdout=subprocess.PIPE).stdout
    rows = []
    for raw in listing.split(b"\0"):
        if not raw:
            continue
        head, name = raw.split(b"\t", 1)
        mode, oid, stage = head.decode("ascii").split()
        need(stage == "0" and mode in ("100644", "100755"), "Unmerged or nonregular index entry")
        name = name.decode("utf-8")
        prefix = relative + "/"
        need(name.startswith(prefix), "Unexpected index prefix")
        rows.append((name[len(prefix):], oid))
    need({name for name, _ in rows} == set(expected), "Staged package path set differs")
    process = subprocess.Popen(["git", "cat-file", "--batch"], cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for name, oid in rows:
            process.stdin.write((oid + "\n").encode("ascii"))
            process.stdin.flush()
            header = process.stdout.readline().decode("ascii").strip().split()
            need(len(header) == 3 and header[0] == oid and header[1] == "blob", "Invalid index blob response")
            remaining = int(header[2])
            need(remaining == expected[name]["bytes"], "Staged blob length differs")
            h = hashlib.sha256()
            while remaining:
                chunk = process.stdout.read(min(CHUNK, remaining))
                need(chunk, "Truncated staged blob")
                h.update(chunk)
                remaining -= len(chunk)
            need(process.stdout.read(1) == b"\n" and h.hexdigest() == expected[name]["sha256"], "Staged package bytes differ")
        process.stdin.close()
        need(process.wait(timeout=30) == 0, "git cat-file failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--package", default="docs/audits/2026-10-17/evidence/acceptance-display-head-race")
    parser.add_argument("--authority", type=Path, default=Path(__file__).with_name("authority.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--staged", action="store_true", help="Also compare exact index blob bytes, without changing index")
    args = parser.parse_args()
    repo = args.repo.resolve()
    package = repo / relname(args.package)
    output = args.output.resolve()
    need(output.is_relative_to(repo / "core/workspace/_runs"), "Output must stay in main-tree ignored _runs")
    need(not output.exists(), "Use a fresh independent output path")
    output.mkdir(parents=True)
    started = time.time()
    result = {"status": "failed", "repo": str(repo), "package": str(package), "stagedRequested": args.staged}
    try:
        authority = read_json(args.authority)
        need(authority.get("readyForVerification") is True, "Verifier authority/schema is not finalized")
        result.update(verify_package(repo, package, authority, output, args.staged))
        result["status"] = "passed"
    except Exception as error:
        # Do not echo archive headers or credential material from exception text.
        result["errorType"] = type(error).__name__
        result["error"] = str(error) if isinstance(error, ValueError) else "Independent parsing or I/O failed; raw exception suppressed"
    result["wallTimeMs"] = round((time.time() - started) * 1000)
    (output / "verification.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"status": result["status"], "output": str(output), "wallTimeMs": result["wallTimeMs"]}))
    return 0 if result["status"] == "passed" else 1


def verify_package(repo, package, authority, output, check_staged):
    need(package.is_relative_to(repo) and package.is_dir(), "Package root missing or outside repo")
    scanner = Scanner()
    initial = tree(package)
    package_files = {k: v for k, v in initial.items() if v["kind"] == "file"}
    need("FAILED.json" not in package_files, "Failed pack cannot be verified as complete")
    completed = read_json(package / "COMPLETED.json")
    index = read_json(package / "INDEX.json")
    need(completed.get("schemaVersion") == 1 and index.get("schemaVersion") == 1, "Unsupported control schema")
    sums = completed.get("sha256")
    need(isinstance(sums, dict) and set(sums) == set(package_files) - {"COMPLETED.json"}, "Completion checksum path set differs")
    for name, digest in sums.items():
        relname(name)
        need(HEX.fullmatch(digest) and package_files[name]["sha256"] == digest, "Completion checksum mismatch")
    for name in package_files:
        stable_digest(package / name, scanner, "package:" + name)
        scanner.finish("package:" + name)
    packer_root = repo / relname(authority["packerSourceRoot"])
    for name, digest in authority["packerSha256"].items():
        need(stable_digest(packer_root / relname(name))["sha256"] == digest, "Prepared packer/plan/document authority changed")
        if name in ("pack.py", "inputs.json"):
            need((package / "controls" / name).read_bytes() == (packer_root / name).read_bytes(), "Control is not exact packer/plan original bytes")
    config = read_json(package / "controls/inputs.json")
    need(Path(config["workspace"]).resolve() == repo and not config.get("pendingGroups"), "Input plan workspace or readiness differs")
    groups = config["groups"]
    need([g["id"] for g in groups] == authority["groupIds"], "Prepared group set/order changed")
    need(len(groups) == index["groupCount"] == completed["groupCount"] == len(index["groups"]), "Group count mismatch")
    need([g["id"] for g in index["groups"]] == authority["groupIds"], "Index group set/order differs")
    guard_name = relname(config["sourceGuardManifest"])
    need(guard_name == authority["sourceGuardPath"], "Source guard path changed")
    guard = repo / guard_name
    guard_raw = guard.read_bytes()
    need(sha(guard_raw) == authority["sourceGuardSha256"], "Source guard authority bytes changed")
    need((package / "controls/source-guard.json").read_bytes() == guard_raw, "Published source guard is not original bytes")
    need(index["sourceGuardManifest"] == guard_name and index["sourceGuardManifestSha256"] == sha(guard_raw), "Index source guard reference differs")
    expected_guard = json.loads(guard_raw.decode("utf-8"))
    need(len(expected_guard) == authority["fullSourceCount"], "Complete source guard count differs")
    need(read_json(package / "source-before.json") == read_json(package / "source-after.json") == expected_guard, "Published source snapshots differ")
    source_names = set()
    for item in expected_guard:
        name = relname(item["path"])
        need(name not in source_names, "Duplicate guarded source")
        source_names.add(name)
        need(stable_digest(repo / name) == {k: item[k] for k in ("bytes", "sha256")}, "Current guarded source bytes changed")
    for item in authority["frozenSources"]:
        need(stable_digest(repo / relname(item["path"])) == {k: item[k] for k in ("bytes", "sha256")}, "Independent final frozen source changed")
    need(stable_digest(repo / relname(authority["frozenAuthorityPath"]))["sha256"] == authority["frozenAuthoritySha256"], "Final five-source authority bytes changed")
    wanted_files = {"COMPLETED.json", "INDEX.json", "source-before.json", "source-after.json", "controls/pack.py", "controls/inputs.json", "controls/source-guard.json", ".gitattributes"}
    need((package / ".gitattributes").read_bytes() == b"* -text -whitespace\n", "Package raw-byte Git attributes differ")
    need({k for k, v in initial.items() if v["kind"] == "directory"} == {".", "archives", "manifests", "controls"}, "Package directory path set differs")
    group_results = []
    for planned, group in zip(groups, index["groups"]):
        group_id = group["id"]
        need(re.fullmatch(r"[a-z0-9][a-z0-9-]*", group_id), "Unsafe group id")
        source_name = relname(planned["path"])
        source = repo / source_name
        allowed = source.is_relative_to(repo / "core/workspace/_runs") or source_name == authority["preservedCiPath"]
        need(allowed and source.is_dir(), "Group source is outside approved evidence roots")
        need(group["sourceRelativePath"] == source_name and Path(group["sourceAbsolutePath"]).resolve() == source.resolve(), "Source index mapping differs")
        archive_name, manifest_name = "archives/" + group_id + ".tar.gz", "manifests/" + group_id + ".json"
        need(group["archivePath"] == archive_name and group["manifestPath"] == manifest_name, "Group output path differs")
        wanted_files.update((archive_name, manifest_name))
        need(package_files[archive_name]["sha256"] == group["archiveSha256"] and package_files[manifest_name]["sha256"] == group["manifestSha256"], "Index archive/manifest digest mismatch")
        manifest = read_json(package / manifest_name)
        need(manifest["schemaVersion"] == 1 and manifest["id"] == group_id and Path(manifest["sourceAbsolutePath"]).resolve() == source.resolve(), "Manifest source mapping differs")
        expected = normalized_entries(manifest["entries"])
        source_before = tree(source)
        need(source_before == expected, "Ignored source paths/bytes differ from manifest: " + group_id)
        for required in planned.get("requiredFiles", []):
            need(expected.get(relname(required), {}).get("kind") == "file", "Required evidence file missing: " + group_id)
        for rule in planned.get("checks", []):
            value = read_json(source / relname(rule["file"]))
            for key in rule.get("path", []):
                value = value[key]
            need(type(value) is type(rule["equals"]) and value == rule["equals"], "Evidence readiness fact differs: " + group_id)
        archived, inflated_bytes = archive_tree(package / archive_name, group_id, scanner, output)
        need(archived == expected and tree(source) == source_before, "Independent tar round trip/source stability differs: " + group_id)
        file_count = sum(i["kind"] == "file" for i in expected.values())
        directory_count = len(expected) - file_count
        byte_count = sum(i.get("bytes", 0) for i in expected.values())
        need((group["fileCount"], group["directoryCount"], group["totalBytes"]) == (file_count, directory_count, byte_count), "Group statistics mismatch")
        if group_id in authority["finalSnapshotGroups"]:
            before, after = read_json(source / "source-before.json"), read_json(source / "source-after.json")
            need(before == after and len(before) == authority["fullSourceCount"], "Final gate full source snapshots differ")
            for item in before:
                need(stable_digest(repo / relname(item["path"])) == {k: item[k] for k in ("bytes", "sha256")}, "Final gate full source bytes changed")
        if group_id == authority["frozenGroupId"]:
            need(read_json(source / "source-before.json") == read_json(source / "source-after.json") == authority["frozenSources"], "Final five-source snapshots differ")
            for item in authority["frozenSources"]:
                need(expected.get("frozen/" + item["path"]) == {"path": "frozen/" + item["path"], "kind": "file", "bytes": item["bytes"], "sha256": item["sha256"]}, "Frozen source archive copy differs")
        group_results.append({"id": group_id, "files": file_count, "directories": directory_count, "bytes": byte_count, "inflatedTarBytes": inflated_bytes})
    need(len(config.get("documents", [])) == len(index.get("documents", [])), "Document index count differs")
    for planned, document in zip(config.get("documents", []), index.get("documents", [])):
        name = relname(planned["destination"])
        source = repo / relname(planned["source"])
        need(source.is_relative_to(repo / "core/workspace/_runs"), "Document origin is outside ignored evidence roots")
        need(document["path"] == name and Path(document["sourceAbsolutePath"]).resolve() == source.resolve(), "Document mapping differs")
        need(stable_digest(source) == {"bytes": package_files[name]["bytes"], "sha256": document["sha256"]} and package_files[name]["sha256"] == document["sha256"], "Document original bytes differ")
        wanted_files.add(name)
    need(set(package_files) == wanted_files, "Package contains extra or missing files")
    ci = repo / relname(authority["preservedCiPath"])
    need(stable_digest(ci / "COMPLETED.json")["sha256"] == authority["preservedCiCompletedSha256"], "Original CI completion authority changed")
    old_done = read_json(ci / "COMPLETED.json")
    for record in referenced_records(old_done):
        need(stable_digest(ci / relname(record["path"])) == {k: record[k] for k in ("bytes", "sha256")}, "Original CI anchored index changed")
    old_manifest = read_json(ci / "file-manifest.json")
    old_files = {k: v for k, v in tree(ci).items() if v["kind"] == "file"}
    need(len(old_files) == authority["preservedCiFileCount"], "Original CI file count changed")
    need(set(old_files) == {i["path"] for i in old_manifest["files"]} | set(old_manifest["excludes"]), "Original CI file set changed")
    for item in old_manifest["files"]:
        need(stable_digest(ci / relname(item["path"])) == {k: item[k] for k in ("bytes", "sha256")}, "Original CI anchored file bytes changed")
    for item in expected_guard + authority["frozenSources"]:
        need(stable_digest(repo / relname(item["path"])) == {k: item[k] for k in ("bytes", "sha256")}, "Guarded source changed during independent verification")
    need(tree(package) == initial, "Public package changed while independently verifying")
    hits = [{"location": h[0], "kind": h[1], "offset": h[2], "valueSha256": h[3]} for h in sorted(scanner.hits)]
    allowed = set(authority.get("allowedCredentialDigests", []))
    findings = [h for h in hits if h["valueSha256"] not in allowed]
    scan_report = {"kind": "bounded-strong-signature-scan", "status": "passed" if not findings else "blocked", "scannedBytes": scanner.bytes, "patterns": list(PATTERNS), "maxFileBytes": MAX_FILE, "maxInflatedArchiveBytes": MAX_ARCHIVE, "maxTotalScannedBytes": MAX_TOTAL, "maxEntriesPerTree": MAX_ENTRIES, "findings": findings, "allowedFindingCount": len(hits) - len(findings), "boundary": "All public files and complete inflated tar byte streams, including headers, were scanned. Nested compressed ZIP payloads are not recursively expanded; their full bytes are integrity-checked and original CI extracted trees are separately included. Signature scan is not proof of absence of every possible credential."}
    (output / "credential-scan.json").write_text(json.dumps(scan_report, indent=2) + "\n", encoding="utf-8", newline="\n")
    need(not findings, "Strong credential signature candidates require review; secret values were not logged")
    staged_count = staged_bytes(repo, package, package_files) if check_staged else None
    return {"verifierSha256": stable_digest(Path(__file__).resolve())["sha256"], "completedSha256": package_files["COMPLETED.json"]["sha256"], "indexSha256": package_files["INDEX.json"]["sha256"], "publicFileCount": len(package_files), "sourceGuardFileCount": len(expected_guard), "frozenSourceCount": len(authority["frozenSources"]), "groups": group_results, "preservedCiFiles": len(old_files), "credentialScan": "passed", "stagedFilesChecked": staged_count, "independentGzipCrcAndTarParsing": True, "sourceByteAndPathSetsMatched": True, "packageUnchanged": True, "metadataBoundary": "Tar/file path sets, types, bytes and SHA256 checked; no claim of nanosecond mtime or filesystem inode retention."}


if __name__ == "__main__":
    raise SystemExit(main())
