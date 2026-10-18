# D5 精确提交 CI 独立核验

- Run: `39096514869` / attempt `1` / head `06e4303871d485a14b66d24318db80595a3db774`
- API结论: `completed` / `failure`
- 原件完整: `False`；身份匹配: `True`；执行验收: `False`
- 核验项: 329；失败: 14

原件与派生解析分开保存，所有数字均来自本次精确提交日志。

|Job|状态|结论|
|---|---|---|
|core (lint + test)|completed|success|
|console (build)|completed|success|
|core (e2e smoke, local fixture)|completed|failure|

主Core测试统计：

```json
{
  "path": "core (lint + test)/11_Run pnpm test.txt",
  "stats": {
    "tests": 2751,
    "suites": 0,
    "pass": 2747,
    "fail": 0,
    "cancelled": 0,
    "skipped": 4,
    "todo": 0,
    "duration_ms": 1754672.87174
  },
  "skippedTests": [
    "real Windows reader holding a non-delete-sharing file handle releases after 180ms and replacement succeeds",
    "real Windows non-share-delete reader releases and replacement retries successfully",
    "Docker network-none delivery serves SSR, SPA and data-driven SPA bundles without a source workspace",
    "Docker network-none delivery persists adapter writes in a volume after container recreation"
  ]
}
```

D3/D4及D5事件：

```json
[
  {
    "command": "pnpm acceptance:browser:execute:smoke",
    "name": "Browser single-operation execution (fixed source, real target BUG, explicit retest and restart)",
    "path": "core (lint + test)/29_Browser single-operation execution (fixed source, real target BUG, explicit retest and restart).txt",
    "apiConclusion": "success",
    "events": [
      {
        "status": "passed",
        "checks": 16,
        "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/browser-execution-console-smoke-d4b95f7d-5fc9-4bc0-ad02-7210bcb450bd"
      }
    ]
  },
  {
    "command": "pnpm acceptance:browser:resolution:smoke",
    "name": "Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks)",
    "path": "core (lint + test)/30_Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks).txt",
    "apiConclusion": "success",
    "events": [
      {
        "status": "passed",
        "checks": 9,
        "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/browser-resolution-console-smoke-03b2d35f-0069-4c1f-8fcb-adfb0ac56ccc"
      }
    ]
  },
  {
    "command": "pnpm acceptance:defect:tickets:smoke",
    "name": "Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation)",
    "path": "core (lint + test)/31_Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation).txt",
    "apiConclusion": "success",
    "events": [
      {
        "startedAt": "2026-10-18T04:56:07.739Z",
        "endedAt": "2026-10-18T04:58:16.372Z",
        "passed": true,
        "checkCount": 10,
        "checks": {
          "realSourceAndRegisteredVisualBehaviorFailures": true,
          "fixedMembersAndLostCreateReconcileAfterReloadWithoutPost": true,
          "partialRepairCannotCloseFixedMemberSet": true,
          "allMembersRequireExplicitCloseAndLostCloseUsesOnlyGet": true,
          "reliableFailureReopensAndLaterPassDoesNotAutoClose": true,
          "definiteStalePostRetainsDraftAndRequiresFreshExplicitPreview": true,
          "markdownAndJsonDownloadsPreserveHistoryAndOmitRecognizedSecrets": true,
          "restartReadsExactTicketWithoutStartingOrRegisteringBrowserWork": true,
          "renderedDesktopMobileAndOriginalSourceIntegrity": true,
          "consoleErrorsAreOnlyTheExplicitControlledHttpFailures": true
        },
        "captures": [
          "defect-ticket-open-desktop.png",
          "defect-ticket-open-mobile.png",
          "defect-ticket-reopened-desktop.png",
          "defect-ticket-reopened-mobile.png"
        ],
        "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/defect-tickets-console-smoke-3b82fba9-2339-41fd-b818-4d057eac1bed",
        "evidenceLevel": "real-local-chromium-fixed-captured-source-explicit-manual-ticket-lifecycle",
        "browserPath": "Browser plugin not available; repository Playwright/CDP",
        "pageErrors": [],
        "consoleMessageCount": 3,
        "controlledReplyCount": 3
      }
    ]
  }
]
```

D5核验：10个true key、4张截图、0个page error、3条受控HTTP控制台错误；不声称控制台零错误。

```json
{
  "path": "core (lint + test)/31_Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation).txt",
  "summary": {
    "startedAt": "2026-10-18T04:56:07.739Z",
    "endedAt": "2026-10-18T04:58:16.372Z",
    "passed": true,
    "checkCount": 10,
    "checks": {
      "realSourceAndRegisteredVisualBehaviorFailures": true,
      "fixedMembersAndLostCreateReconcileAfterReloadWithoutPost": true,
      "partialRepairCannotCloseFixedMemberSet": true,
      "allMembersRequireExplicitCloseAndLostCloseUsesOnlyGet": true,
      "reliableFailureReopensAndLaterPassDoesNotAutoClose": true,
      "definiteStalePostRetainsDraftAndRequiresFreshExplicitPreview": true,
      "markdownAndJsonDownloadsPreserveHistoryAndOmitRecognizedSecrets": true,
      "restartReadsExactTicketWithoutStartingOrRegisteringBrowserWork": true,
      "renderedDesktopMobileAndOriginalSourceIntegrity": true,
      "consoleErrorsAreOnlyTheExplicitControlledHttpFailures": true
    },
    "captures": [
      "defect-ticket-open-desktop.png",
      "defect-ticket-open-mobile.png",
      "defect-ticket-reopened-desktop.png",
      "defect-ticket-reopened-mobile.png"
    ],
    "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/defect-tickets-console-smoke-3b82fba9-2339-41fd-b818-4d057eac1bed",
    "evidenceLevel": "real-local-chromium-fixed-captured-source-explicit-manual-ticket-lifecycle",
    "browserPath": "Browser plugin not available; repository Playwright/CDP",
    "pageErrors": [],
    "consoleMessageCount": 3,
    "controlledReplyCount": 3
  },
  "consoleExpectation": "Three explicitly controlled HTTP errors; zero page errors does not mean zero console errors."
}
```

Docker统计：

```json
{
  "path": "core (lint + test)/33_Docker offline delivery (SSR + SPA + data SPA + adapter).txt",
  "stats": {
    "tests": 2,
    "suites": 0,
    "pass": 2,
    "fail": 0,
    "cancelled": 0,
    "skipped": 0,
    "todo": 0,
    "duration_ms": 40891.530674
  },
  "passedTests": [
    "Docker network-none delivery serves SSR, SPA and data-driven SPA bundles without a source workspace",
    "Docker network-none delivery persists adapter writes in a volume after container recreation"
  ]
}
```

20项后续smoke：

- `pnpm acceptance:smoke`：`success`；`core (lint + test)/12_Acceptance console (real browser, local model stub).txt`
- `pnpm acceptance:spec:smoke`：`success`；`core (lint + test)/13_Spec contract console (real browser, local API fixture).txt`
- `pnpm acceptance:comparison:smoke`：`success`；`core (lint + test)/14_Acceptance comparison console (explicit runs, integrity and CLI).txt`
- `pnpm acceptance:catalog:smoke`：`success`；`core (lint + test)/15_Acceptance project catalog (versions, explicit bindings and two-engine isolation).txt`
- `pnpm acceptance:catalog:migration:smoke`：`success`；`core (lint + test)/16_Acceptance catalog explicit migration (legacy artifacts, CLI confirmation and browser continuity).txt`
- `pnpm acceptance:baseline:smoke`：`success`；`core (lint + test)/17_Spec baseline review (candidates, approvals, selections and source integrity).txt`
- `pnpm acceptance:managed:prepare:smoke`：`success`；`core (lint + test)/18_Managed Spec preparation (immutable contract, replay and zero execution).txt`
- `pnpm acceptance:managed:read:smoke`：`success`；`core (lint + test)/19_Managed Spec result reading (captured evidence and zero execution).txt`
- `pnpm acceptance:owned:recovery:smoke`：`success`；`core (lint + test)/20_Owned acceptance recovery (startup barrier, restart and zero execution).txt`
- `pnpm acceptance:managed:execute:smoke`：`success`；`core (lint + test)/21_Managed Spec execution (fresh admission, real runner, BUG and cancel).txt`
- `pnpm acceptance:execution:ui:smoke`：`success`；`core (lint + test)/22_Managed execution UI (explicit click, durable recovery and stop).txt`
- `pnpm acceptance:browser:source:smoke`：`success`；`core (lint + test)/23_Browser candidate source (fresh captures and explicit healthy side).txt`
- `pnpm acceptance:browser:read:smoke`：`success`；`core (lint + test)/24_Browser private source reader (owner fences and unchanged originals).txt`
- `pnpm acceptance:browser:bindings:smoke`：`success`；`core (lint + test)/25_Browser source bindings (fresh captures, explicit sides and source revalidation).txt`
- `pnpm acceptance:browser:bindings:ui:smoke`：`success`；`core (lint + test)/26_Browser source binding console (native HTTP, source review and verified evidence).txt`
- `pnpm acceptance:browser:bindings:v4:smoke`：`success`；`core (lint + test)/27_Schema4 combined history (fresh Browser bindings and explicit Spec lifecycle fixtures).txt`
- `pnpm acceptance:browser:candidates:ui:smoke`：`success`；`core (lint + test)/28_Browser full candidates (explicit review, durable save and read-only reconciliation).txt`
- `pnpm acceptance:browser:execute:smoke`：`success`；`core (lint + test)/29_Browser single-operation execution (fixed source, real target BUG, explicit retest and restart).txt`
- `pnpm acceptance:browser:resolution:smoke`：`success`；`core (lint + test)/30_Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks).txt`
- `pnpm acceptance:defect:tickets:smoke`：`success`；`core (lint + test)/31_Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation).txt`

未通过核验项：

```json
[
  {
    "category": "execution",
    "name": "run completed successfully",
    "passed": false,
    "detail": {
      "status": "completed",
      "conclusion": "failure"
    }
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) completed successfully",
    "passed": false,
    "detail": null
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) / Manual defect ticket decisions (four real UI races)",
    "passed": false,
    "detail": {
      "number": 9,
      "status": "completed",
      "conclusion": "failure"
    }
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) / Verify manual defect ticket decision evidence",
    "passed": false,
    "detail": {
      "number": 10,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) / Run pnpm smoke",
    "passed": false,
    "detail": {
      "number": 11,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) / Acceptance detection benchmark (known truth fixtures)",
    "passed": false,
    "detail": {
      "number": 12,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) / Spec API benchmark (OpenAPI candidates and known truth)",
    "passed": false,
    "detail": {
      "number": 13,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) / Acceptance comparison benchmark (known retest and false-closure cases)",
    "passed": false,
    "detail": {
      "number": 14,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (e2e smoke, local fixture) / Post Run actions/setup-node@v7",
    "passed": false,
    "detail": {
      "number": 28,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "capture",
    "name": "unique step log core (e2e smoke, local fixture) / Verify manual defect ticket decision evidence",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (e2e smoke, local fixture) / Run pnpm smoke",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (e2e smoke, local fixture) / Acceptance detection benchmark (known truth fixtures)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (e2e smoke, local fixture) / Spec API benchmark (OpenAPI candidates and known truth)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (e2e smoke, local fixture) / Acceptance comparison benchmark (known retest and false-closure cases)",
    "passed": false,
    "detail": []
  }
]
```
