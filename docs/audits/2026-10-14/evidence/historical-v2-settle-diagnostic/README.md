# Historical v2 render-settle diagnostic

Captured on 2026-10-15 (Asia/Hong_Kong) before the visible-image settle fix. The verifier fingerprint is `cd725632a1b1687b3c2017d2122b3af5fd71999c82673391aa08e2ffcbc93c24`. This is a diagnostic snapshot, not the final five-page score baseline.

The isolated run used `core/scripts/verify-historical-batch.mjs` with one explicit page per invocation, a 50 MB input-copy limit, a 9-minute run limit, `--keep-screenshots`, and `verify.mjs --no-interactions`. Source pages under `core/workspace/<host>/pages` were read only. The writable run is `core/workspace/_runs/historical-v2-batch/`.

| Page | State | Overall | Reason |
| --- | --- | ---: | --- |
| `apify.com/ideas` | unmeasured | n/a | `375x812: render did not settle` |
| `apify.com/jobs` | unmeasured | n/a | `375x812: render did not settle` |
| `apify.com/apify-instagram-scraper` | unmeasured | n/a | `375x812: render did not settle` |
| `angular.dev/ai` | measured | 90.55% (B) | Three viewports measured |
| `angular.dev/home` | measured | 94.80% (B) | Three viewports measured |

The inventory has 407 cloned pages: 2 measured, 3 unmeasured, 402 pending. One additional row is `no_clone`. `lastRun.status=partial` is expected while other pages remain pending. The three unmeasured pages have provisional viewport pixel values, but no valid overall score or grade.

`progress.json`, `pages.csv`, `viewports.csv`, and the five `verify/<host>/<page>/verify.json` files preserve the machine-readable state. `verify-*.log` and `engine.log` preserve execution output. `samples/` contains selected source, clone, and diff PNGs for visual diagnosis; the full screenshot and diff set remains in the isolated run directory. The JSON settle data shows incomplete images on both source and clone for all three unmeasured pages, including after scrolling. It does not prove that every incomplete image was in the visible viewport.

These results cover visual comparison only. They do not establish interaction fidelity, authenticated pages, or offline behavior.
