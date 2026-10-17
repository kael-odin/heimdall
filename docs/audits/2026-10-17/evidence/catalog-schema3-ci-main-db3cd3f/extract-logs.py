import hashlib
import json
import pathlib
import stat
import sys
import zipfile

archive = pathlib.Path(sys.argv[1]).resolve(strict=True)
output = pathlib.Path(sys.argv[2])
output.mkdir()  # Never merge with or overwrite an existing extraction.
output = output.resolve(strict=True)
files = []
seen = set()
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None, "ZIP CRC verification failed"
    entries = bundle.infolist()
    for entry in entries:
        name = entry.filename
        relative = pathlib.PurePosixPath(name)
        assert name and "\\" not in name and not relative.is_absolute()
        assert all(part not in (".", "..") and ":" not in part for part in relative.parts)
        assert not stat.S_ISLNK(entry.external_attr >> 16)
        assert not entry.flag_bits & 1, "Encrypted log entry refused"
        folded = name.casefold().rstrip("/")
        assert folded not in seen, "Duplicate/case-colliding ZIP name"
        seen.add(folded)
        target = output.joinpath(*relative.parts)
        assert target.resolve().is_relative_to(output)
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        data = bundle.read(entry)
        assert len(data) == entry.file_size
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as destination:
            destination.write(data)
        assert target.read_bytes() == data
        files.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                      "compressedBytes": entry.compress_size, "crc32": f"{entry.CRC:08x}"})
print(json.dumps({"schemaVersion": 1, "zipEntries": len(entries), "fileCount": len(files),
                  "bytes": sum(item["bytes"] for item in files), "crcTestPassed": True,
                  "allExtractedBytesEqualZipEntries": True, "files": files}, indent=2) + "\n", end="")
