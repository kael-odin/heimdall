# D5 independent public evidence verification

Status: passed

```json
{
  "status": "passed",
  "archiveIndexSha256": "40897db2e88dbf78419d2908e4fcdff421f6f925a674bc94c3e6933aed8822b4",
  "publicDirectory": "C:\\Users\\44548\\.codex\\worktrees\\defect-ticket-closure-d5\\heimdall\\docs\\audits\\2026-10-18\\evidence\\defect-tickets",
  "finalBatchDirectory": "C:\\Users\\44548\\.codex\\worktrees\\defect-ticket-closure-d5\\heimdall\\core\\workspace\\_runs\\d5-gates-20261018\\batch-d616f4c9-f7a7-422b-8236-50ba987818b2",
  "archives": 56,
  "archiveFiles": 9959,
  "specialEntries": 6,
  "directCopies": 30,
  "finalGates": {
    "build": "build-d8adf122-2059-4b2b-9e00-fb94a2eb9f2c",
    "browser": "browser-443e598a-9d5a-44d8-a579-42fb0010c5ee",
    "core": "core-5a20bdee-ed8b-42bf-b5de-4813d5251d51",
    "original": "original-58abd2b4-7292-432b-a184-15bccfc9fcd4",
    "managed": "managed-e7810ae0-4c8c-473f-b9a4-5ac0b64bde0b",
    "d3": "d3-28ad1909-cb62-49cb-a795-976cc9ad0f9a",
    "d4": "d4-d5f46242-8ca5-409e-8f16-b8b2eded7627",
    "candidates": "candidates-e24b5447-b9f4-4313-94c0-50e7bd92de6c",
    "bindings": "bindings-790e3b89-5c50-4e68-b076-49d2c54a52f6",
    "recovery": "recovery-c5c052da-0c99-4972-ba75-a15953ad501a",
    "cdp": "cdp-e3fd944b-bc78-4381-be11-320137aca17c",
    "forge": "forge-0ed1bcf5-8c1b-4da9-a653-f3cdc9aaf9a1",
    "benchmark": "benchmark-6a8c36e9-b4c1-49b9-96ca-bed0b2e563bb",
    "specbenchmark": "specbenchmark-36574644-5cc1-4cf4-a170-5933b783ec51",
    "comparisonbenchmark": "comparisonbenchmark-c9f2a2ba-1316-46fe-9894-6fdb11ddabfa",
    "lint": "lint-aee8b31c-a768-4acc-bed7-c5b219246716",
    "docs": "docs-861d5691-cb16-4720-8031-0d519a52fb87"
  },
  "sourceFiles": 629,
  "fullCoreReporter": "node-spec",
  "fullCoreCounts": {
    "tests": 2661,
    "pass": 2649,
    "fail": 0,
    "cancelled": 0,
    "skipped": 12,
    "todo": 0
  },
  "baselineCommit": "5006e16bf73e47f36877da24df4ac4a5c8207965",
  "verifierFiles": 8,
  "d5Checks": 10,
  "screenshots": [
    {
      "file": "defect-ticket-open-desktop.png",
      "bytes": 120792,
      "sha256": "f425c71a3df33da1715a7221249d40e1b3f96a548bd5cbec50518f25abf0b71e",
      "viewport": [
        1440,
        1000
      ]
    },
    {
      "file": "defect-ticket-open-mobile.png",
      "bytes": 47780,
      "sha256": "6f4dabb53f0c1bc0793ff4d310125e6175d6e7f2153b17b6f2423e4e85d8339d",
      "viewport": [
        390,
        844
      ]
    },
    {
      "file": "defect-ticket-reopened-desktop.png",
      "bytes": 134079,
      "sha256": "9b91b0b65915e0f74675478f114caade4dd261626b83af2167729763d94451ad",
      "viewport": [
        1440,
        1000
      ]
    },
    {
      "file": "defect-ticket-reopened-mobile.png",
      "bytes": 47881,
      "sha256": "e094348a3cf910a74a24d4f3e6b8cbcb8a8558f4c0462f0d5fdaf4a2c67f1335",
      "viewport": [
        390,
        844
      ]
    }
  ],
  "pageErrors": 0,
  "controlledConsoleMessages": 3,
  "explicitTicketPosts": 4,
  "lostActionGetReconciliations": 2,
  "explicitBrowserExecutions": 6,
  "explicitRegistrations": 6,
  "originalSourceChecks": 14,
  "limitations": [
    "Read-only artifact verification; no Browser, tests or engine were started.",
    "PNG signature/dimensions/SHA and DOM were verified; this is not a visual human review.",
    "Lost-response Browser evidence is route.fetch/502 simulation, not a TCP or power-loss test.",
    "The Browser request log covers /api/acceptance; unrelated Browser network is outside that log.",
    "The input freeze covers the enumerated maintained source/build inputs, not every Markdown file.",
    "Existing Symlink/Junction metadata and Python readlink substitution-target strings are preserved without following or extracting links; raw reparse buffers and arbitrary reparse types are outside this contract.",
    "Original files are frozen by workflow and checked again; Windows lstat/read is not an atomic defense against concurrent malicious replacement.",
    "This does not certify atomic multi-file snapshots or detect a self-consistent external backup rollback."
  ],
  "startedAt": "2026-10-17T21:25:02.421735+00:00",
  "endedAt": "2026-10-17T21:25:27.539899+00:00",
  "verifierSha256": "9b998bc3f622cc505f12c52f1ec0db692ce1fea594af1296999cc20c20c4f33d"
}
```
