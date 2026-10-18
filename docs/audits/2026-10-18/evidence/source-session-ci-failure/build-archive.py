"""Copy the declared failed-CI evidence without changing any source bytes."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import shutil
import zipfile


ARCHIVE = Path(__file__).resolve().parent
SOURCE = Path(r"C:\Users\44548\.codex\worktrees\defect-ticket-closure-d5\heimdall\core\workspace\_runs\ci-source-session-failure-20261018")
EXPECTED_RUN = 39078795034
EXPECTED_HEAD = "209cf405656628156952bb43f1188092b4089344"
DIAGNOSIS_NAMES = {
    "build_report.py", "core-test-failure.raw.txt", "core-test-terminal.raw.txt",
    "deliverable-manifest.json", "integrity-check.json", "original-manifest.json",
    "REPORT.md", "source-operations-at-ci.mjs",
}


def digest(path):
    raw = path.read_bytes()
    return {"bytes": len(raw), "sha256": sha256(raw).hexdigest()}


def write_json(name, value):
    with (ARCHIVE / name).open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    source_manifest = json.loads((SOURCE / "original-manifest.json").read_text(encoding="utf-8-sig"))
    assert source_manifest["runId"] == EXPECTED_RUN
    assert source_manifest["attempt"] == 1
    assert source_manifest["headSha"] == EXPECTED_HEAD
    assert source_manifest["fileCount"] == len(source_manifest["files"]) == 75
    assert source_manifest["bytes"] == sum(item["bytes"] for item in source_manifest["files"]) == 4839648
    source_roots = [Path(value).resolve() for value in source_manifest["sourceDirectories"]]
    assert len(source_roots) == 2 and source_roots[0].parent == source_roots[1].parent
    evidence_base = source_roots[0].parent
    assert {path.name for path in SOURCE.iterdir() if path.is_file()} == DIAGNOSIS_NAMES

    planned = []
    for item in source_manifest["files"]:
        source = Path(item["path"]).resolve()
        relative = source.relative_to(evidence_base)
        if len(relative.parts) == 1:
            assert relative.name in {"capture-v2.py", "verify-ci.py"}
            relative = Path("tools") / relative
        else:
            assert any(source.is_relative_to(root) for root in source_roots)
        planned.append({"path": relative.as_posix(), "source": str(source),
                        "role": "original", "bytes": item["bytes"], "sha256": item["sha256"]})
    for name in sorted(DIAGNOSIS_NAMES):
        source = SOURCE / name
        planned.append({"path": "diagnosis/" + name, "source": str(source),
                        "role": "diagnosis", **digest(source)})
    assert len({item["path"] for item in planned}) == len(planned) == 83

    source_before = {}
    for item in planned:
        actual = digest(Path(item["source"]))
        assert actual == {"bytes": item["bytes"], "sha256": item["sha256"]}, item["source"]
        source_before[item["path"]] = actual
        destination = (ARCHIVE / item["path"]).resolve()
        assert destination.is_relative_to(ARCHIVE) and not destination.exists(), str(destination)
    for item in planned:
        destination = ARCHIVE / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item["source"], destination)

    checks = []
    for item in planned:
        source_after = digest(Path(item["source"]))
        archived = digest(ARCHIVE / item["path"])
        expected = source_before[item["path"]]
        assert source_after == archived == expected, item["path"]
        checks.append({"path": item["path"], "role": item["role"],
                       "expected": expected, "sourceBefore": expected,
                       "sourceAfter": source_after, "archived": archived, "passed": True})

    zip_path = next(item["path"] for item in planned if item["path"].endswith("/run-logs.zip"))
    with zipfile.ZipFile(ARCHIVE / zip_path) as archive:
        bad_entry = archive.testzip()
        zip_entries = len(archive.infolist())
    assert bad_entry is None
    recorded_at = datetime.now(timezone.utc).isoformat()
    manifest = {
        "schemaVersion": 1, "recordedAt": recorded_at,
        "repository": "kael-odin/heimdall", "runId": EXPECTED_RUN, "attempt": 1,
        "headSha": EXPECTED_HEAD, "conclusion": "failure",
        "reason": "testCodeFailure / ERR_ASSERTION; root cause remains unconfirmed in the original CI evidence",
        "originalFileCount": 75, "originalBytes": 4839648,
        "diagnosisFileCount": 8, "diagnosisBytes": sum(item["bytes"] for item in planned if item["role"] == "diagnosis"),
        "copiedFileCount": len(planned), "copiedBytes": sum(item["bytes"] for item in planned),
        "pathBase": ".", "files": planned,
    }
    write_json("manifest.json", manifest)
    write_json("archive-integrity.json", {
        "recordedAt": recorded_at, "runId": EXPECTED_RUN, "attempt": 1,
        "headSha": EXPECTED_HEAD, "conclusion": "failure",
        "scope": "Byte preservation only; this does not accept or rerun the failed CI",
        "originalCount": 75, "originalBytes": 4839648,
        "diagnosisCount": 8, "diagnosisBytes": manifest["diagnosisBytes"],
        "verifiedCount": len(checks), "verifiedBytes": manifest["copiedBytes"],
        "allSourcesUnchanged": True, "allCopiesMatch": True,
        "zip": {"path": zip_path, "entries": zip_entries, "crcPassed": bad_entry is None},
        "checks": checks,
    })
    print(json.dumps({key: value for key, value in manifest.items() if key != "files"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
