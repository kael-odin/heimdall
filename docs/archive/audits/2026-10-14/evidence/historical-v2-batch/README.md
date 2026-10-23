# Historical v2 Batch Evidence

This directory is a read-only copy of the five-page isolated verification snapshot used in the 2026-10-14 audit.

- `pages.csv` has 408 candidate rows: 407 pages with a clone, plus one `no_clone` row that is excluded from the 407-page denominator.
- The measured state is 4 `measured`, 1 `unmeasured`, and 402 `pending` among the 407 cloned pages.
- `verify/<host>/<page>/verify.json` contains the copied result files. The `evidence` values in the CSV and JSON snapshots are relative to this directory.
- `diff/<page>/diff-<viewport>.png` contains the 13 generated visual-difference images, including the desktop-only image for the long unmeasured page.
- The source run directory is intentionally not part of the report; it remains under the ignored `core/workspace/_runs/historical-v2-batch/` path for continuation.
- The snapshot predates the expanded verifier and runtime-dependency fingerprint gate. A future continuation must revalidate the five recorded pages before moving on to pending pages.

The batch invokes `verify.mjs --no-interactions`, so these results cover three viewport visual verification only. They do not certify interaction replay, authentication, offline deployment, or arbitrary external sites.
