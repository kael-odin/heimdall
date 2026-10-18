"""Read-only, offline verification of the relative failed-CI archive manifest."""
from hashlib import sha256
from pathlib import Path, PurePosixPath
import json
import zipfile


def main():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["runId"] == 39078795034 and manifest["attempt"] == 1
    assert manifest["headSha"] == "209cf405656628156952bb43f1188092b4089344"
    assert manifest["conclusion"] == "failure"
    rows = manifest["files"]
    assert len(rows) == len({row["path"] for row in rows}) == manifest["copiedFileCount"] == 83
    for row in rows:
        relative = PurePosixPath(row["path"])
        assert not relative.is_absolute() and ".." not in relative.parts
        path = (root / Path(*relative.parts)).resolve()
        assert path.is_relative_to(root)
        raw = path.read_bytes()
        assert len(raw) == row["bytes"] and sha256(raw).hexdigest() == row["sha256"], row["path"]
    originals = [row for row in rows if row["role"] == "original"]
    diagnosis = [row for row in rows if row["role"] == "diagnosis"]
    assert len(originals) == manifest["originalFileCount"] == 75
    assert sum(row["bytes"] for row in originals) == manifest["originalBytes"] == 4839648
    assert len(diagnosis) == manifest["diagnosisFileCount"] == 8
    assert sum(row["bytes"] for row in diagnosis) == manifest["diagnosisBytes"]
    assert sum(row["bytes"] for row in rows) == manifest["copiedBytes"]

    preserved = json.loads((root / "diagnosis/original-manifest.json").read_text(encoding="utf-8-sig"))
    assert preserved["fileCount"] == 75 and preserved["bytes"] == 4839648
    declared = {(row["path"], row["bytes"], row["sha256"]) for row in preserved["files"]}
    copied = {(row["source"], row["bytes"], row["sha256"]) for row in originals}
    assert declared == copied
    for directory in (root / row for row in ("diagnosis", "tools")):
        actual_paths = {path.relative_to(root).as_posix() for path in directory.rglob("*") if path.is_file()}
        expected_paths = {row["path"] for row in rows if row["path"].startswith(directory.name + "/")}
        assert actual_paths == expected_paths
    original_roots = {PurePosixPath(row["path"]).parts[0] for row in originals} - {"tools"}
    for name in original_roots:
        actual_paths = {path.relative_to(root).as_posix() for path in (root / name).rglob("*") if path.is_file()}
        expected_paths = {row["path"] for row in originals if row["path"].startswith(name + "/")}
        assert actual_paths == expected_paths
    integrity = json.loads((root / "archive-integrity.json").read_text(encoding="utf-8"))
    assert integrity["allSourcesUnchanged"] is True and integrity["allCopiesMatch"] is True
    assert len(integrity["checks"]) == 83 and all(row["passed"] is True for row in integrity["checks"])
    for check, row in zip(integrity["checks"], rows):
        assert check["path"] == row["path"] and check["role"] == row["role"]
        expected = {"bytes": row["bytes"], "sha256": row["sha256"]}
        assert all(check[key] == expected for key in ("expected", "sourceBefore", "sourceAfter", "archived"))
    zip_row = next(row for row in originals if row["path"].endswith("/run-logs.zip"))
    with zipfile.ZipFile(root / zip_row["path"]) as archive:
        assert archive.testzip() is None
        zip_entries = len(archive.infolist())
    assert integrity["zip"] == {"path": zip_row["path"], "entries": zip_entries, "crcPassed": True}
    print(json.dumps({"passed": True, "meaning": "archive integrity only",
                      "runId": manifest["runId"], "conclusion": "failure",
                      "originalCount": len(originals), "originalBytes": manifest["originalBytes"],
                      "diagnosisCount": len(diagnosis), "diagnosisBytes": manifest["diagnosisBytes"],
                      "verifiedCount": len(rows), "verifiedBytes": manifest["copiedBytes"],
                      "zipEntries": zip_entries, "zipCrcPassed": True}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
