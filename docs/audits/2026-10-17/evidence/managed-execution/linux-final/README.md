# Final fixture POSIX lifecycle verification

This is a new immutable run after the shared fixture added bounded diagnostics. Earlier evidence in the parent directory remains unchanged.

The final fixture SHA-256 is 1103aac84ef72b5607f505282216f30166ffebfe6ee46a9d8c67838c37c762bb. Comparing all captured inputs against the prior snapshot found only core/scripts/fixtures/managed-execution.mjs changed; the tracked lifecycle test and production sources are identical.

WSL Ubuntu-24.04 / Node v22.23.3 / /tmp ext4: POSIX SIGTERM case 1 passed, 0 failed, 0 skipped, 626.640437 ms. It verifies interrupted/ENGINE_SHUTDOWN settlement, no report publication, target abort and no replay execution after restart.

Snapshot: 479 files, 21784952 bytes. Linux before/after and final current-input verification each report changed=[]. No dependencies were installed; earlier snapshot pins were not edited.

Snapshot manifest SHA-256: b5c158c8900b0d4dfe6c8615f3bc69ef0d53d6b61b3e2cd26f2e68ae451683ed

Tracked test SHA-256: 9e95186807dbfab4a268d84667e70f63349c17482ed0e686f5357189137cc2a5

Windows socket cases were already observed passing in the preceding fixture revision and were not rerun here; this requested rerun is the final POSIX case only. Root's final max-4 full suite overlapped this short rerun.
