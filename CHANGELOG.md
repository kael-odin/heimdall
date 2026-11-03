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

- Full core suite: 3,010 tests, 2,998 passed, 0 failed, 12 skipped.
- Acceptance benchmark: 18/18 cases and 13/13 source localizations.
- QA benchmark: 21/21 defects, 0 false positives.
- D7 real-browser acceptance demo: `accepted:true`.

## [2.0.0-dev] - 2026-09-01

- Initial public development line for the site mirror, fidelity, SEO,
  acceptance, QA, AI rebuild, CLI, MCP, and console workbench.
