# D5 精确提交 CI 独立核验

- Run: `39072135745` / attempt `1` / head `a0f834ebe727d6d00e2d692a008d3d0512a56536`
- API结论: `completed` / `cancelled`
- 原件完整: `False`；身份匹配: `True`；执行验收: `False`
- 核验项: 312；失败: 12

原件与派生解析分开保存，所有数字均来自本次精确提交日志。

|Job|状态|结论|
|---|---|---|
|core (lint + test)|completed|cancelled|
|core (e2e smoke, local fixture)|completed|success|
|console (build)|completed|success|

主Core测试统计：

```json
{
  "path": "core (lint + test)/11_Run pnpm test.txt",
  "stats": {
    "tests": 2661,
    "suites": 0,
    "pass": 2657,
    "fail": 0,
    "cancelled": 0,
    "skipped": 4,
    "todo": 0,
    "duration_ms": 2047064.490832
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
        "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/browser-execution-console-smoke-209e9c19-c04e-4476-b400-edf6de926bab"
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
        "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/browser-resolution-console-smoke-255370d1-bc21-4ced-b638-0b3d501f8b12"
      }
    ]
  },
  {
    "command": "pnpm acceptance:defect:tickets:smoke",
    "name": "Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation)",
    "path": "core (lint + test)/31_Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation).txt",
    "apiConclusion": "cancelled",
    "events": []
  }
]
```

D5核验：10个true key、4张截图、0个page error、3条受控HTTP控制台错误；不声称控制台零错误。

```json
{
  "path": "core (lint + test)/31_Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation).txt",
  "summary": {},
  "consoleExpectation": "Three explicitly controlled HTTP errors; zero page errors does not mean zero console errors."
}
```

Docker统计：

```json
{}
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
- `pnpm acceptance:defect:tickets:smoke`：`cancelled`；`core (lint + test)/31_Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation).txt`

未通过核验项：

```json
[
  {
    "category": "execution",
    "name": "run completed successfully",
    "passed": false,
    "detail": {
      "status": "completed",
      "conclusion": "cancelled"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) completed successfully",
    "passed": false,
    "detail": null
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation)",
    "passed": false,
    "detail": {
      "number": 31,
      "status": "completed",
      "conclusion": "cancelled"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Docker offline delivery (SSR + SPA + data SPA + adapter)",
    "passed": false,
    "detail": {
      "number": 33,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Post Run actions/setup-node@v7",
    "passed": false,
    "detail": {
      "number": 64,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Docker offline delivery (SSR + SPA + data SPA + adapter)",
    "passed": false,
    "detail": []
  },
  {
    "category": "execution",
    "name": "D5 unique terminal summary event",
    "passed": false,
    "detail": []
  },
  {
    "category": "execution",
    "name": "D5 passed with exact ten true keys",
    "passed": false,
    "detail": {}
  },
  {
    "category": "execution",
    "name": "D5 exact four desktop/mobile captures",
    "passed": false,
    "detail": null
  },
  {
    "category": "execution",
    "name": "D5 zero page errors",
    "passed": false,
    "detail": null
  },
  {
    "category": "execution",
    "name": "D5 three explicitly controlled HTTP console errors",
    "passed": false,
    "detail": {
      "consoleMessageCount": null,
      "controlledReplyCount": null
    }
  },
  {
    "category": "execution",
    "name": "Docker stats available",
    "passed": false,
    "detail": null
  }
]
```
