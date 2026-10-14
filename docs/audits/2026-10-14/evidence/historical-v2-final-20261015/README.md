# Historical v2 five-page revalidation

Captured on 2026-10-15 (Asia/Hong_Kong) for the 2026-10-14 repository audit. Verifier fingerprint: `22e4ba92a63d31455b31db1ec0041ae318c0b0744e7594ada189030be2783a4f`.

Each page was run explicitly through `core/scripts/verify-historical-batch.mjs` in `core/workspace/_runs/historical-v2-batch/` with `--max-pages 1 --max-copy-mb 50 --max-page-mb 50 --max-minutes 9 --keep-screenshots`. The batch stages `manifest.json` and `clone/` in that isolated run and invokes `verify.mjs --no-interactions`. Original workspace pages were read only; no source session was staged.

| Page | Final state | Valid overall | Notes |
| --- | --- | ---: | --- |
| `apify.com/ideas` | unmeasured | n/a | `375x812: render did not settle` |
| `apify.com/jobs` | unmeasured | n/a | `375x812: render did not settle` |
| `apify.com/apify-instagram-scraper` | unmeasured | n/a | `375x812: render did not settle`; mobile source 33,465px, clone 32,231px |
| `angular.dev/ai` | measured | 90.55% (B) | All three viewports measured |
| `angular.dev/home` | measured | 94.80% (B) | All three viewports measured |

The full historical inventory has 407 cloned pages: **2 measured, 3 unmeasured, 402 pending**. One additional row is `no_clone`, outside the 407-page denominator. `progress.json` reports `remaining=405`; this includes the three unmeasured pages. Its final `lastRun.status=partial` also reflects the still-pending inventory, not a five-page completion claim. The three provisional `apify.com` pixel comparisons are not valid overall scores or grades.

This snapshot supersedes the earlier `historical-v2-batch` and `historical-v2-settle-diagnostic` snapshots for these five pages. Scores measured under an older verifier fingerprint are historical evidence only; they do not fill the three current unmeasured results.

`progress.json`, `pages.csv`, `viewports.csv`, and the five `data/workspace/<host>/verify/<page>/verify.json` files are copied without rewriting their evidence paths. All 29 generated diff PNGs are included under those same page directories: 3 each for `ideas`, `jobs`, `ai`, and `home`, plus 17 for `apify-instagram-scraper` (16 tiled mobile/tablet parts and one desktop image). `samples/` contains selected source and clone images; full source/clone screenshots remain under the ignored isolated run. The two measured JSON SHA-256 values and their diff-image hashes match `progress.json`, and every diff file named by the five JSON results is present. The five `verify-*.log` files show the page executions; `engine.log` contains the final invocation's engine output.

The unsettled `apify.com` results occurred after the visible-image settle correction. For `ideas`, the original page still had 4 pending requests at the 375px before/after settle checks, while the clone settled. The JSON files preserve settle metrics for all viewports. This evidence covers visual comparison only; interactions, authentication, external-site variability, and offline delivery were not verified by this batch.
