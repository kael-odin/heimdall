"""Read-only integrity check. Controlled failures remain failed experiments."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
read = lambda name: json.loads((root / name).read_text(encoding="utf-8"))
manifest = read("manifest.json")
assert manifest["copiedFiles"] == len(manifest["files"]) == 51
assert manifest["copiedBytes"] == sum(row["bytes"] for row in manifest["files"]) == 268385
for row in manifest["files"]:
    path = root / row["path"]
    assert path.resolve().is_relative_to(root)
    data = path.read_bytes()
    assert len(data) == row["bytes"], row["path"]
    assert hashlib.sha256(data).hexdigest() == row["sha256"], row["path"]
for name, count, code in [
    ("baseline-results.json", 20, 0),
    ("two-core-observation-results.json", 10, 0),
    ("two-core-load-results.json", 1, 1),
    ("two-core-observation2-results.json", 1, 1),
]:
    rows = read(name)
    assert len(rows) == count
    assert all(row["exitCode"] == code for row in rows), name
gates = read("targeted-gates.json")
assert gates["complete"] and gates["passed"] and gates["inputsUnchanged"]
assert gates["inputCount"] == 614
assert read("inputs-before.json") == read("inputs-after.json")
assert [row["name"] for row in gates["results"]] == ["source-operations", "lint", "docs"]
assert all(row["exitCode"] == 0 for row in gates["results"])
print(json.dumps({"integrityVerified": True, "copiedFiles": 51, "copiedBytes": 268385,
                  "controlledFailuresPreserved": 2, "ciAcceptanceClaimed": False}))
