# Browser private reading — own-commit CI archive

GitHub run [38992636174](https://github.com/kael-odin/heimdall/actions/runs/38992636174), attempt 1, checks head `ee4d1a7e731811b0df3a0b9d27a177d2cf851689` on `main` (`push`). Its conclusion is **success**. No previous commit CI or local schema work is included.

- Core: **2087 total / 2083 pass / 0 fail / 4 skipped**.
- Acceptance smoke steps: **13/13 successful**.
- Separate Docker step: **2 total / 2 pass / 0 fail / 0 skipped**.
- Browser source summary: 8 checks; Browser private reading summary: 13 checks. Exact structured summaries and skip names are in summary.json.

The Core suite is counted once. Smoke and Docker checks are reported separately and are never added to that total. The three-job timeline and all 13 smoke outcomes are preserved in jobs.json and summary.json.

run.json, jobs.json, artifacts.json and run-view.json retain the exact gh output bytes. ci.stdout.gz losslessly stores the complete gh run view --log output; its decompressed SHA-256 is `d50451783994e29274bdf582970a22a672d0ec38f2d66876923460f662a6ea2f` (1551632 bytes). run-logs.zip retains the original GitHub logs ZIP, SHA-256 `5f905816591edcc4d39be44feef8a9a26202049ec3d65ac33904f71a14cb991c` (437529 bytes), and its directory was read successfully (59 entries). source-files.json records source and stored byte hashes.

This GitHub run published no Actions artifacts. The archive preserves exact API JSON, complete gh log output and original log ZIP; it does not contain the remote fresh Browser material tree or claim screenshot-byte replay.

Original downloads and the archive script remain under `core/workspace/_runs/browser-reading-ci-main-ee4d1a7/`. This child directory inherits its parent's `* -text` policy for archived bytes; README.md retains LF text handling.
