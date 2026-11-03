# Changelog

All notable changes to Heimdall are recorded here.

## [Unreleased]

### Fixed

- The D7 local acceptance demo now survives the console's `view=acceptance`
  navigation and is covered by the normal quality gate and Hosted CI.
- Cancelling a whole-site clone now cancels the page forge tasks it owns.
- `/px/` follows only bounded same-origin redirects, strips upstream cookies,
  and enforces response time and size budgets.
- Sandboxed clone previews now load local fonts and CSS masks through the
  engine's `/static` route.
- New MCP installations no longer fail on the esbuild build-script decision.
- The Windows rebuild installer no longer interpolates a registry value into a
  shell command.
- Atomic acceptance writes flush temporary files before rename and sync the
  parent directory on POSIX.
- The console keeps Three's circular core/WebGL module groups intact, verifies
  a live WebGL2 star map in Chromium, and no longer emits a chunk over 500 kB.
- Package engines now require Node 22.13, matching the pinned pnpm 11.28.10
  runtime instead of advertising an unsupported Node 20 setup.
- The root Docker image now includes the pnpm override policy files required by
  frozen installation.
- Manual defect-ticket action evidence now uses the complete same-origin relay
  response frame when Chromium reports an already-consumed GET as aborted.
- D7 now clones same-origin acceptance responses at page-fetch time, so a
  completed UI flow no longer depends on Playwright's CDP response body still
  being available. Interactive reads and writes still fail closed when their
  canonical bytes are missing; only an incidental 2xx GET clone abort is
  retained explicitly as `bodyCaptureSkipped`.
- Offline browser probes retry once only when Chromium reports a transient
  launch-process closure or resource failure. Missing executables, invalid
  configuration and exhausted retries still fail the strict gate immediately.
- The core test runner now removes the extra pnpm `--` separator before
  forwarding Node test options, so Hosted CI's two jobs actually shard the
  full suite instead of each running all 3,011 tests.

### Security

- Updated Vite to the patched 8.3 line.
- Pinned `source-map-js` to 1.2.2.
- Overrode ExcelJS transitive `uuid` and `minimatch` versions to patched
  releases.
- Updated the pinned pnpm toolchain to 11.28.10, closing four high-severity
  package-manager advisories.
- Added independent core, console and MCP dependency-audit jobs to CI; all
  three pass against the official npm registry with no known vulnerabilities.

### Documentation

- Added a 2026-11-03 repository audit and refreshed status/demo guidance.
- Added an explicit open-source license, security policy, contributing guide,
  and dependency update automation.

### Verification

- Full core suite on Hosted Node 22, after real sharding: 3,012 tests,
  3,008 passed, 0 failed, 4 skipped.
- Acceptance benchmark: 18/18 cases and 13/13 source localizations.
- QA benchmark: 21/21 defects, 0 false positives.
- D7 real-browser acceptance demo: `accepted:true`, 0 capture failures, and
  1 explicitly recorded incidental GET body skip.

## [2.0.0-dev] - 2026-09-01

- Initial public development line for the site mirror, fidelity, SEO,
  acceptance, QA, AI rebuild, CLI, MCP, and console workbench.
