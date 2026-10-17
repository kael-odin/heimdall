# D3 owner-loss CI hotfix evidence - 2026-10-17

## Scope and source boundary

- Base HEAD: e3cc0ee1fd9407f2f732b38350bd6514d5983935.
- Changed tracked file: core/test/acceptance-browser-fixed-runner.test.mjs only.
- Product runner unchanged: core/src/acceptance/runner.mjs SHA256 c0f249bd45b1f3b5e42383297b332fa57f126605b809e09eac7b781ee058cc57.
- Final changed test SHA256: fa294e582f508c3e2b6166187e960e6335a1b9b9c2d1c8cf59627491552e8cf5.
- No Chromium/browser process, external target navigation, commit or push was run. All browser launches in this test file are mocked.

## Root cause and minimal change

The fake Browser held pending navigation only as a JavaScript Promise. Its only referenced owner-loss timer expired after 30 ms; the production 100 ms ownership monitor, deadline timer and heartbeat are intentionally unref'ed. With no real driver IPC handle, Node 22 could finish the event loop while the test Promise was pending. The CI cancellation is therefore a test transport lifecycle defect, with the next two cancelled tests being collateral cancellation.

The fake Browser now owns a referenced MessageChannel to model the lifetime of a real Playwright driver connection. browser.close closes both ports before rejecting pending navigation; t.after also closes both ports for teardown. This keeps the ownership check observable while navigation is pending and releases the handle when the Browser closes. A real product hang still remains a pending test; no result or timer is manufactured by this channel.

The original ownership error-code assertion, <1500 ms execution bound, close-count assertion and source-only evidence assertions are unchanged. All other assertions and test selection are unchanged. Product timers remain unref'ed.

## Verification matrix

| Source | Runtime | Selection | Result | Evidence |
| --- | --- | --- | --- | --- |
| Original | Windows Node v25.2.1 | owner-loss isolated | pass 1, cancelled 0 (does not reproduce) | before-isolated.stdout / .exit |
| Original | Windows Node v22.23.3 | owner-loss isolated | pass 0, cancelled 1, exit 1 | before-node22-windows.stdout / .exit |
| Original, import-only relocated artifact | WSL Ubuntu Linux Node v22.23.3 | owner-loss isolated | pass 0, cancelled 1, exit 1 | before-node22-linux-relocated-isolated.stdout / .exit |
| Fixed | Windows Node v22.23.3 | owner-loss isolated | pass 1, cancelled 0, skipped 0, exit 0 | after-node22-windows-isolated.stdout / .exit |
| Fixed | Windows Node v22.23.3 | full file | pass 15, cancelled 0, skipped 0, exit 0 | after-node22-windows-full.stdout / .exit |
| Fixed | WSL Ubuntu Linux Node v22.23.3 | full file | pass 15, cancelled 0, skipped 0, exit 0 | after-node22-linux-full.stdout / .exit |

Both Node 22 before runs reported the exact CI error: `Promise resolution is still pending but the event loop has already resolved` with `cancelledByParent`. Both full fixed runs exited naturally after completing all tests; the referenced transport did not leave the event loop alive.

The Linux before artifact was generated from git show HEAD:core/test/acceptance-browser-fixed-runner.test.mjs and changes only the relative imports so it can run from this ignored evidence directory. Test bodies including the pre-fix fake Browser and owner-loss assertions are identical to HEAD. Its output folder also resolves below ignored workspace/_runs. It is not part of the tracked change.

`npx --yes --package=node@22 node --check core/test/acceptance-browser-fixed-runner.test.mjs` and `git diff --check` passed. `git status --short` lists only the intended tracked test file. Full Core and hosted GitHub CI were not run by this subagent; the parent owns those gates and publication.
