#!/usr/bin/env python3
"""New-only, complete-tree evidence packer. Does not run product commands."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
from datetime import datetime, timezone


def digest(data):
    return hashlib.sha256(data).hexdigest()


def hash_file(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(data)


def resolve(root, value):
    path = Path(value)
    return Path(os.path.abspath(path if path.is_absolute() else root / path))


def ordinary(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError(f"Symlink/reparse point is not archivable: {path}")
    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ValueError(f"Special filesystem entry is not archivable: {path}")
    return info


def scan(source):
    entries = []

    def visit(path):
        info = ordinary(path)
        row = {"path": path.relative_to(source).as_posix(), "kind": "directory"}
        row.update(mode=stat.S_IMODE(info.st_mode), mtimeNs=info.st_mtime_ns)
        if stat.S_ISREG(info.st_mode):
            row.update(kind="file", bytes=info.st_size, sha256=hash_file(path))
            after = ordinary(path)
            if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode
            ):
                raise ValueError(f"Input changed while hashing: {path}")
        entries.append(row)
        if row["kind"] == "directory":
            with os.scandir(path) as children:
                names = sorted(child.name for child in children)
            for name in names:
                visit(path / name)

    if not stat.S_ISDIR(ordinary(source).st_mode):
        raise ValueError(f"Group source is not a directory: {source}")
    visit(source)
    return entries


def check_json(source, rule, entries):
    relative = Path(rule["file"]).as_posix()
    row = next((entry for entry in entries if entry["path"] == relative), None)
    if row is None or row["kind"] != "file":
        raise ValueError(f"Readiness input is outside the fixed file manifest: {relative}")
    data = (source / relative).read_bytes()
    if len(data) != row["bytes"] or digest(data) != row["sha256"]:
        raise ValueError(f"Readiness input changed from the fixed archive bytes: {relative}")
    value = json.loads(data)
    for segment in rule.get("path", []):
        value = value[segment]
    if value != rule["equals"] or type(value) is not type(rule["equals"]):
        raise ValueError(f"Readiness check failed: {source / rule['file']} {rule.get('path', [])}")


def guard_sources(root, expected):
    actual = []
    for row in expected:
        path = resolve(root, row["path"])
        info = ordinary(path)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"Guarded source is not an ordinary file: {path}")
        current = {"path": row["path"], "bytes": info.st_size, "sha256": hash_file(path)}
        if current != {key: row[key] for key in current}:
            raise ValueError(f"Frozen source guard mismatch: {path}")
        actual.append(current)
    return actual


def archive_group(source, entries, archive, group_id):
    with archive.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as tar:
                for row in entries:
                    path = source if row["path"] == "." else source / row["path"]
                    ordinary(path)
                    name = group_id if row["path"] == "." else f"{group_id}/{row['path']}"
                    item = tarfile.TarInfo(name)
                    item.mode, item.mtime = row["mode"], row["mtimeNs"] / 1_000_000_000
                    if row["kind"] == "directory":
                        item.type = tarfile.DIRTYPE
                        tar.addfile(item)
                    else:
                        item.size = row["bytes"]
                        with path.open("rb") as handle:
                            tar.addfile(item, handle)
    if scan(source) != entries:
        raise ValueError(f"Complete input tree changed during archive creation: {source}")
    expected = {group_id if row["path"] == "." else f"{group_id}/{row['path']}": row for row in entries}
    seen = set()
    with tarfile.open(archive, mode="r:gz") as tar:
        for member in tar:
            name = member.name.rstrip("/")
            if name not in expected or name in seen:
                raise ValueError(f"Unexpected/duplicate archive member: {name}")
            seen.add(name)
            row = expected[name]
            if member.mode != row["mode"]:
                raise ValueError(f"Archive mode mismatch: {name}")
            if row["kind"] == "directory":
                if not member.isdir():
                    raise ValueError(f"Archive directory type mismatch: {name}")
            else:
                if not member.isfile() or member.size != row["bytes"]:
                    raise ValueError(f"Archive file type/length mismatch: {name}")
                extracted = tar.extractfile(member)
                h, size = hashlib.sha256(), 0
                with extracted:
                    for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                        h.update(chunk)
                        size += len(chunk)
                if size != row["bytes"] or h.hexdigest() != row["sha256"]:
                    raise ValueError(f"Archive byte round-trip mismatch: {name}")
    if seen != set(expected):
        raise ValueError(f"Archive member set is incomplete: {archive}")
    with gzip.open(archive, "rb") as zipped:
        for _ in iter(lambda: zipped.read(1024 * 1024), b""):
            pass  # Read to EOF independently so gzip trailer/CRC is checked too.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("inputs.json"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", action="store_true", help="Read-only readiness and complete-tree inventory")
    mode.add_argument("--pack", action="store_true", help="Create a new evidence directory")
    parser.add_argument("--output", type=Path, help="Required with --pack; directory must not exist")
    args = parser.parse_args()
    if args.pack and args.output is None:
        parser.error("--pack requires explicit --output")
    config_path = args.config.resolve()
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    root = Path(config["workspace"]).resolve()
    script_path = Path(__file__).resolve()
    script_bytes = script_path.read_bytes()
    guard_path = resolve(root, config["sourceGuardManifest"])
    if not stat.S_ISREG(ordinary(guard_path).st_mode):
        raise ValueError("Source guard must be an ordinary file")
    guard_bytes = guard_path.read_bytes()
    expected_sources = json.loads(guard_bytes)
    before = guard_sources(root, expected_sources)
    groups, errors, ids = [], list(config.get("pendingGroups", [])), set()
    for group in config["groups"]:
        try:
            group_id = group["id"]
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", group_id) or group_id in ids:
                raise ValueError(f"Invalid/duplicate group id: {group_id}")
            ids.add(group_id)
            source = resolve(root, group["path"])
            for required in group.get("requiredFiles", []):
                if not stat.S_ISREG(ordinary(source / required).st_mode):
                    raise ValueError(f"Required file missing/non-ordinary: {source / required}")
            entries = scan(source)
            for rule in group.get("checks", []):
                check_json(source, rule, entries)
            groups.append((group, source, entries))
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(f"{group.get('id')}: {error}")
    documents, document_names = [], set()
    reserved = {"index.json", "completed.json", "failed.json", "source-before.json", "source-after.json",
                "controls", "archives", "manifests"}
    devices = {"con", "prn", "aux", "nul"} | {f"{prefix}{number}" for prefix in ("com", "lpt") for number in range(1, 10)}
    for document in config.get("documents", []):
        try:
            destination = document["destination"]
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", destination) or destination.endswith("."):
                raise ValueError(f"Document destination must be one filename: {destination}")
            if (destination.casefold() in reserved or destination.casefold() in document_names
                    or destination.split(".", 1)[0].casefold() in devices):
                raise ValueError(f"Document destination is reserved or duplicated: {destination}")
            document_names.add(destination.casefold())
            source = resolve(root, document["source"])
            if not stat.S_ISREG(ordinary(source).st_mode):
                raise ValueError(f"Document is not an ordinary file: {source}")
            documents.append((source, destination, source.read_bytes()))
        except (OSError, ValueError, KeyError) as error:
            errors.append(f"document: {error}")
    inventory = [{"id": group["id"], "sourceAbsolutePath": str(source),
                  "fileCount": sum(row["kind"] == "file" for row in entries),
                  "directoryCount": sum(row["kind"] == "directory" for row in entries),
                  "totalBytes": sum(row.get("bytes", 0) for row in entries)}
                 for group, source, entries in groups]
    if args.plan:
        guard_sources(root, expected_sources)
        print(encoded({"schemaVersion": 1, "ready": not errors, "groups": inventory,
                       "errors": errors, "suggestedOutput": config.get("suggestedOutput")}).decode(), end="")
        return 0 if not errors else 2
    if errors:
        raise ValueError("Inputs are not ready: " + "; ".join(errors))
    output = resolve(root, str(args.output))
    for _, source, _ in groups:
        if output == source or output.is_relative_to(source) or source.is_relative_to(output):
            raise ValueError(f"Output/source trees must be disjoint: {output}, {source}")
    if config_path.read_bytes() != config_bytes or script_path.read_bytes() != script_bytes:
        raise ValueError("Packer or input plan changed during preflight")
    output.mkdir(parents=True, exist_ok=False)
    try:
        write_new(output / ".gitattributes", b"* -text -whitespace\n")
        write_new(output / "controls/pack.py", script_bytes)
        write_new(output / "controls/inputs.json", config_bytes)
        write_new(output / "controls/source-guard.json", guard_bytes)
        write_new(output / "source-before.json", encoded(before))
        for source, destination, data in documents:
            write_new(output / destination, data)
        rows = []
        for (group, source, entries), counts in zip(groups, inventory):
            archive_rel = f"archives/{group['id']}.tar.gz"
            manifest_rel = f"manifests/{group['id']}.json"
            archive = output / archive_rel
            archive.parent.mkdir(exist_ok=True)
            archive_group(source, entries, archive, group["id"])
            manifest = {"schemaVersion": 1, "id": group["id"], "sourceAbsolutePath": str(source), "entries": entries}
            write_new(output / manifest_rel, encoded(manifest))
            rows.append({**counts, "sourceRelativePath": group["path"], "note": group.get("note", ""),
                         "archivePath": archive_rel, "manifestPath": manifest_rel,
                         "archiveSha256": hash_file(archive), "manifestSha256": hash_file(output / manifest_rel),
                         "completeMemberSetAndByteRoundTripPassed": True})
        for group, source, entries in groups:
            if scan(source) != entries:
                raise ValueError(f"Complete input tree changed before completion: {group['id']}")
        for source, _, data in documents:
            if source.read_bytes() != data:
                raise ValueError(f"Published document source changed: {source}")
        if config_path.read_bytes() != config_bytes or script_path.read_bytes() != script_bytes or guard_path.read_bytes() != guard_bytes:
            raise ValueError("Packer, plan, or frozen source guard changed")
        after = guard_sources(root, expected_sources)
        write_new(output / "source-after.json", encoded(after))
        index = {"schemaVersion": 1, "workspace": str(root), "groupCount": len(rows), "groups": rows,
                 "sourceGuardManifest": config["sourceGuardManifest"], "sourceGuardManifestSha256": digest(guard_bytes),
                 "documents": [{"sourceAbsolutePath": str(source), "path": destination, "sha256": digest(data)}
                               for source, destination, data in documents],
                 "sourceBeforeAfterIdentical": before == after,
                 "allInputTreesUnchanged": True, "allCompleteMemberSetsAndByteRoundTripsPassed": True}
        write_new(output / "INDEX.json", encoded(index))
        outputs = scan(output)
        checksums = {row["path"]: row["sha256"] for row in outputs if row["kind"] == "file"}
        write_new(output / "COMPLETED.json", encoded({"schemaVersion": 1,
                  "completedAt": datetime.now(timezone.utc).isoformat(), "groupCount": len(rows),
                  "sourceBeforeAfterIdentical": before == after, "allInputTreesUnchanged": True,
                  "allCompleteMemberSetsAndByteRoundTripsPassed": True, "sha256": checksums}))
        print(encoded({"output": str(output), "groupCount": len(rows), "completed": True}).decode(), end="")
        return 0
    except BaseException as error:
        write_new(output / "FAILED.json", encoded({"schemaVersion": 1, "error": str(error),
                  "failedAt": datetime.now(timezone.utc).isoformat()}))
        raise


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(encoded({"completed": False, "error": str(error)}).decode(), file=sys.stderr, end="")
        sys.exit(1)
